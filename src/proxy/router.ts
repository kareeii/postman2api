import type { ChatCompletionRequest, ProviderResult } from "../provider/base";
import { PostmanProvider } from "../provider/postman";
import { pool } from "./pool";
import type { Account } from "../db/schema";

const provider = new PostmanProvider();

export interface RouteResult {
  result: ProviderResult;
  account: Account;
  durationMs: number;
}

function isClientDisconnect(error: string): boolean {
  return error.includes("Client disconnected") || error.includes("aborted");
}

function isTransientError(error: string): boolean {
  const lower = error.toLowerCase();
  return lower.includes("timeout") || lower.includes("econnreset") || lower.includes("fetch failed") || lower.includes("network");
}

function jitteredDelay(attempt: number, isRateLimit: boolean = false): Promise<void> {
  const base = isRateLimit ? 1000 * Math.pow(2, attempt) : 100 * Math.pow(2, attempt);
  const jitter = Math.random() * base * 0.5;
  return new Promise((resolve) => setTimeout(resolve, base + jitter));
}

export async function routeRequest(
  request: ChatCompletionRequest,
  stream: boolean,
): Promise<RouteResult> {
  const maxRetries = 3;
  let lastError = "";
  const excludedAccountIds = new Set<number>();

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      const isRateLimit = lastError.toLowerCase().includes("rate limit") || lastError.includes("429");
      await jitteredDelay(attempt, isRateLimit);
    }

    const account = await pool.getNextAccount();
    if (!account) {
      throw new Error("No active accounts available. Add a Postman account first.");
    }

    if (excludedAccountIds.has(account.id)) {
      lastError = "All available accounts exhausted";
      continue;
    }

    const startTime = Date.now();
    let tracked = false;

    try {
      pool.trackRequestStart(account.id);
      tracked = true;

      const result = stream
        ? await provider.chatCompletionStream(account, request)
        : await provider.chatCompletion(account, request);

      const durationMs = Date.now() - startTime;

      if (result.success) {
        if (result.tokens) await pool.updateTokens(account.id, result.tokens);
        await pool.markUsed(account.id);
        return { result, account, durationMs };
      }

      pool.trackRequestEnd(account.id);
      tracked = false;

      if (isClientDisconnect(result.error || "")) {
        throw new Error("Client disconnected");
      }

      if (result.rateLimited) {
        lastError = result.error || "Rate limited";
        continue;
      }

      if (result.quotaExhausted) {
        await pool.markExhausted(account.id);
        excludedAccountIds.add(account.id);
        lastError = result.error || "Quota exhausted";
        continue;
      }

      if (
        result.error?.includes("expired") ||
        result.error?.includes("401") ||
        result.error?.includes("402") ||
        result.error?.includes("403")
      ) {
        await pool.markTransientFailure(account.id, result.error || "Auth failed");
        lastError = result.error || "Auth failed";
        continue;
      }

      if (isTransientError(result.error || "")) {
        await pool.markTransientFailure(account.id, result.error || "Transient error");
      } else {
        await pool.markError(account.id, result.error || "Unknown error");
      }
      lastError = result.error || "Unknown error";
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      if (tracked) {
        pool.trackRequestEnd(account.id);
        tracked = false;
      }
      if (isClientDisconnect(errMsg)) throw error;
      lastError = errMsg;
    }
  }

  throw new Error(`All accounts failed. Last error: ${lastError}`);
}

export { provider };
