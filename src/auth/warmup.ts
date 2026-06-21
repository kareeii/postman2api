import { db } from "../db/index";
import { accounts } from "../db/schema";
import { eq } from "drizzle-orm";
import { PostmanProvider } from "../provider/postman";

const provider = new PostmanProvider();
const WARMUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
let warmupTimer: ReturnType<typeof setInterval> | null = null;

export async function warmupAccount(accountId: number): Promise<{ success: boolean; error?: string }> {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  if (!account) return { success: false, error: "Account not found" };

  const health = await provider.healthCheck(account);
  if (!health.success) {
    await db.update(accounts)
      .set({ status: "error", errorMessage: health.error, updatedAt: new Date() })
      .where(eq(accounts.id, accountId));
    return { success: false, error: health.error };
  }

  await db.update(accounts)
    .set({
      status: "active",
      errorMessage: null,
      quotaLimit: health.quota?.limit ?? 0,
      quotaRemaining: health.quota?.remaining ?? 0,
      updatedAt: new Date(),
    })
    .where(eq(accounts.id, accountId));

  return { success: true };
}

export async function warmupAllAccounts(): Promise<void> {
  const allAccounts = await db.select().from(accounts);
  for (const account of allAccounts) {
    if (!account.enabled) continue;
    try {
      await warmupAccount(account.id);
    } catch (err) {
      console.error(`[warmup] Account ${account.email} failed:`, err);
    }
  }
}

export function startWarmupScheduler(): void {
  if (warmupTimer) clearInterval(warmupTimer);
  warmupTimer = setInterval(() => {
    warmupAllAccounts().catch((err) => {
      console.error("[warmup] Scheduler error:", err);
    });
  }, WARMUP_INTERVAL_MS);
  console.log(`[warmup] Scheduler started (interval: ${WARMUP_INTERVAL_MS / 1000}s)`);
}

export function stopWarmupScheduler(): void {
  if (warmupTimer) {
    clearInterval(warmupTimer);
    warmupTimer = null;
  }
}
