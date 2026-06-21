import type { ModelInfo } from "./base";

export const POSTMAN_PREFIX = "pm/";

export const POSTMAN_MODEL_MAP: Record<string, string> = {
  "pm/opus-4.8": "CLAUDE_OPUS_48_BEDROCK",
  "pm/opus-4.7": "CLAUDE_OPUS_47_BEDROCK",
  "pm/opus-4.6": "CLAUDE_OPUS_46_BEDROCK",
  "pm/opus-4.5": "CLAUDE_OPUS_45_BEDROCK",
  "pm/sonnet-4.6": "CLAUDE_46_SONNET_BEDROCK",
  "pm/sonnet-4.5": "CLAUDE_45_SONNET_BEDROCK",
  "pm/haiku-4.5": "CLAUDE_45_HAIKU_BEDROCK",
  "pm/gpt-5.5": "GPT_55",
  "pm/gpt-5.4": "GPT_54",
  "pm/gpt-5.2": "GPT_52",
  "pm/auto": "",
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
  pm("pm/opus-4.8", 200000, 64000, true),
  pm("pm/opus-4.7", 200000, 64000, true),
  pm("pm/opus-4.6", 200000, 64000, true),
  pm("pm/opus-4.5", 200000, 64000, true),
  pm("pm/sonnet-4.6", 200000, 64000, true),
  pm("pm/sonnet-4.5", 200000, 64000, true),
  pm("pm/haiku-4.5", 200000, 64000),
  pm("pm/gpt-5.5", 128000, 32000),
  pm("pm/gpt-5.4", 128000, 32000),
  pm("pm/gpt-5.2", 128000, 32000),
  pm("pm/auto", 200000, 64000),
];
