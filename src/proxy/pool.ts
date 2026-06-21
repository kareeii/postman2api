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

    const nextIdx = (this.state.lastIndex + 1) % allActive.length;
    this.state.lastIndex = nextIdx;
    return allActive[nextIdx] || null;
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
