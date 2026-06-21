const API_BASE = "";

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers || {}),
    },
  });
  if (!res.ok) {
    const body: any = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface Account {
  id: number;
  email: string;
  status: string;
  enabled: boolean;
  quotaLimit?: number | null;
  quotaRemaining?: number | null;
  lastUsedAt?: string | null;
  lastLoginAt?: string | null;
  errorMessage?: string | null;
  hasTokens: boolean;
  workspaceSubdomain?: string | null;
  createdAt?: string;
}

export interface Stats {
  totalRequests: number;
  successRequests: number;
  errorRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalAccounts: number;
  activeAccounts: number;
  recentRequests: any[];
}

export async function fetchAccounts(): Promise<{ data: Account[] }> {
  return api("/api/accounts");
}

export async function loginAccount(email: string, password: string, headless: boolean): Promise<{ success: boolean }> {
  return api("/api/accounts/login", {
    method: "POST",
    body: JSON.stringify({ email, password, headless }),
  });
}

export async function addAccountManual(email: string, tokens: any): Promise<{ success: boolean }> {
  return api("/api/accounts", {
    method: "POST",
    body: JSON.stringify({ email, tokens }),
  });
}

export async function deleteAccount(id: number): Promise<{ success: boolean }> {
  return api(`/api/accounts/${id}`, { method: "DELETE" });
}

export async function warmupAccount(id: number): Promise<{ success: boolean; error?: string }> {
  return api(`/api/accounts/${id}/warmup`, { method: "POST" });
}

export async function toggleAccount(id: number, enabled: boolean): Promise<{ success: boolean }> {
  return api(`/api/accounts/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  });
}

export async function fetchStats(): Promise<{ data: Stats }> {
  return api("/api/stats");
}

export async function fetchSettings(): Promise<{ data: Record<string, string> }> {
  return api("/api/settings");
}

export async function updateSettings(settings: Record<string, string>): Promise<{ success: boolean }> {
  return api("/api/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}
