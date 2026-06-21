import { Hono } from "hono";
import { config } from "./config";
import { chatRouter } from "./api/chat";
import { modelsRouter } from "./api/models";
import { accountsRouter } from "./api/accounts";
import { statsRouter } from "./api/stats";
import { settingsRouter } from "./api/settings";
import { addClient, removeClient } from "./ws";
import { startWarmupScheduler, stopWarmupScheduler } from "./auth/warmup";
import { db } from "./db/index";
import { settings } from "./db/schema";
import { eq } from "drizzle-orm";
import { isDefaultEncryptionKey } from "./utils/crypto";

const app = new Hono();

// Health check
app.get("/health", (c) => c.json({ status: "ok", uptime: process.uptime() }));

// API key auth middleware for /v1/* routes (API consumers)
app.use("/v1/*", async (c, next) => {
  const auth = c.req.header("Authorization") || "";
  const apiKey = await getApiKey();
  if (auth !== `Bearer ${apiKey}`) {
    return c.json({ error: { message: "Invalid API key", type: "invalid_api_key" } }, 401);
  }
  await next();
});

// Routes
app.route("/", chatRouter);
app.route("/", modelsRouter);
app.route("/api/accounts", accountsRouter);
app.route("/api/stats", statsRouter);
app.route("/api/settings", settingsRouter);

// Serve dashboard static files
app.get("*", async (c) => {
  const path = c.req.path;
  if (path === "/" || path === "/index.html") {
    const file = Bun.file("dashboard/dist/index.html");
    if (await file.exists()) return new Response(file);
    return c.text("Dashboard not built. Run: cd dashboard && bun install && bun run build", 404);
  }
  const file = Bun.file(`dashboard/dist${path}`);
  if (await file.exists()) return new Response(file);
  // SPA fallback
  const index = Bun.file("dashboard/dist/index.html");
  if (await index.exists()) return new Response(index);
  return c.text("Not found", 404);
});

async function getApiKey(): Promise<string> {
  const [row] = await db.select().from(settings).where(eq(settings.key, "api_key")).limit(1);
  return row?.value || config.apiKey;
}

// Start server
const server = Bun.serve({
  port: config.port,
  fetch: app.fetch,
  websocket: {
    open(ws) {
      addClient(ws);
    },
    message(ws, message) {
      // Ignore client messages — server-push only
    },
    close(ws) {
      removeClient(ws);
    },
  },
});

// Start warmup scheduler
startWarmupScheduler();

if (isDefaultEncryptionKey()) {
  console.warn("[postman2api] WARNING: Using default encryption key. Set ENCRYPTION_KEY in .env!");
}

console.log(`[postman2api] Server running on http://localhost:${config.port}`);
console.log(`[postman2api] OpenAI:  http://localhost:${config.port}/v1/chat/completions`);
console.log(`[postman2api] Anthropic: http://localhost:${config.port}/v1/messages`);
console.log(`[postman2api] Dashboard: http://localhost:${config.port}/`);
console.log(`[postman2api] WebSocket: ws://localhost:${config.port}`);

process.on("SIGTERM", () => {
  stopWarmupScheduler();
  server.stop();
});

export { app, server };
