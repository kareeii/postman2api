import { Hono } from "hono";
import { db } from "../db/index";
import { settings } from "../db/schema";
import { eq } from "drizzle-orm";

export const settingsRouter = new Hono();

settingsRouter.get("/", async (c) => {
  const rows = await db.select().from(settings);
  const result: Record<string, string> = {};
  for (const row of rows) {
    if (row.key && row.value) result[row.key] = row.value;
  }
  return c.json({ data: result });
});

settingsRouter.put("/", async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, string>;
  for (const [key, value] of Object.entries(body)) {
    await db.update(settings).set({ value, updatedAt: new Date() }).where(eq(settings.key, key));
    // Insert if not exists
    await db.insert(settings).values({ key, value, updatedAt: new Date() }).onConflictDoNothing();
  }
  return c.json({ success: true });
});
