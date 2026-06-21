export interface PostmanDelta {
  content?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: "function";
    function?: { name?: string; arguments?: string };
  }>;
  finish_reason?: string | null;
}

export interface PostmanUsage {
  limit: number;
  usage: number;
  overage: number;
  userType: string;
  usageState: string;
}

export class PostmanStreamReader {
  private finished = false;
  private _quotaExceeded = false;
  private _usage: PostmanUsage | null = null;
  private _error: string | null = null;
  private _model: string | null = null;
  private _conversationId: string | null = null;
  private _sawToolCall = false;
  private _toolCallIndex = new Map<string, number>();

  get quotaExceeded(): boolean { return this._quotaExceeded; }
  get usage(): PostmanUsage | null { return this._usage; }
  get error(): string | null { return this._error; }
  get actualModel(): string | null { return this._model; }
  get conversationId(): string | null { return this._conversationId; }

  feed(line: string): PostmanDelta[] {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("data: ")) return [];

    let event: any;
    try {
      event = JSON.parse(trimmed.slice(6));
    } catch {
      return [];
    }

    if (!event || typeof event !== "object") return [];

    switch (event.eventType) {
      case "usage":
        return this.handleUsage(event.data);
      case "conversation":
        return this.handleConversation(event.data);
      case "textChunk":
        return this.handleTextChunk(event.data);
      case "thinkingChunk":
        return this.handleThinkingChunk(event.data);
      case "planningChunk":
      case "progressUpdate":
        return [];
      case "failure":
        return this.handleFailure(event.data);
      case "toolCallChunk":
        return this.handleToolCallChunk(event.data);
      case "info":
      case "ping":
      case "streamingFormat":
      case "thinkingComplete":
        return [];
      default:
        return [];
    }
  }

  finish(): PostmanDelta[] {
    if (this.finished) return [];
    this.finished = true;
    return [{ finish_reason: this._sawToolCall ? "tool_calls" : "stop" }];
  }

  private handleUsage(data: any): PostmanDelta[] {
    if (!data) return [];
    this._usage = {
      limit: data.limit ?? 0,
      usage: data.usage ?? 0,
      overage: data.overage ?? 0,
      userType: data.userType ?? "",
      usageState: data.usageState ?? "",
    };
    if (data.usageState === "EXCEEDED" || data.usageState === "UNAVAILABLE") {
      this._quotaExceeded = true;
    }
    return [];
  }

  private handleConversation(data: any): PostmanDelta[] {
    if (!data) return [];
    if (typeof data.id === "string") {
      this._conversationId = data.id;
    }
    return [];
  }

  private handleTextChunk(data: any): PostmanDelta[] {
    if (!data) return [];
    if (data.metadata?.model) this._model = data.metadata.model;
    const text = data.textContent;
    if (typeof text === "string" && text.length > 0) {
      return [{ content: text }];
    }
    return [];
  }

  private handleThinkingChunk(data: any): PostmanDelta[] {
    if (!data) return [];
    if (data.metadata?.model) this._model = data.metadata.model;
    const text = data.thinkingContent;
    if (typeof text === "string" && text.length > 0) {
      return [{ reasoning_content: text }];
    }
    return [];
  }

  private handleToolCallChunk(data: any): PostmanDelta[] {
    if (!data?.toolCalls || !Array.isArray(data.toolCalls)) return [];
    if (data.metadata?.model) this._model = data.metadata.model;

    const out: PostmanDelta[] = [];
    for (const tc of data.toolCalls) {
      if (!tc.id) continue;
      this._sawToolCall = true;

      let idx = this._toolCallIndex.get(tc.id);
      const isFirst = idx === undefined;
      if (isFirst) {
        idx = this._toolCallIndex.size;
        this._toolCallIndex.set(tc.id, idx);
      }

      out.push({
        tool_calls: [{
          index: idx!,
          ...(isFirst ? { id: tc.id, type: "function" as const } : {}),
          function: {
            ...(isFirst ? { name: tc.function?.name || "" } : {}),
            arguments: tc.function?.arguments || "",
          },
        }],
      });
    }
    return out;
  }

  private handleFailure(data: any): PostmanDelta[] {
    this._error = data?.userMessage || data?.errorType || "Unknown Postman error";
    if (data?.errorType === "USAGE_LIMIT_EXCEEDED") {
      this._quotaExceeded = true;
    }
    return [];
  }
}
