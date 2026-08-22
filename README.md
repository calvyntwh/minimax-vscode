# MiniMax Token Plan (BYOK)

A minimal VS Code extension that adds MiniMax Token Plan models to GitHub Copilot Chat as a BYOK (Bring Your Own Key) language model provider.

A bare-minimum fork of [zelosleone/minimax-vscode](https://github.com/zelosleone/minimax-vscode), audited and rewritten for token plan coverage, clean streaming, and Marketplace publication. Vendored under `calvyntwh`; 0 runtime dependencies.

## Models

All eight Token Plan models, with correct context/output ceilings per platform docs:

| ID | Display | Context | Max Output | Vision | Tools |
|---|---|---|---|---|---|
| `MiniMax-M3` | MiniMax M3 | 1,000,000 | 524,288 | Yes | Yes |
| `MiniMax-M2.7` | MiniMax M2.7 | 204,800 | 204,800 | — | Yes |
| `MiniMax-M2.7-highspeed` | MiniMax M2.7 (High-Speed) | 204,800 | 204,800 | — | Yes |
| `MiniMax-M2.5` | MiniMax M2.5 | 204,800 | 204,800 | — | Yes |
| `MiniMax-M2.5-highspeed` | MiniMax M2.5 (High-Speed) | 204,800 | 204,800 | — | Yes |
| `MiniMax-M2.1` | MiniMax M2.1 | 204,800 | 204,800 | — | Yes |
| `MiniMax-M2.1-highspeed` | MiniMax M2.1 (High-Speed) | 204,800 | 204,800 | — | Yes |
| `MiniMax-M2` | MiniMax M2 | 204,800 | 204,800 | — | Yes |

## Setup

1. Install this extension
2. `Cmd+Shift+P` → `MiniMax: Set API Key` → paste your Token Plan key (https://platform.minimax.io/user-center/payment/token-plan)
3. Open Copilot Chat, click the model picker → `MiniMax` → choose a model

## Commands

- `MiniMax: Set API Key` — store a new Token Plan API key (in macOS Keychain via VS Code SecretStorage)
- `MiniMax: Clear API Key` — wipe the stored key
- `MiniMax: Set Thinking Mode` — `adaptive` / `enabled` / `disabled`

## Settings

- `minimax.apiBaseUrl` — default `https://api.minimax.io/v1`
- `minimax.thinking` — default `adaptive` (M2.x ignores `disabled`)
- `minimax.reasoningSplit` — default `true` (moves thinking into dedicated stream field)
- `minimax.showThinking` — default `true` (renders chain-of-thought; set false to hide)

## Thinking behavior

MiniMax M-series streams thinking inline as `<think>...</think>` tags inside the model's response. This extension:

- Asks the server for `reasoning_split: true` and `thinking: adaptive`
- Concat-accumulates `delta.reasoning_details[].text` (note: the field is incremental, not cumulative)
- Strips `<think>...</think>` markers from `delta.content` via a streaming state machine that survives cross-chunk tag splits

Stable VS Code renders thinking as inline `<think>...</think>` markers. Builds with the proposed `languageModelThinkingPart` API enabled render it as a collapsible block. Set `minimax.showThinking: false` to hide it entirely.

## Privacy

- One outbound network call per chat completion: `POST ${apiBaseUrl}/chat/completions`
- API key stored only in VS Code SecretStorage (Keychain on macOS)
- No telemetry, analytics, auto-update, or background activity
- Default `apiBaseUrl` is `https://api.minimax.io/v1`; changing it sends your Bearer token to whatever host you set

## What this fork removed vs. upstream

- `openai` SDK dep — native `fetch` only
- China-region config / switch commands
- `visibleModels` config (always show all 8)
- Inline thinking-tag regex — replaced with state machine
- Telemetry / request-id logging

## License

MIT (inherited from upstream zelosleone/minimax-vscode, copyright Denizhan Dakılır).
