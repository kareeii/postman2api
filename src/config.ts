import path from "node:path";

const projectRoot = path.resolve(import.meta.dir, "..");

function resolveFromRoot(value: string | undefined, fallback: string): string {
  const raw = value && value.length > 0 ? value : fallback;
  return path.isAbsolute(raw) ? raw : path.resolve(projectRoot, raw);
}

export const config = {
  port: Number(process.env.PORT) || 1930,
  dashboardPort: Number(process.env.DASHBOARD_PORT) || 1931,
  apiKey: process.env.API_KEY || "postman2api-secret-key",
  databasePath: resolveFromRoot(process.env.DATABASE_PATH, "data/postman2api.db"),
  encryptionKey: process.env.ENCRYPTION_KEY || "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
  browserEngine: process.env.BROWSER_ENGINE || "camoufox",
  camoufoxHeadless: process.env.CAMOUFOX_HEADLESS !== "false",
  pythonPath: resolveFromRoot(
    process.env.PYTHON_PATH,
    path.join("scripts/auth/.venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
  ),
  authScriptCwd: resolveFromRoot(process.env.AUTH_SCRIPT_CWD, "scripts/auth"),
  streamReadTimeoutMs: Number(process.env.STREAM_READ_TIMEOUT_MS) || 300_000,
  providerRequestTimeoutMs: Number(process.env.PROVIDER_REQUEST_TIMEOUT_MS) || 120_000,
  ttfbTimeoutMs: Number(process.env.TTFB_TIMEOUT_MS) || 45_000,
} as const;

export type Config = typeof config;
