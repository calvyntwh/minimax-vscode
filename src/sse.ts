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

const STREAM_IDLE_TIMEOUT_MS = 120_000;
const STREAM_MAX_DURATION_MS = 15 * 60_000;

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
        if (state.buf.length > 200_000) {
          // Unclosed think block: route to thinking, not visible, so we
          // don't leak the model's raw chain-of-thought into the answer.
          thinking += state.buf + '\n[truncated]';
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
        const tagPrefix = longestTagPrefixSuffix(state.buf, '<think>');
        visible += state.buf.slice(0, state.buf.length - tagPrefix.length);
        state.buf = tagPrefix;
        return { visible, thinking };
      }
      visible += state.buf.slice(0, open);
      state.buf = state.buf.slice(open + '<think>'.length);
      state.inThink = true;
    }
  }
  return { visible, thinking };
}

function longestTagPrefixSuffix(value: string, tag: string): string {
  const maxLength = Math.min(value.length, tag.length - 1);
  for (let length = maxLength; length > 0; length--) {
    if (value.endsWith(tag.slice(0, length))) return tag.slice(0, length);
  }
  return '';
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
  const deadline = Date.now() + STREAM_MAX_DURATION_MS;

  try {
    while (!signal.aborted) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error('MiniMax stream exceeded the maximum duration');
      }
      const { value, done } = await readWithTimeout(
        reader,
        Math.min(STREAM_IDLE_TIMEOUT_MS, remaining),
        signal,
      );
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
    if (!signal.aborted) {
      cb.onError(err instanceof Error ? err : new Error(String(err)));
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* noop */
    }
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<typeof reader.read>>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void reader.cancel();
          reject(new Error('MiniMax stream timed out waiting for data'));
        }, timeoutMs);
        onAbort = () => {
          void reader.cancel();
          reject(new Error('MiniMax stream cancelled'));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
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

// Sniff the actual image format from the first bytes. Per MiniMax docs,
// M3 supports JPEG / PNG / GIF / WEBP. Returns null when the bytes
// don't match any of those — caller decides what to do (use the host
// mime as fallback, or surface an error).
function detectImageMime(data: Uint8Array): string | null {
  if (data.length >= 8 &&
    data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return 'image/png';
  }
  if (data.length >= 3 &&
    data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (data.length >= 6 &&
    data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) {
    return 'image/gif';
  }
  if (data.length >= 12 &&
    data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
    data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) {
    return 'image/webp';
  }
  return null;
}

// Per platform.minimax.io the supported image formats for M3 are
// JPEG / PNG / GIF / WEBP. Anything outside this set, even if the host
// says it's supported, will be rejected by M3 with HTTP 400.
const SUPPORTED_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

// Pick the best mime for an image. Per VS Code's LanguageModel API, the
// host supplies a mime when constructing the data part, so we trust it
// when (a) the host provided one, and (b) the value is in M3's
// supported set. Otherwise fall back to byte-sniff. If the bytes also
// don't match a known format, return null and the caller surfaces an
// error to the user rather than shipping a labeled-but-bogus payload.
function pickImageMime(
  hostMime: string | undefined,
  data: Uint8Array,
): string | null {
  if (hostMime && SUPPORTED_IMAGE_MIMES.has(hostMime)) {
    return hostMime;
  }
  return detectImageMime(data);
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
    const role = roleToString(msg.role);

    const toolCalls = msg.content.filter(
      (p): p is vscode.LanguageModelToolCallPart =>
        p instanceof vscode.LanguageModelToolCallPart,
    );
    const toolResults = msg.content.filter(
      (p): p is vscode.LanguageModelToolResultPart =>
        p instanceof vscode.LanguageModelToolResultPart,
    );

    if (toolCalls.length) {
      out.push({
        role: 'assistant',
        content: text || null,
        tool_calls: toolCalls.map((part) => ({
          id: part.callId,
          type: 'function',
          function: {
            name: part.name,
            arguments: JSON.stringify(part.input),
          },
        })),
      });
    } else if (hasImage) {
      const parts: Array<Record<string, unknown>> = [];
      for (const part of msg.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
          parts.push({ type: 'text', text: part.value });
        } else if (part instanceof vscode.LanguageModelDataPart) {
          // Honor the host's mime when it names a format M3 supports
          // (per platform.minimax.io). Otherwise sniff the bytes; if the
          // bytes are also unrecognizable, drop the image and surface a
          // note to the user so a silently-missing image part doesn't
          // become a confusing empty response.
          const hostMime = part.mimeType || undefined;
          const mime = pickImageMime(hostMime, part.data);
          if (!mime) {
            parts.push({
              type: 'text',
              text: `[minimax: image skipped — host mime "${hostMime ?? 'none'}" is not in M3's supported set (image/jpeg, image/png, image/gif, image/webp) and the bytes do not match any of those formats]`,
            });
            continue;
          }
          const b64 = Buffer.from(part.data).toString('base64');
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${mime};base64,${b64}` },
          });
        }
      }
      out.push({ role, content: parts });
    } else if (toolResults.length) {
      for (const part of toolResults) {
        const resultText = part.content
          .filter(
            (item): item is vscode.LanguageModelTextPart =>
              item instanceof vscode.LanguageModelTextPart,
          )
          .map((item) => item.value)
          .join('');
        out.push({ role: 'tool', tool_call_id: part.callId, content: resultText });
      }
    } else if (text) {
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
