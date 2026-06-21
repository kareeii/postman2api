import type { ModelInfo } from "./base";

export const POSTMAN_MODEL_MAP: Record<string, string> = {
  "claude-opus-4-8": "CLAUDE_OPUS_48_BEDROCK",
  "claude-opus-4-7": "CLAUDE_OPUS_47_BEDROCK",
  "claude-opus-4-6": "CLAUDE_OPUS_46_BEDROCK",
  "claude-opus-4-5": "CLAUDE_OPUS_45_BEDROCK",
  "claude-sonnet-4-6": "CLAUDE_46_SONNET_BEDROCK",
  "claude-sonnet-4-5": "CLAUDE_45_SONNET_BEDROCK",
  "claude-haiku-4-5": "CLAUDE_45_HAIKU_BEDROCK",
  "gpt-5.5": "GPT_55",
  "gpt-5.4": "GPT_54",
  "gpt-5.2": "GPT_52",
  "auto": "",
};

const DEFAULT_POSTMAN_MODEL = "CLAUDE_OPUS_48_BEDROCK";

export function resolvePostmanModel(model: string): string | null {
  const key = model.toLowerCase();
  if (!(key in POSTMAN_MODEL_MAP)) return null;
  return POSTMAN_MODEL_MAP[key] || DEFAULT_POSTMAN_MODEL;
}

function pm(id: string, ctx: number, maxOut?: number, thinking?: boolean): ModelInfo {
  return {
    id,
    object: "model",
    created: 1700000000,
    owned_by: "postman",
    context_window: ctx,
    max_output: maxOut,
    thinking,
  };
}

export const POSTMAN_MODELS: ModelInfo[] = [
  pm("claude-opus-4-8", 200000, 64000, true),
  pm("claude-opus-4-7", 200000, 64000, true),
  pm("claude-opus-4-6", 200000, 64000, true),
  pm("claude-opus-4-5", 200000, 64000, true),
  pm("claude-sonnet-4-6", 200000, 64000, true),
  pm("claude-sonnet-4-5", 200000, 64000, true),
  pm("claude-haiku-4-5", 200000, 64000),
  pm("gpt-5.5", 128000, 32000),
  pm("gpt-5.4", 128000, 32000),
  pm("gpt-5.2", 128000, 32000),
  pm("auto", 200000, 64000),
];
