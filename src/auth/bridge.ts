import { config } from "../config";
import { db } from "../db/index";
import { accounts } from "../db/schema";
import { encrypt } from "../utils/crypto";
import { broadcast } from "../ws/index";
import { eq } from "drizzle-orm";

export interface PostmanLoginResult {
  postman_sid: string;
  user_id: string;
  workspace_id: string;
  workspace_subdomain: string;
  error?: string;
}

export interface LoginLogEntry {
  step: string;
  msg: string;
  level: string;
  ts: number;
}

export async function loginPostmanAccount(
  email: string,
  password: string,
  headless: boolean,
  onLog?: (log: LoginLogEntry) => void,
): Promise<{ success: boolean; accountId?: number; error?: string }> {
  const scriptPath = config.authScriptCwd + "/postman_login.py";

  try {
    const proc = Bun.spawn({
      cmd: [
        config.pythonPath, scriptPath,
        "--email", email,
        "--password", password,
        ...(headless ? ["--headless"] : []),
      ],
      cwd: config.authScriptCwd,
      env: {
        ...process.env,
        CAMOUFOX_HEADLESS: headless ? "true" : "false",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const stderrLines: string[] = [];
    const stderrReader = (async () => {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          stderrLines.push(line);
          try {
            const logEntry = JSON.parse(line) as LoginLogEntry;
            onLog?.(logEntry);
            broadcast({
              type: "login_log",
              data: { email, ...logEntry },
            });
          } catch {
            broadcast({
              type: "login_log",
              data: { email, step: "raw", msg: line, level: "info", ts: Date.now() / 1000 },
            });
          }
        }
      }
      if (buffer.trim()) {
        try {
          const logEntry = JSON.parse(buffer) as LoginLogEntry;
          onLog?.(logEntry);
          broadcast({
            type: "login_log",
            data: { email, ...logEntry },
          });
        } catch {
          broadcast({
            type: "login_log",
            data: { email, step: "raw", msg: buffer, level: "info", ts: Date.now() / 1000 },
          });
        }
      }
    })();

    const stdout = await new Response(proc.stdout).text();
    await stderrReader;
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const lastErr = stderrLines.length > 0
        ? stderrLines.filter(l => l.includes('"level":"error"')).pop() || stderrLines[stderrLines.length - 1]
        : "";
      let errorMsg = "Login script failed";
      try {
        const parsed = JSON.parse(lastErr);
        errorMsg = parsed.msg || errorMsg;
      } catch {
        errorMsg = lastErr || errorMsg;
      }
      console.error("[auth:bridge] Python script error:", errorMsg);
      return { success: false, error: errorMsg };
    }

    const result: PostmanLoginResult = JSON.parse(stdout.trim());

    if (result.error) {
      return { success: false, error: result.error };
    }

    if (!result.postman_sid || !result.workspace_subdomain) {
      return { success: false, error: "Incomplete tokens from login script" };
    }

    const tokens = {
      postman_sid: result.postman_sid,
      user_id: result.user_id,
      workspace_id: result.workspace_id,
      workspace_subdomain: result.workspace_subdomain,
    };

    const encryptedPassword = encrypt(password);
    const tokensJson = JSON.stringify(tokens);

    const existing = await db.select().from(accounts).where(eq(accounts.email, email)).limit(1);

    let accountId: number;

    if (existing.length > 0) {
      const [updated] = await db.update(accounts)
        .set({
          password: encryptedPassword,
          tokens: tokensJson,
          status: "active",
          lastLoginAt: new Date(),
          updatedAt: new Date(),
          errorMessage: null,
        })
        .where(eq(accounts.id, existing[0]!.id))
        .returning({ id: accounts.id });
      accountId = updated!.id;
    } else {
      const [created] = await db.insert(accounts).values({
        email,
        password: encryptedPassword,
        tokens: tokensJson,
        status: "active",
        lastLoginAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }).returning({ id: accounts.id });
      accountId = created!.id;
    }

    broadcast({ type: "account_added", data: { id: accountId, email, status: "active" } });
    broadcast({ type: "login_done", data: { email, success: true } });

    console.log(`[auth:bridge] Account ${email} logged in successfully (id=${accountId})`);
    return { success: true, accountId };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[auth:bridge] Error:", msg);
    broadcast({ type: "login_done", data: { email, success: false, error: msg } });
    return { success: false, error: msg };
  }
}

export async function validatePostmanSession(accountId: number): Promise<boolean> {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  if (!account?.tokens) return false;

  try {
    const tokens = typeof account.tokens === "string"
      ? JSON.parse(account.tokens)
      : account.tokens;
    return !!(tokens?.postman_sid && tokens?.workspace_subdomain);
  } catch {
    return false;
  }
}
