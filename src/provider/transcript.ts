export interface PostmanTokens {
  postman_sid: string;
  user_id: string;
  workspace_id: string;
  workspace_subdomain: string;
  user_name?: string;
}

export interface PostmanInferenceRequest {
  query: string;
  model: string;
  useWebSearch?: boolean;
  enableTools?: boolean;
  conversationId?: string;
}

export interface PostmanApiProxyRequest {
  service: string;
  method: "get" | "post" | "put" | "delete" | "patch";
  path: string;
  body?: any;
}

export function buildApiProxyRequest(req: PostmanApiProxyRequest): any {
  return {
    service: req.service,
    method: req.method.toUpperCase(),
    path: req.path,
    body: req.body,
  };
}

export function extractTextFromMessage(content: string | any[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const type = part.type;
    if (type === "text" && typeof part.text === "string") {
      parts.push(part.text);
    } else if (type === "tool_result") {
      const toolId = part.tool_use_id || "";
      const resultText = extractToolResultContent(part.content);
      parts.push(`<tool_result id="${toolId}">\n${resultText}\n</tool_result>`);
    } else if (type === "image_url" || type === "image" || type === "input_image") {
      parts.push("[image attachment]");
    } else if (typeof part.text === "string") {
      parts.push(part.text);
    }
  }
  return parts.join("\n");
}

function extractToolResultContent(content: string | any[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

export function isAnthropicToolResult(msg: any): boolean {
  if (!msg || msg.role !== "user") return false;
  const content = msg.content;
  if (!Array.isArray(content)) return false;
  return content.some((block: any) => block?.type === "tool_result");
}
