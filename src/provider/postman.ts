import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ChatMessage,
  type ModelInfo,
  type ProviderHealthResult,
  type ProviderResult,
  type StreamChunk,
} from "./base";
import type { Account } from "../db/schema";
import { POSTMAN_MODEL_MAP, POSTMAN_MODELS, resolvePostmanModel } from "./models";
import { PostmanStreamReader, type PostmanDelta } from "./sse-stream";
import type { PostmanTokens } from "./transcript";
import { extractTextFromMessage, isAnthropicToolResult } from "./transcript";

const DEFAULT_APP_VERSION = "12.15.4-260616-1202";
const CHAT_ENDPOINT = "/_gw/chat";
const REQUEST_TIMEOUT_MS = 300_000;
const TTFB_TIMEOUT_MS = 45_000;
const MAX_QUERY_LEN = 9_500;
const MAX_CONTEXT_LEN = 800_000;

const conversationMap = new Map<string, string>();

const TRANSIENT_ERROR_PATTERNS = [
  "too much data",
  "too large",
  "input too large",
  "context length exceeded",
  "rate limit",
];

interface PostmanMCPTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export class PostmanProvider extends BaseProvider {
  name = "postman" as const;
  override nativeFormat: "openai" | "anthropic" = "openai";
  supportedModels: ModelInfo[] = POSTMAN_MODELS;

  override ownsModel(model: string): boolean {
    return model.toLowerCase() in POSTMAN_MODEL_MAP;
  }

  private resolveModel(model: string): string | null {
    return resolvePostmanModel(model);
  }

  private getTokens(account: Account): PostmanTokens | null {
    try {
      const tokens =
        typeof account.tokens === "string"
          ? JSON.parse(account.tokens)
          : account.tokens;
      if (!tokens || typeof tokens !== "object") return null;
      const { postman_sid, user_id, workspace_id, workspace_subdomain } = tokens;
      if (!postman_sid || !user_id || !workspace_id || !workspace_subdomain) return null;
      return {
        postman_sid: String(postman_sid),
        user_id: String(user_id),
        workspace_id: String(workspace_id),
        workspace_subdomain: String(workspace_subdomain),
        user_name: tokens.user_name ? String(tokens.user_name) : undefined,
      };
    } catch {
      return null;
    }
  }

  private buildHeaders(tokens: PostmanTokens): Record<string, string> {
    const subdomain = tokens.workspace_subdomain;
    return {
      Cookie: `postman.sid=${tokens.postman_sid}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "x-app-version": DEFAULT_APP_VERSION,
      "x-pstmn-req-service": "agent-mode-service",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Origin: `https://${subdomain}.postman.co`,
      Referer: `https://${subdomain}.postman.co/`,
    };
  }

  private buildThirdPartyTools(tools?: any[]): Record<string, { tools: PostmanMCPTool[] }> {
    if (!Array.isArray(tools) || tools.length === 0) return {};
    const mcpTools: PostmanMCPTool[] = [];
    for (const tool of tools) {
      if (tool?.type !== "function" || !tool.function) continue;
      const fn = tool.function;
      mcpTools.push({
        name: fn.name,
        description: fn.description || fn.name,
        parameters: fn.parameters || { type: "object", properties: {} },
      });
    }
    if (mcpTools.length === 0) return {};
    return { "proxy-tools": { tools: mcpTools } };
  }

  private splitMessages(messages: ChatMessage[], accountId: string): {
    query: string;
    seedingMessages: [{ role: "user"; content: string }, { role: "assistant"; content: string }] | null;
  } {
    const lastMsg = messages[messages.length - 1];
    const isToolResultTail = lastMsg?.role === "tool" || isAnthropicToolResult(lastMsg);
    const hasConversationId = conversationMap.has(accountId);

    let query: string;
    let queryMsgIdx: number;

    if (isToolResultTail) {
      const toolResultParts: string[] = [];
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]!;
        if (msg.role === "tool") {
          const text = extractTextFromMessage(msg.content);
          const tcId = msg.tool_call_id || "";
          toolResultParts.unshift(`[Tool Result id=${tcId}]\n${text}`);
          continue;
        }
        if (isAnthropicToolResult(msg)) {
          const content = msg.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block?.type === "tool_result") {
                const toolId = block.tool_use_id || "";
                const resultContent = typeof block.content === "string"
                  ? block.content
                  : Array.isArray(block.content)
                    ? block.content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n")
                    : "";
                toolResultParts.unshift(`[Tool Result id=${toolId}]\n${resultContent}`);
              }
            }
          }
          continue;
        }
        break;
      }
      const resultsBlock = toolResultParts.join("\n\n");

      if (hasConversationId) {
        const truncated = resultsBlock.length > MAX_QUERY_LEN
          ? resultsBlock.slice(0, MAX_QUERY_LEN - 100)
          : resultsBlock;
        query = `${truncated}\n\nProcess these tool results and continue.`;
      } else {
        query = "Continue the conversation.";
      }
      queryMsgIdx = -1;
    } else {
      const idx = findLastIndex(messages, (m) => m.role === "user");
      queryMsgIdx = idx;
      const raw = idx >= 0 ? extractTextFromMessage(messages[idx]!.content) : "";
      query = raw.length > MAX_QUERY_LEN ? raw.slice(-MAX_QUERY_LEN) : raw;
    }

    if (hasConversationId) {
      return { query, seedingMessages: null };
    }

    const contextParts: string[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      if (i === queryMsgIdx) continue;
      const text = extractTextFromMessage(msg.content);

      if (msg.role === "system") {
        if (text) contextParts.push(`[System]\n${text}`);
      } else if (msg.role === "user") {
        if (text) contextParts.push(`[User]\n${text}`);
      } else if (msg.role === "assistant") {
        let block = text ? `[Assistant]\n${text}` : "[Assistant]";
        if (msg.tool_calls?.length) {
          const tcSummary = msg.tool_calls
            .map((tc: any) => {
              const name = tc.function?.name || "unknown";
              const args = tc.function?.arguments || "{}";
              return `Tool call: ${name}(${args}) [id=${tc.id || "unknown"}]`;
            })
            .join("\n");
          block += "\n" + tcSummary;
        }
        contextParts.push(block);
      } else if (msg.role === "tool") {
        const tcId = msg.tool_call_id || "unknown";
        contextParts.push(`Tool result for id=${tcId}:\n${text}`);
      }
    }

    const context = contextParts.join("\n\n");
    if (!context) return { query, seedingMessages: null };

    return {
      query,
      seedingMessages: [
        { role: "user" as const, content: context },
        { role: "assistant" as const, content: "I have the full conversation history above and will continue from where we left off." },
      ],
    };
  }

  private buildRequestBody(
    request: ChatCompletionRequest,
    tokens: PostmanTokens,
    postmanModel: string,
    accountId: string,
  ): any {
    const { query, seedingMessages } = this.splitMessages(request.messages, accountId);
    const thirdParty = this.buildThirdPartyTools(request.tools);
    const hasTools = Object.keys(thirdParty).length > 0;
    const conversationId = conversationMap.get(accountId) || null;

    const input: any = {
      chatType: "USER_QUERY",
      query,
      toolResponse: "",
      useCase: null,
      conversationId,
      agent: null,
      product: "workspace_v12",
      startedFrom: "CHAT_INPUT",
    };

    if (!conversationId && seedingMessages) {
      input.seedingMessages = seedingMessages;
    }

    const body: any = {
      input,
      platform: "WEB",
      clientTools: {
        nativeToolsHash: `clienttools-workspace_v12-browser-${DEFAULT_APP_VERSION}-d5808662718f`,
        excludedTools: [
          "listDatasets", "createDataset", "previewDataset", "queryDatasetView",
          "deleteDataset", "getDatasetSchema", "createDatasetView", "deleteDatasetView",
          "runQuery", "insertDatasetRows", "modifyDatasetView", "refreshDatasource",
          "addDatasetSource", "editDatasetSource", "removeDatasetSource",
          "testDatasourceConnection", "listCloudMocks", "getCloudMock",
          "getCloudMockLogs", "renameCloudMock", "deleteCloudMock",
          "checkMockSlugAvailability", "createCloudMock", "listWorkspaceDocs",
          "getWorkspaceDoc", "createWorkspaceDoc", "updateWorkspaceDoc",
          "deleteWorkspaceDoc", "askUser",
        ],
        thirdParty,
      },
      clientKBTerms: {
        nativeTermsHash: `kbterms-workspace_v12-browser-${DEFAULT_APP_VERSION}-4755650f241c`,
        excludedKBTerms: ["DATASETS"],
      },
      mandatoryContext: {
        workspaceId: tokens.workspace_id,
      },
      selectedContext: [],
      backgroundContext: [],
      availableSkills: [],
      devModeOptions: {
        selectedModel: postmanModel,
        isParallelToolCallingSupported: true,
        autoRun: hasTools,
        supportsAskUser: false,
        supportsActionRecommendations: true,
        useThinkingModeIfAvailable: true,
        thinkingLevel: "medium",
      },
    };

    return body;
  }

  async chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const postmanModel = this.resolveModel(request.model);
    if (postmanModel === null) return { success: false, error: `Invalid model: ${request.model}` };

    const tokens = this.getTokens(account);
    if (!tokens) return { success: false, error: "Invalid or missing Postman tokens" };

    const completionId = this.generateId();
    const body = this.buildRequestBody(request, tokens, postmanModel, String(account.id));

    try {
      const response = await this.fetchWithTimeout(
        `https://${tokens.workspace_subdomain}.postman.co${CHAT_ENDPOINT}`,
        { method: "POST", headers: this.buildHeaders(tokens), body: JSON.stringify(body) },
        REQUEST_TIMEOUT_MS, TTFB_TIMEOUT_MS, request.signal,
      );

      const statusResult = this.checkResponseStatus(response);
      if (statusResult) return statusResult;

      const responseText = await response.text();
      const reader = new PostmanStreamReader();
      const deltas: PostmanDelta[] = [];

      for (const line of responseText.split("\n")) {
        if (!line.trim()) continue;
        deltas.push(...reader.feed(line));
      }

      if (reader.quotaExceeded) return { success: false, error: "Postman AI quota exceeded", rateLimited: true };
      if (reader.error) return { success: false, error: reader.error };

      deltas.push(...reader.finish());

      let content = "";
      let reasoningContent = "";
      const toolCallAccum = new Map<string, { id: string; name: string; args: string }>();

      for (const delta of deltas) {
        if (delta.content) content += delta.content;
        if (delta.reasoning_content) reasoningContent += delta.reasoning_content;
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const key = String(tc.index);
            if (tc.id && !toolCallAccum.has(key)) toolCallAccum.set(key, { id: tc.id, name: "", args: "" });
            const entry = toolCallAccum.get(key);
            if (entry) {
              if (tc.function?.name) entry.name = tc.function.name;
              if (tc.function?.arguments) entry.args += tc.function.arguments;
            }
          }
        }
      }

      const toolCalls = Array.from(toolCallAccum.values()).map((tc) => ({
        id: tc.id, type: "function" as const, function: { name: tc.name, arguments: tc.args },
      }));

      const message: any = { role: "assistant", content: content || null };
      if (reasoningContent) message.reasoning_content = reasoningContent;
      if (toolCalls.length > 0) message.tool_calls = toolCalls;

      const completionResponse: ChatCompletionResponse = {
        id: completionId, object: "chat.completion", created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [{ index: 0, message, finish_reason: toolCalls.length > 0 ? "tool_calls" : content ? "stop" : null }],
        usage: {
          prompt_tokens: this.estimateMessagesTokens(request.messages),
          completion_tokens: this.estimateTokens(content + reasoningContent),
          total_tokens: this.estimateMessagesTokens(request.messages) + this.estimateTokens(content + reasoningContent),
        },
      };

      return { success: true, response: completionResponse, promptTokens: completionResponse.usage.prompt_tokens, completionTokens: completionResponse.usage.completion_tokens, tokensUsed: completionResponse.usage.total_tokens, creditSource: "fixed", creditsUsed: 0 };
    } catch (error) {
      return { success: false, error: `Postman request failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async chatCompletionStream(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const postmanModel = this.resolveModel(request.model);
    if (postmanModel === null) return { success: false, error: `Invalid model: ${request.model}` };

    const tokens = this.getTokens(account);
    if (!tokens) return { success: false, error: "Invalid or missing Postman tokens" };

    const body = this.buildRequestBody(request, tokens, postmanModel, String(account.id));

    try {
      const response = await this.fetchWithTimeout(
        `https://${tokens.workspace_subdomain}.postman.co${CHAT_ENDPOINT}`,
        { method: "POST", headers: this.buildHeaders(tokens), body: JSON.stringify(body) },
        REQUEST_TIMEOUT_MS, TTFB_TIMEOUT_MS, request.signal,
      );

      const statusResult = this.checkResponseStatus(response);
      if (statusResult) return statusResult;
      if (!response.body) return { success: false, error: "Postman returned no response body" };

      const completionId = this.generateId();
      const pmReader = new PostmanStreamReader();
      const upstreamReader = response.body.getReader();
      const decoder = new TextDecoder();
      let ndjsonBuffer = "";

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder();
          const emit = (delta: PostmanDelta) => {
            controller.enqueue(encoder.encode(buildSSEChunk(delta, completionId, request.model)));
          };
          try {
            while (true) {
              const { done, value } = await upstreamReader.read();
              if (done) {
                ndjsonBuffer += decoder.decode(new Uint8Array(0), { stream: false });
                for (const line of ndjsonBuffer.split("\n")) {
                  if (!line.trim()) continue;
                  for (const delta of pmReader.feed(line)) emit(delta);
                }
                if (pmReader.quotaExceeded) emit({ content: "[Error: Postman AI quota exceeded]" });
                if (pmReader.conversationId) conversationMap.set(String(account.id), pmReader.conversationId);
                for (const delta of pmReader.finish()) emit(delta);
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
                break;
              }
              ndjsonBuffer += decoder.decode(value, { stream: true });
              const lines = ndjsonBuffer.split("\n");
              ndjsonBuffer = lines.pop() || "";
              for (const line of lines) {
                if (!line.trim()) continue;
                for (const delta of pmReader.feed(line)) emit(delta);
              }
              if (pmReader.quotaExceeded) {
                emit({ content: "[Error: Postman AI quota exceeded]" });
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
                break;
              }
            }
          } catch (error) {
            controller.error(error);
          }
        },
        cancel() { upstreamReader.cancel(); },
      });

      return { success: true, stream };
    } catch (error) {
      return { success: false, error: `Postman stream failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private checkResponseStatus(response: Response): ProviderResult | null {
    if (response.status === 401 || response.status === 403) return { success: false, error: `Postman auth failed (${response.status})` };
    if (response.status === 429) return { success: false, error: "Postman rate limited", rateLimited: true };
    if (response.status >= 500) return { success: false, error: `Postman server error (${response.status})` };
    if (!response.ok) return { success: false, error: `Postman API error (${response.status})` };
    return null;
  }

  async refreshToken(_account: Account): Promise<{ success: boolean; tokens?: string; error?: string }> {
    return { success: false, error: "Postman sessions require manual re-login via Google OAuth." };
  }

  async validateAccount(account: Account): Promise<boolean> {
    return this.getTokens(account) !== null;
  }

  async fetchQuota(account: Account): Promise<{ success: boolean; quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null }; error?: string }> {
    const tokens = this.getTokens(account);
    if (!tokens) return { success: false, error: "Missing tokens" };

    try {
      const body = JSON.stringify({
        service: "usage",
        method: "get",
        path: `/teams/${tokens.workspace_id}/operations/ai_millicredits/usage`,
      });

      const response = await fetch(
        `https://${tokens.workspace_subdomain}.postman.co/_api/ws/proxy`,
        {
          method: "POST",
          headers: { ...this.buildHeaders(tokens), "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(15000),
        },
      );

      if (!response.ok) return { success: false, error: `Quota API error: ${response.status}` };

      const data = (await response.json()) as any;
      const teamBlock = data?.data?.find((b: any) => b.entity_type === "team");
      const entity = teamBlock?.entities?.[0];
      if (!entity) return { success: false, error: "No team quota entity found" };

      const limit = Number(entity.limit) || 0;
      const usage = Number(entity.usage) || 0;
      const remaining = Math.max(0, limit - usage);

      return { success: true, quota: { limit, remaining, used: usage } };
    } catch (error) {
      return { success: false, error: `Quota fetch failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  override async healthCheck(account: Account): Promise<ProviderHealthResult> {
    const valid = await this.validateAccount(account);
    if (!valid) return { kind: "missing_tokens", success: false, error: "Postman token blob incomplete or invalid" };

    const quotaResult = await this.fetchQuota(account);
    if (!quotaResult.success || !quotaResult.quota) {
      return { kind: "healthy", success: true, quota: { limit: 800000, remaining: 800000, used: 0, source: "postman.dynamic" } };
    }

    const q = quotaResult.quota;
    return {
      kind: q.remaining <= 0 ? "exhausted" : "healthy",
      success: true,
      quota: { ...q, source: "postman.dynamic" } as any,
    };
  }
}

function buildSSEChunk(delta: PostmanDelta, completionId: string, model: string): string {
  const chunk: StreamChunk = {
    id: completionId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta: delta as any, finish_reason: delta.finish_reason ?? null }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function findLastIndex<T>(arr: T[], predicate: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i]!)) return i;
  }
  return -1;
}
