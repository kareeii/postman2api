import { Hono } from "hono";
import { handleChatCompletion } from "../proxy/index";
import {
  anthropicToOpenAI,
  openAIStreamToAnthropic,
  openAIToAnthropic,
  type AnthropicMessagesRequest,
} from "../proxy/transforms/anthropic";

export const chatRouter = new Hono();

const ANTHROPIC_MODEL_ALIASES: Record<string, string> = {
  "claude-sonnet-4-20250514": "pm/sonnet-4.5",
  "claude-sonnet-4.5": "pm/sonnet-4.5",
  "claude-opus-4-20250514": "pm/opus-4.8",
  "claude-opus-4.8": "pm/opus-4.8",
  "claude-opus-4.5": "pm/opus-4.5",
  "claude-haiku-4.5": "pm/haiku-4.5",
  "claude-3-5-sonnet-20241022": "pm/sonnet-4.5",
  "claude-3-5-sonnet-latest": "pm/sonnet-4.5",
  "claude-3-opus-20240229": "pm/opus-4.5",
  "claude-3-sonnet-20240229": "pm/sonnet-4.5",
  "claude-3-haiku-20240307": "pm/haiku-4.5",
  "gpt-5.5": "pm/gpt-5.5",
  "gpt-5.4": "pm/gpt-5.4",
  "gpt-5.2": "pm/gpt-5.2",
  "gpt-5": "pm/gpt-5.2",
};

chatRouter.post("/v1/chat/completions", async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON body", type: "invalid_request" } }, 400);
  }

  if (!body.model) {
    return c.json({ error: { message: "Missing 'model' field", type: "invalid_request" } }, 400);
  }
  if (!body.messages || !Array.isArray(body.messages)) {
    return c.json({ error: { message: "Missing 'messages' field", type: "invalid_request" } }, 400);
  }

  const signal = c.req.raw.signal;
  const response = await handleChatCompletion(body, signal);

  const headers = new Headers();
  response.headers.forEach((v, k) => headers.set(k, v));
  return new Response(response.body, { status: response.status, headers });
});

chatRouter.post("/v1/messages", async (c) => {
  let body: AnthropicMessagesRequest;
  try {
    body = await c.req.json<AnthropicMessagesRequest>();
  } catch {
    return c.json({ type: "error", error: { type: "invalid_request_error", message: "Invalid JSON body" } }, 400);
  }

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ type: "error", error: { type: "invalid_request_error", message: "messages is required" } }, 400);
  }
  if (!body.model) {
    return c.json({ type: "error", error: { type: "invalid_request_error", message: "model is required" } }, 400);
  }

  const originalModel = body.model;
  body.model = ANTHROPIC_MODEL_ALIASES[body.model] || body.model;
  if (body.model.startsWith("claude-")) body.model = "pm/sonnet-4.5";
  if (body.model.startsWith("gpt-") && !body.model.startsWith("pm/")) body.model = "pm/" + body.model;

  const openAIRequest = anthropicToOpenAI(body);
  openAIRequest._originalModel = originalModel;
  const signal = c.req.raw.signal;

  try {
    const response = await handleChatCompletion(openAIRequest, signal);

    if (body.stream === true) {
      const stream = response.body;
      if (!stream) {
        return c.json({ type: "error", error: { type: "api_error", message: "No stream returned" } }, 500);
      }
      return new Response(openAIStreamToAnthropic(stream, body), {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    const text = await response.text();
    const openAIResponse = JSON.parse(text);

    if (openAIResponse.error) {
      return c.json(
        { type: "error", error: { type: "api_error", message: openAIResponse.error?.message || openAIResponse.error } },
        500 as any,
      );
    }

    const result = openAIToAnthropic(openAIResponse, body);
    result.model = originalModel;
    return c.json(result);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return c.json({ type: "error", error: { type: "api_error", message: errorMessage } }, 500);
  }
});
