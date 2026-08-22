/**
 * OpenAI-compatible SSE stream → VS Code LanguageModelResponsePart emitter.
 *
 * MiniMax M-series stream fields (verified against platform.minimax.io
 * docs and issue trackers):
 *   - delta.content              → onText (may carry inline <think>...</think>
 *                                  when reasoning_split is off OR when the
 *                                  model tokenizes the markers across chunks,
 *                                  issue MiniMax-AI/MiniMax-M3#28)
 *   - delta.reasoning_details[]  → onThinking (only with reasoning_split=true;
 *                                  items: {type:"text", text:incremental,
 *                                  index:N}; concat, do NOT diff — see
 *                                  MiniMax-AI/MiniMax-M2/issues/95)
 *   - delta.tool_calls           → onToolCall (OpenAI shape; accumulate by index)
 *
 * The inline-think tag state machine survives mid-token marker splits.
 * Modelled on langchainjs#9726.
 */

import * as vscode from 'vscode';

export interface StreamCallbacks {
  onText: (text: string) => void;
  onThinking: (text: string) => void;
  onToolCall: (id: string, name: string, argsJson: string) => void;
  onDone: (finishReason: string | null) => void;
  onError: (err: Error) => void;
}

interface ChunkToolCall {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface ChunkChoice {
  index: number;
  delta?: {
    role?: string;
    content?: string | null;
    reasoning_details?: Array<{ type?: string; text?: string; index?: number }>;
    tool_calls?: ChunkToolCall[];
  };
  finish_reason?: string | null;
}

// Cross-chunk inline tag handling. Tags may arrive split across many SSE
// chunks because the model tokenizes <think>/</think> as visible text. We
// route around them by buffering chunks between tags and flushing only the
// non-thinking text into onText. Bounded loop guards against pathological
// streams where the model emits `<think>` without ever closing.
function processText(
  incoming: string,
  state: { buf: string; inThink: boolean },
): { visible: string; thinking: string } {
  state.buf += incoming;
  let visible = '';
  let thinking = '';
  for (let i = 0; i < 8; i++) {
    if (state.inThink) {
      const close = state.buf.indexOf('</think>');
      if (close === -1) {
        // Give up cleanly if the model never closes the think block.
        if (state.buf.length > 200_000) {
          visible += state.buf;
          state.buf = '';
        }
        return { visible, thinking };
      }
      thinking += state.buf.slice(0, close);
      state.buf = state.buf.slice(close + '</think>'.length);
      state.inThink = false;
    } else {
      const open = state.buf.indexOf('<think>');
      if (open === -1) {
        visible += state.buf;
        state.buf = '';
        return { visible, thinking };
      }
      visible += state.buf.slice(0, open);
      state.buf = state.buf.slice(open + '<think>'.length);
      state.inThink = true;
    }
  }
  return { visible, thinking };
}

export async function consumeSseStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  cb: StreamCallbacks,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  const toolCalls = new Map<
    number,
    { id: string; name: string; args: string }
  >();
  const textState = { buf: '', inThink: false };
  let thinkBuf = '';

  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.search(/\r?\n/)) !== -1) {
        const line = buffer.slice(0, sep);
        buffer = buffer.slice(
          sep + (buffer[sep] === '\r' && buffer[sep + 1] === '\n' ? 2 : 1),
        );
        if (!line) continue;
        if (line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          flushPending(textState, thinkBuf, cb);
          cb.onDone('stop');
          return;
        }
        let parsed: { choices?: ChunkChoice[] };
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }
        for (const choice of parsed.choices ?? []) {
          const delta = choice.delta ?? {};

          if (Array.isArray(delta.reasoning_details)) {
            for (const block of delta.reasoning_details) {
              if (block?.type === 'text' && typeof block.text === 'string') {
                thinkBuf += block.text;
              }
            }
          }

          if (typeof delta.content === 'string' && delta.content) {
            const { visible, thinking } = processText(delta.content, textState);
            if (visible) cb.onText(visible);
            if (thinking) thinkBuf += thinking;
          }

          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              let entry = toolCalls.get(tc.index);
              if (!entry) {
                entry = { id: '', name: '', args: '' };
                toolCalls.set(tc.index, entry);
              }
              if (tc.id) entry.id = tc.id;
              if (tc.function?.name) entry.name = tc.function.name;
              if (typeof tc.function?.arguments === 'string') {
                entry.args += tc.function.arguments;
              }
            }
          }

          if (choice.finish_reason) {
            flushPending(textState, thinkBuf, cb);
            thinkBuf = '';
            if (choice.finish_reason === 'tool_calls') {
              for (const entry of toolCalls.values()) {
                if (entry.id && entry.name) {
                  cb.onToolCall(entry.id, entry.name, entry.args);
                }
              }
            }
            cb.onDone(choice.finish_reason);
            return;
          }
        }
      }
    }
    flushPending(textState, thinkBuf, cb);
    cb.onDone('stop');
  } catch (err) {
    cb.onError(err instanceof Error ? err : new Error(String(err)));
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }
}

function flushPending(
  state: { buf: string; inThink: boolean },
  thinkBuf: string,
  cb: StreamCallbacks,
): void {
  if (state.buf && !state.inThink) {
    cb.onText(state.buf);
    state.buf = '';
  }
  if (thinkBuf) {
    cb.onThinking(thinkBuf);
  }
}

function roleToString(role: vscode.LanguageModelChatMessageRole): string {
  return role === vscode.LanguageModelChatMessageRole.Assistant
    ? 'assistant'
    : 'user';
}

export function toApiMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const msg of messages) {
    const text = msg.content
      .filter(
        (p): p is vscode.LanguageModelTextPart =>
          p instanceof vscode.LanguageModelTextPart,
      )
      .map((p) => p.value)
      .join('');
    const hasImage = msg.content.some(
      (p) => p instanceof vscode.LanguageModelDataPart,
    );
    if (!text && !hasImage) continue;
    const role = roleToString(msg.role);
    if (hasImage) {
      const parts: Array<Record<string, unknown>> = [];
      for (const part of msg.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
          parts.push({ type: 'text', text: part.value });
        } else if (part instanceof vscode.LanguageModelDataPart) {
          let mime = 'image/png';
          try {
            mime = vscode.LanguageModelDataPart.image(part.data, mime).mimeType;
          } catch {
            const probe = part as unknown as Record<string, unknown>;
            if (typeof probe['mimeType'] === 'string') {
              const v = probe['mimeType'];
              if (v.length > 0) mime = v;
            }
          }
          const b64 = Buffer.from(part.data).toString('base64');
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${mime};base64,${b64}` },
          });
        }
      }
      out.push({ role, content: parts });
    } else {
      out.push({ role, content: text });
    }
  }
  return out;
}

export function toApiTools(
  tools: readonly vscode.LanguageModelChatTool[],
): Array<Record<string, unknown>> | undefined {
  if (!tools.length) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema ?? { type: 'object', properties: {} },
    },
  }));
}
