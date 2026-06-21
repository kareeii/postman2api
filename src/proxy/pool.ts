import { db } from "../db/index";
import { accounts } from "../db/schema";
import { eq, and, sql } from "drizzle-orm";
import type { Account } from "../db/schema";
import { broadcast } from "../ws/index";

interface PoolState {
  lastIndex: number;
}

class AccountPool {
  private state: PoolState = { lastIndex: -1 };
  private inFlightByAccountId = new Map<number, { count: number; startedAt: number }>();
  private static readonly IN_FLIGHT_STALE_MS = 120_000;

  invalidate(): void {
    // No cache in simplified version — always reads from DB
  }

  async getActiveAccounts(): Promise<Account[]> {
    return db.select().from(accounts).where(
      and(eq(accounts.status, "active"), eq(accounts.enabled, true)),
    );
  }

  async getNextAccount(): Promise<Account | null> {
    const allActive = await this.getActiveAccounts();
    if (allActive.length === 0) return null;

    const startIdx = (this.state.lastIndex + 1) % allActive.length;
    let selected = allActive[startIdx];
    let selectedIdx = startIdx;
    let selectedLoad = selected ? this.getInFlightCount(selected.id) : Number.POSITIVE_INFINITY;

    for (let i = 1; i < allActive.length; i++) {
      const idx = (startIdx + i) % allActive.length;
      const candidate = allActive[idx];
      if (!candidate) continue;
      const load = this.getInFlightCount(candidate.id);
      if (load < selectedLoad) {
        selected = candidate;
        selectedIdx = idx;
        selectedLoad = load;
        if (load === 0) break;
      }
    }

    this.state.lastIndex = selectedIdx;
    return selected || null;
  }

  private getInFlightCount(accountId: number): number {
    const entry = this.inFlightByAccountId.get(accountId);
    if (!entry) return 0;
    if (Date.now() - entry.startedAt > AccountPool.IN_FLIGHT_STALE_MS) {
      this.inFlightByAccountId.delete(accountId);
      return 0;
    }
    return entry.count;
  }

  trackRequestStart(accountId: number): void {
    const entry = this.inFlightByAccountId.get(accountId);
    if (entry) {
      entry.count++;
    } else {
      this.inFlightByAccountId.set(accountId, { count: 1, startedAt: Date.now() });
    }
  }

  trackRequestEnd(accountId: number): void {
    const entry = this.inFlightByAccountId.get(accountId);
    if (!entry) return;
    const next = entry.count - 1;
    if (next > 0) entry.count = next;
    else this.inFlightByAccountId.delete(accountId);
  }

  async markUsed(accountId: number): Promise<void> {
    await db.update(accounts).set({ lastUsedAt: new Date(), updatedAt: new Date() }).where(eq(accounts.id, accountId));
  }

  async markExhausted(accountId: number): Promise<void> {
    await db.update(accounts).set({ status: "exhausted", quotaRemaining: 0, updatedAt: new Date() }).where(eq(accounts.id, accountId));
    broadcast({ type: "account_status", data: { id: accountId, status: "exhausted" } });
  }

  async markError(accountId: number, errorMessage: string): Promise<void> {
    await db.update(accounts).set({ status: "error", errorMessage, updatedAt: new Date() }).where(eq(accounts.id, accountId));
    broadcast({ type: "account_status", data: { id: accountId, status: "error", error: errorMessage } });
  }

  async markTransientFailure(accountId: number, errorMessage: string): Promise<void> {
    await db.update(accounts).set({ status: "active", errorMessage, updatedAt: new Date() }).where(eq(accounts.id, accountId));
    broadcast({ type: "account_status", data: { id: accountId, status: "active", warning: errorMessage } });
  }

  async updateTokens(accountId: number, tokens: unknown): Promise<void> {
    await db.update(accounts).set({ tokens: JSON.stringify(tokens), updatedAt: new Date() }).where(eq(accounts.id, accountId));
  }

  async setEnabled(accountId: number, enabled: boolean): Promise<Account | null> {
    const [account] = await db.update(accounts).set({ enabled, updatedAt: new Date() }).where(eq(accounts.id, accountId)).returning();
    broadcast({ type: "account_status", data: { id: accountId, enabled, status: account?.status } });
    return account;
  }
}

export const pool = new AccountPool();
