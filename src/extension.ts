import * as vscode from 'vscode';
import { MODELS, getModel, type ModelDef } from './models';
import { consumeSseStream, toApiMessages, toApiTools } from './sse';

const SECRET_KEY = 'minimax.apiKey';
const DEFAULT_API_URL = 'https://api.minimax.io/v1';
const CONFIG_SECTION = 'minimax';
const VENDOR_ID = 'calvyntwh.minimax';

type ThinkingMode = 'adaptive' | 'enabled' | 'disabled';

interface Settings {
  apiBaseUrl: string;
  thinking: ThinkingMode;
  reasoningSplit: boolean;
  showThinking: boolean;
}

function loadSettings(): Settings {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const baseUrl = cfg.get<string>('apiBaseUrl') ?? DEFAULT_API_URL;
  const thinkingRaw = cfg.get<string>('thinking') ?? 'adaptive';
  const thinking: ThinkingMode =
    thinkingRaw === 'enabled' || thinkingRaw === 'disabled'
      ? thinkingRaw
      : 'adaptive';
  // Per platform.minimax.io/api-reference/text-openai-api, reasoning_split is
  // an output-format switch. Always send true: the alternative puts thinking
  // tags inline in delta.content (model tokenizes them as visible text).
  const reasoningSplit = cfg.get<boolean>('reasoningSplit') ?? true;
  const showThinking = cfg.get<boolean>('showThinking') ?? true;
  return {
    apiBaseUrl: baseUrl.replace(/\/+$/, ''),
    thinking,
    reasoningSplit,
    showThinking,
  };
}

async function getApiKey(secrets: vscode.SecretStorage): Promise<string | undefined> {
  const k = await secrets.get(SECRET_KEY);
  if (!k) return undefined;
  const trimmed = k.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// Proposed-API probe. LanguageModelThinkingPart is exposed on globalThis
// when VS Code has the languageModelThinkingPart proposal enabled
// (currently Insiders-only). Stable builds fall back to inline <think> markers.
const ThinkingPartCtor = (globalThis as unknown as Record<string, unknown>)[
  'LanguageModelThinkingPart'
] as unknown;

// Per platform docs — MiniMax rejects a wide range of OpenAI-shaped fields
// (presence_penalty, frequency_penalty, logit_bias, n > 1, function_call).
// We only send what's documented to work: max_completion_tokens, temperature,
// top_p, tools. We deliberately don't add presence_penalty, frequency_penalty,
// or logit_bias — they're silently ignored per docs.
function buildBody(
  def: ModelDef,
  apiMessages: Array<Record<string, unknown>>,
  apiTools: Array<Record<string, unknown>> | undefined,
  maxTokens: number,
  temperature: number,
  topP: number,
  s: Settings,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: def.id,
    messages: apiMessages,
    // Per docs: max_completion_tokens is the canonical field for new
    // integrations. MiniMax accepts this on all M-series.
    max_completion_tokens: maxTokens,
    temperature,
    top_p: topP,
    stream: true,
    stream_options: { include_usage: true }, // token usage on final chunk
  };
  if (apiTools) body['tools'] = apiTools;
  // MiniMax-specific switches. Per docs: thinking is a no-op for M2.x;
  // reasoning_split is an OUTPUT-FORMAT switch (does not toggle thinking).
  body['extra_body'] = {
    reasoning_split: s.reasoningSplit,
    thinking: { type: s.thinking },
  };
  return body;
}

export function activate(context: vscode.ExtensionContext): void {
  const secrets = context.secrets;
  let currentSettings = loadSettings();
  const changedEmitter = new vscode.EventEmitter<void>();

  const provider: vscode.LanguageModelChatProvider = {
    onDidChangeLanguageModelChatInformation: changedEmitter.event,

    async provideLanguageModelChatInformation() {
      const key = await getApiKey(secrets);
      return key ? MODELS.map((m) => ({
        id: m.id,
        name: m.name,
        family: 'minimax',
        version: m.id.replace(/^MiniMax-/, '').toLowerCase(),
        maxInputTokens: m.maxInputTokens,
        maxOutputTokens: m.maxOutputTokens,
        capabilities: {
          toolCalling: m.toolCalling,
          imageInput: m.vision,
        },
      })) : [];
    },

    async provideLanguageModelChatResponse(model, messages, options, progress, token) {
      const key = await getApiKey(secrets);
      if (!key) {
        progress.report(
          new vscode.LanguageModelTextPart(
            'MiniMax API key not set. Run the command "MiniMax: Set API Key".',
          ),
        );
        return;
      }
      const def = getModel(model.id);
      if (!def) {
        // Per VS Code docs: throw LanguageModelError.NotFound for unknown
        // models so the host can disable the picker rather than render an
        // opaque error.
        throw vscode.LanguageModelError.NotFound(
          `[minimax] Unknown model: ${model.id}`,
        );
      }

      const apiMessages = toApiMessages(messages);
      const apiTools = toApiTools(options.tools ?? []);

      // Clamp user-supplied modelOptions to the model's documented ceiling.
      const requestedMax = options.modelOptions?.maxTokens;
      const maxTokens =
        typeof requestedMax === 'number' && requestedMax > 0
          ? Math.min(requestedMax, def.maxOutputTokens)
          : Math.min(8192, def.maxOutputTokens);

      const requestedTemp = options.modelOptions?.temperature;
      const temperature =
        typeof requestedTemp === 'number' && requestedTemp > 0 && requestedTemp <= 2
          ? requestedTemp
          : 1.0;

      const requestedTopP = options.modelOptions?.topP;
      const topP =
        typeof requestedTopP === 'number' && requestedTopP > 0 && requestedTopP <= 1
          ? requestedTopP
          : def.defaultTopP;

      const body = buildBody(
        def,
        apiMessages,
        apiTools,
        maxTokens,
        temperature,
        topP,
        currentSettings,
      );

      const url = `${currentSettings.apiBaseUrl}/chat/completions`;
      const ac = new AbortController();
      const sub = token.onCancellationRequested(() => ac.abort());

      let resp: Response;
      try {
        resp = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
      } catch (e) {
        sub.dispose();
        // Per VS Code docs: cancellation is not an error; silently return.
        if (ac.signal.aborted) return;
        // Network failure — surface as text to the chat UI; user sees the
        // error inline rather than the picker failing to register.
        progress.report(
          new vscode.LanguageModelTextPart(
            `[minimax] Network error: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
        return;
      }

      if (!resp.ok || !resp.body) {
        sub.dispose();
        const text = await resp.text().catch(() => resp.statusText || '');
        // 401/403 → key issue; 4xx/5xx → upstream issue. Surface text, the
        // chat host already formats with the model chip / status indicator.
        progress.report(
          new vscode.LanguageModelTextPart(
            `[minimax] HTTP ${resp.status}: ${text.slice(0, 500)}`,
          ),
        );
        return;
      }

      const emitThinking = (text: string): void => {
        if (!text) return;
        if (typeof ThinkingPartCtor === 'function') {
          const Ctor = ThinkingPartCtor as new (
            v: string,
          ) => vscode.LanguageModelResponsePart;
          progress.report(new Ctor(text));
          return;
        }
        // Stable-build fallback: render tags inline. The state machine in
        // sse.ts already stripped the model's raw <think>...</think> from
        // delta.content before this fires, so we only emit EXPLICIT thinking
        // streamed via reasoning_details.
        if (!currentSettings.showThinking) return;
        progress.report(
          new vscode.LanguageModelTextPart(`<think>\n${text}\n</think>\n`),
        );
      };

      try {
        await consumeSseStream(resp.body, ac.signal, {
          onText: (text) => {
            if (text) progress.report(new vscode.LanguageModelTextPart(text));
          },
          onThinking: emitThinking,
          onToolCall: (id, name, argsJson) => {
            let parsed: object;
            try {
              const candidate = JSON.parse(argsJson || '{}');
              if (candidate && typeof candidate === 'object') {
                const objectValue: object = candidate;
                parsed = objectValue;
              } else {
                parsed = { raw: argsJson };
              }
            } catch {
              parsed = { raw: argsJson };
            }
            progress.report(new vscode.LanguageModelToolCallPart(id, name, parsed));
          },
          onDone: () => undefined,
          onError: (err) => {
            progress.report(
              new vscode.LanguageModelTextPart(`[minimax] Stream error: ${err.message}`),
            );
          },
        });
      } finally {
        sub.dispose();
        try {
          resp.body.cancel();
        } catch {
          /* noop */
        }
      }
    },

    async provideTokenCount(_model, text) {
      // 4-char-per-token heuristic. The chat host uses this for quota UI only;
      // per VS Code docs, exact counts require per-model tokenizers which we
      // don't ship. Good enough for display.
      if (typeof text === 'string') return Promise.resolve(Math.ceil(text.length / 4));
      let chars = 0;
      for (const part of text.content) {
        if (part instanceof vscode.LanguageModelTextPart) chars += part.value.length;
        else if (part instanceof vscode.LanguageModelDataPart) chars += part.data.length;
      }
      return Promise.resolve(Math.ceil(chars / 4));
    },
  };

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(VENDOR_ID, provider),
    changedEmitter,
    vscode.commands.registerCommand('minimax.setApiKey', async () => {
      const input = await vscode.window.showInputBox({
        prompt: 'MiniMax Token Plan API key',
        placeHolder: 'Paste API key',
        password: true,
        ignoreFocusOut: true,
        title: 'MiniMax API Key',
        validateInput: (v) =>
          !v || v.trim().length === 0 ? 'API key cannot be empty' : undefined,
      });
      if (input) {
        await secrets.store(SECRET_KEY, input.trim());
        changedEmitter.fire();
        void vscode.window.showInformationMessage('MiniMax API key saved.');
      }
    }),
    vscode.commands.registerCommand('minimax.clearApiKey', async () => {
      await secrets.delete(SECRET_KEY);
      changedEmitter.fire();
      void vscode.window.showInformationMessage('MiniMax API key cleared.');
    }),
    vscode.commands.registerCommand('minimax.setThinkingMode', async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: 'adaptive', description: 'Model decides per call (default)' },
          { label: 'enabled', description: 'Force thinking on every call' },
          { label: 'disabled', description: 'Skip thinking (M3 only; M2.x ignores)' },
        ],
        { placeHolder: 'Select thinking mode', title: 'MiniMax Thinking' },
      );
      if (pick) {
        await vscode.workspace
          .getConfiguration(CONFIG_SECTION)
          .update('thinking', pick.label, vscode.ConfigurationTarget.Global);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration(`${CONFIG_SECTION}.apiBaseUrl`) ||
        e.affectsConfiguration(`${CONFIG_SECTION}.thinking`) ||
        e.affectsConfiguration(`${CONFIG_SECTION}.reasoningSplit`) ||
        e.affectsConfiguration(`${CONFIG_SECTION}.showThinking`)
      ) {
        currentSettings = loadSettings();
        changedEmitter.fire();
      }
    }),
  );
}

export function deactivate(): void {
  /* SecretStorage persists across reloads; nothing to clean up */
}
