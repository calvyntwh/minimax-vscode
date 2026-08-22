/**
 * MiniMax model registry. All Token Plan models in one place.
 *
 * Source: platform.minimax.io/api-reference/api-overview and the chat
 * completions OpenAPI schema. Tokens are *maximum* ceilings (per spec),
 * not recommended values.
 */

export interface ModelDef {
  id: string;
  name: string;
  contextLength: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  vision: boolean;
  toolCalling: boolean;
  /** M3 = 0.95, M2.x = 0.9 */
  defaultTopP: number;
}

const CTX_1M = 1_000_000;
const CTX_204K = 204_800;
// M3 max = 524,288; M2.x max = 204,800
const OUT_M3_MAX = 524_288;
const OUT_M2_MAX = 204_800;

export const MODELS: readonly ModelDef[] = [
  {
    id: 'MiniMax-M3',
    name: 'MiniMax M3',
    contextLength: CTX_1M,
    maxInputTokens: 1_000_000,
    maxOutputTokens: OUT_M3_MAX,
    vision: true,
    toolCalling: true,
    defaultTopP: 0.95,
  },
  {
    id: 'MiniMax-M2.7',
    name: 'MiniMax M2.7',
    contextLength: CTX_204K,
    maxInputTokens: 200_000,
    maxOutputTokens: OUT_M2_MAX,
    vision: false,
    toolCalling: true,
    defaultTopP: 0.9,
  },
  {
    id: 'MiniMax-M2.7-highspeed',
    name: 'MiniMax M2.7 (High-Speed)',
    contextLength: CTX_204K,
    maxInputTokens: 200_000,
    maxOutputTokens: OUT_M2_MAX,
    vision: false,
    toolCalling: true,
    defaultTopP: 0.9,
  },
  {
    id: 'MiniMax-M2.5',
    name: 'MiniMax M2.5',
    contextLength: CTX_204K,
    maxInputTokens: 196_000,
    maxOutputTokens: OUT_M2_MAX,
    vision: false,
    toolCalling: true,
    defaultTopP: 0.9,
  },
  {
    id: 'MiniMax-M2.5-highspeed',
    name: 'MiniMax M2.5 (High-Speed)',
    contextLength: CTX_204K,
    maxInputTokens: 196_000,
    maxOutputTokens: OUT_M2_MAX,
    vision: false,
    toolCalling: true,
    defaultTopP: 0.9,
  },
  {
    id: 'MiniMax-M2.1',
    name: 'MiniMax M2.1',
    contextLength: CTX_204K,
    maxInputTokens: 196_000,
    maxOutputTokens: OUT_M2_MAX,
    vision: false,
    toolCalling: true,
    defaultTopP: 0.9,
  },
  {
    id: 'MiniMax-M2.1-highspeed',
    name: 'MiniMax M2.1 (High-Speed)',
    contextLength: CTX_204K,
    maxInputTokens: 196_000,
    maxOutputTokens: OUT_M2_MAX,
    vision: false,
    toolCalling: true,
    defaultTopP: 0.9,
  },
  {
    id: 'MiniMax-M2',
    name: 'MiniMax M2',
    contextLength: CTX_204K,
    maxInputTokens: 192_000,
    maxOutputTokens: OUT_M2_MAX,
    vision: false,
    toolCalling: true,
    defaultTopP: 0.9,
  },
] as const;

export function getModel(id: string): ModelDef | undefined {
  return MODELS.find((m) => m.id === id);
}
