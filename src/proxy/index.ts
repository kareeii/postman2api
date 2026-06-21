import { db } from "../db/index";
import { requestLogs } from "../db/schema";
import type { NewRequestLog } from "../db/schema";
import type { ChatCompletionRequest, ProviderResult } from "../provider/base";
import { routeRequest } from "./router";
import { pool } from "./pool";
import { broadcast } from "../ws/index";
import { config } from "../config";

export async function handleChatCompletion(
  body: ChatCompletionRequest,
  signal?: AbortSignal,
): Promise<Response> {
  const stream = body.stream ?? false;
  body.signal = signal;

  try {
    const { result, account, durationMs } = await routeRequest(body, stream);

    if (result.success && result.stream) {
      return wrapStream(result.stream, {
        accountId: account.id,
        model: body.model,
        durationMs,
        promptTokens: result.promptTokens || 0,
        completionTokens: result.completionTokens || 0,
        totalTokens: result.tokensUsed || 0,
        signal,
      });
    }

    if (result.success && result.response) {
      await recordRequest({
        accountId: account.id,
        model: body.model,
        promptTokens: result.promptTokens || 0,
        completionTokens: result.completionTokens || 0,
        totalTokens: result.tokensUsed || 0,
        status: "success",
        durationMs,
      });

      return new Response(JSON.stringify(result.response), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Non-success
    await recordRequest({
      accountId: account.id,
      model: body.model,
      status: "error",
      durationMs,
      errorMessage: result.error || "Unknown error",
    });

    return errorResponse(result.error || "Unknown error", 503);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    await recordRequest({
      model: body.model,
      status: "error",
      durationMs: 0,
      errorMessage: errMsg,
    });

    if (errMsg.includes("No active accounts")) {
      return errorResponse(errMsg, 503);
    }

    return errorResponse(errMsg, 500);
  }
}

function wrapStream(
  stream: ReadableStream<Uint8Array>,
  ctx: {
    accountId: number;
    model: string;
    durationMs: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    signal?: AbortSignal;
  },
): Response {
  let logged = false;

  const wrappedStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader();
      const encoder = new TextEncoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        if (!logged) {
          logged = true;
          await recordRequest({
            accountId: ctx.accountId,
            model: ctx.model,
            promptTokens: ctx.promptTokens,
            completionTokens: ctx.completionTokens,
            totalTokens: ctx.totalTokens,
            status: "success",
            durationMs: Date.now() - Date.now() + ctx.durationMs,
          });
        }
        controller.close();
      } catch (err) {
        if (!logged) {
          logged = true;
          await recordRequest({
            accountId: ctx.accountId,
            model: ctx.model,
            status: "error",
            durationMs: 0,
            errorMessage: err instanceof Error ? err.message : String(err),
          });
        }
        controller.error(err);
      }
    },
    cancel() {
      stream.cancel();
    },
  });

  return new Response(wrappedStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

async function recordRequest(entry: NewRequestLog): Promise<void> {
  try {
    await db.insert(requestLogs).values({
      ...entry,
      createdAt: new Date(),
    });
    broadcast({ type: "request_completed", data: { status: entry.status, model: entry.model } });
  } catch (err) {
    console.error("[proxy] Failed to log request:", err);
  }
}

function errorResponse(message: string, status: number): Response {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type: status === 503 ? "no_available_account" : "internal_error",
      },
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

export { pool };
