import type { Account } from "../db/schema";
import { config } from "../config";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | any[];
  tool_calls?: any[];
  tool_call_id?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  tools?: any[];
  tool_choice?: any;
  reasoning_effort?: string;
  thinking?: { type: string; budget_tokens?: number; display?: string; effort?: string; summary?: string };
  signal?: AbortSignal;
  _originalModel?: string;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage & { tool_calls?: any[]; reasoning_content?: string };
  finish_reason: string | null;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface StreamChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: {
    index: number;
    delta: Partial<ChatMessage> & { tool_calls?: any[]; reasoning_content?: string };
    finish_reason: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export type CreditUnit = "token" | "request" | "image" | "credit";
export type CreditSource = "upstream" | "quota_delta" | "estimated" | "fixed";

export interface ModelInfo {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  context_window: number;
  max_output?: number;
  thinking?: boolean;
  vision?: boolean;
  creditRate?: number;
  creditUnit?: CreditUnit;
}

export interface ProviderResult {
  success: boolean;
  response?: ChatCompletionResponse;
  stream?: ReadableStream<Uint8Array>;
  tokensUsed?: number;
  promptTokens?: number;
  completionTokens?: number;
  creditsUsed?: number;
  creditSource?: CreditSource;
  error?: string;
  quotaExhausted?: boolean;
  rateLimited?: boolean;
  tokens?: unknown;
}

export interface ProviderHealthResult {
  kind: "healthy" | "exhausted" | "missing_tokens" | "transient_error" | "unsupported";
  success: boolean;
  retryable?: boolean;
  error?: string;
  quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null; source?: string };
}

export abstract class BaseProvider {
  abstract name: string;
  abstract supportedModels: ModelInfo[];
  nativeFormat: "openai" | "anthropic" = "openai";

  getModelInfo(model: string): ModelInfo | undefined {
    const normalized = model.toLowerCase();
    return this.supportedModels.find((item) => item.id.toLowerCase() === normalized);
  }

  getModels(): ModelInfo[] {
    return this.supportedModels;
  }

  ownsModel(model: string): boolean {
    return this.getModelInfo(model) !== undefined;
  }

  protected generateId(): string {
    return `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  }

  protected createSSEChunk(chunk: StreamChunk): string {
    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  protected createSSEDone(): string {
    return "data: [DONE]\n\n";
  }

  protected estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.max(1, Math.ceil(text.length / 4));
  }

  protected estimateMessagesTokens(messages: ChatMessage[]): number {
    return messages.reduce((total, msg) => {
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "");
      return total + this.estimateTokens(content) + 4;
    }, 0);
  }

  async healthCheck(account: Account): Promise<ProviderHealthResult> {
    const valid = await this.validateAccount(account);
    if (!valid) {
      return { kind: "missing_tokens", success: false, error: "No valid tokens available" };
    }
    return { kind: "healthy", success: true };
  }

  abstract chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult>;
  abstract chatCompletionStream(account: Account, request: ChatCompletionRequest): Promise<ProviderResult>;
  abstract refreshToken(account: Account): Promise<{ success: boolean; tokens?: string; error?: string }>;
  abstract validateAccount(account: Account): Promise<boolean>;
  abstract fetchQuota(account: Account): Promise<{ success: boolean; quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null }; error?: string }>;

  protected async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs = config.providerRequestTimeoutMs,
    ttfbTimeoutMs?: number,
    clientSignal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const totalTimer = setTimeout(() => controller.abort(new Error(`Upstream timeout after ${timeoutMs}ms`)), timeoutMs);
    const ttfbTimer = ttfbTimeoutMs && ttfbTimeoutMs < timeoutMs
      ? setTimeout(() => controller.abort(new Error(`Upstream connect timeout after ${ttfbTimeoutMs}ms`)), ttfbTimeoutMs)
      : null;

    let clientAbortHandler: (() => void) | undefined;
    if (clientSignal && !clientSignal.aborted) {
      clientAbortHandler = () => controller.abort(new Error("Client disconnected"));
      clientSignal.addEventListener("abort", clientAbortHandler, { once: true });
    } else if (clientSignal?.aborted) {
      controller.abort(new Error("Client already disconnected"));
    }

    try {
      const response = await fetch(url, { ...init, signal: controller.signal } as any);
      if (ttfbTimer) clearTimeout(ttfbTimer);
      return response;
    } finally {
      clearTimeout(totalTimer);
      if (ttfbTimer) clearTimeout(ttfbTimer);
      if (clientAbortHandler && clientSignal) {
        clientSignal.removeEventListener("abort", clientAbortHandler);
      }
    }
  }
}
