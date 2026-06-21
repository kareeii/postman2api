import { useState, useEffect, useCallback, useRef } from "react";
import {
  fetchAccounts,
  fetchStats,
  fetchSettings,
  loginAccount,
  deleteAccount,
  warmupAccount,
  toggleAccount,
  updateSettings,
  addAccountManual,
  type Account,
  type Stats,
} from "./lib/api";

type Tab = "accounts" | "stats" | "settings";

interface LoginLogEntry {
  step: string;
  msg: string;
  level: string;
  ts: number;
}

const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  exhausted: "Exhausted",
  error: "Error",
  cooling: "Rate Limited",
};

export default function App() {
  const [tab, setTab] = useState<Tab>("accounts");
  const [toast, setToast] = useState<{ msg: string; type: "success" | "error" | "info" } | null>(null);
  const [loginLogs, setLoginLogs] = useState<LoginLogEntry[] | null>(null);

  const showToast = useCallback((msg: string, type: "success" | "error" | "info" = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const onLoginStart = useCallback(() => setLoginLogs([]), []);
  const onLoginLog = useCallback((entry: LoginLogEntry) => {
    setLoginLogs((prev) => (prev === null ? null : [...prev, entry]));
  }, []);
  const onLoginEnd = useCallback(() => {
    setLoginLogs((prev) => (prev === null ? null : [...prev, { step: "done", msg: "Login process finished", level: "info", ts: Date.now() / 1000 }]));
  }, []);

  return (
    <>
      <Header tab={tab} setTab={setTab} />
      {toast && <Toast msg={toast.msg} type={toast.type} />}
      {loginLogs && <LoginLogPanel logs={loginLogs} onClose={() => setLoginLogs(null)} />}
      <main className="admin-main">
        {tab === "accounts" && (
          <AccountsTab
            showToast={showToast}
            onLoginStart={onLoginStart}
            onLoginLog={onLoginLog}
            onLoginEnd={onLoginEnd}
          />
        )}
        {tab === "stats" && <StatsTab />}
        {tab === "settings" && <SettingsTab showToast={showToast} />}
      </main>
    </>
  );
}

function Header({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  return (
    <header className="admin-header">
      <div className="admin-header-inner">
        <div className="admin-brand-wrap">
          <span className="admin-brand">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
            </svg>
            postman2api
          </span>
        </div>
        <nav className="admin-nav">
          {(["accounts", "stats", "settings"] as Tab[]).map((t) => (
            <button key={t} className={`admin-nav-link ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
              {t === "accounts" ? "Accounts" : t === "stats" ? "Stats" : "Settings"}
            </button>
          ))}
        </nav>
        <div className="admin-header-right">
          <span className="admin-header-version">v1.0</span>
        </div>
      </div>
    </header>
  );
}

function Toast({ msg, type }: { msg: string; type: "success" | "error" | "info" }) {
  const icon =
    type === "success" ? (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    ) : type === "error" ? (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    ) : (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v4" />
        <path d="M12 16h.01" />
      </svg>
    );
  return (
    <div className="toast-container">
      <div className={`toast toast-${type}`}>
        <div className="toast-icon">{icon}</div>
        <div className="toast-content">{msg}</div>
      </div>
    </div>
  );
}

function LoginLogPanel({ logs, onClose }: { logs: LoginLogEntry[]; onClose: () => void }) {
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [logs]);

  return (
    <div className="login-log-overlay">
      <div className="login-log-panel">
        <div className="login-log-header">
          <div className="login-log-title">
            <span className="live-dot">Login Progress</span>
          </div>
          <button className="login-log-close" onClick={onClose} title="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="login-log-body">
          {logs.map((log, i) => (
            <div key={i} className={`login-log-line login-log-${log.level}`}>
              <span className="login-log-time">{new Date(log.ts * 1000).toLocaleTimeString()}</span>
              <span className="login-log-step">[{log.step}]</span>
              <span className="login-log-msg">{log.msg}</span>
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      </div>
    </div>
  );
}

function AccountsTab({
  showToast,
  onLoginStart,
  onLoginLog,
  onLoginEnd,
}: {
  showToast: (msg: string, type?: "success" | "error" | "info") => void;
  onLoginStart: () => void;
  onLoginLog: (entry: LoginLogEntry) => void;
  onLoginEnd: () => void;
}) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [addMode, setAddMode] = useState<"login" | "manual">("login");
  const [filter, setFilter] = useState("all");
  const [confirm, setConfirm] = useState<{ msg: string; action: () => void } | null>(null);
  const [warming, setWarming] = useState<Set<number>>(new Set());
  const wsRef = useRef<WebSocket | null>(null);

  const load = useCallback(
    async (silent?: boolean) => {
      try {
        const res = await fetchAccounts();
        setAccounts(res.data);
      } catch (e: any) {
        if (!silent) showToast("Load failed: " + e.message, "error");
      } finally {
        setLoading(false);
      }
    },
    [showToast],
  );

  useEffect(() => {
    load();
    const ws = new WebSocket(`ws://${location.host}`);
    ws.onmessage = (ev) => {
      const data = JSON.parse(ev.data);
      if (data.type === "login_log") {
        onLoginLog({ step: data.data.step, msg: data.data.msg, level: data.data.level, ts: data.data.ts });
      } else if (data.type === "login_done") {
        if (data.data.success) onLoginEnd();
      } else if (data.type === "login_start" || data.type === "account_added" || data.type === "account_updated" || data.type === "account_deleted") {
        load(true);
      } else {
        load(true);
      }
    };
    wsRef.current = ws;
    const poll = setInterval(() => {
      if (!document.hidden) load(true);
    }, 5000);
    return () => {
      ws.close();
      clearInterval(poll);
    };
  }, [load, onLoginLog, onLoginEnd]);

  const counts: Record<string, number> = { all: accounts.length };
  accounts.forEach((a) => {
    counts[a.status] = (counts[a.status] || 0) + 1;
  });
  const filtered = filter === "all" ? accounts : accounts.filter((a) => a.status === filter);
  const activeCount = accounts.filter((a) => a.status === "active").length;
  const exhaustedCount = accounts.filter((a) => a.status === "exhausted").length;
  const errorCount = accounts.filter((a) => a.status === "error").length;
  const totalQuotaLimit = accounts.reduce((s, a) => s + (a.quotaLimit || 0), 0);
  const totalQuotaRemaining = accounts.reduce((s, a) => s + (a.quotaRemaining || 0), 0);

  const doDelete = async (id: number) => {
    try {
      await deleteAccount(id);
      showToast("Deleted", "success");
      load();
    } catch (e: any) {
      showToast("Delete failed: " + e.message, "error");
    }
  };

  const doWarmup = async (id: number) => {
    if (warming.has(id)) return;
    setWarming((s) => new Set(s).add(id));
    try {
      const res = await warmupAccount(id);
      if (res.success) showToast("Warmup successful", "success");
      else showToast(res.error || "Warmup failed", "error");
    } catch (e: any) {
      showToast("Warmup failed: " + e.message, "error");
    } finally {
      setWarming((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
      load();
    }
  };

  const doToggle = async (id: number, enable: boolean) => {
    try {
      await toggleAccount(id, enable);
      load();
    } catch (e: any) {
      showToast("Toggle failed: " + e.message, "error");
    }
  };

  return (
    <>
      <div className="page-hd">
        <div>
          <div className="page-title">Account Pool</div>
          <div className="page-sub">
            Multi-account polling · Auto-switch on quota exhaustion · Real-time usage monitoring
          </div>
        </div>
        <div className="page-actions">
          <span className="live-dot">Real-time monitoring</span>
          <button className="page-action-btn" onClick={() => { accounts.forEach(a => warmupAccount(a.id)); setTimeout(() => load(), 3000); }}>
            <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none"><path d="M20 11a8 8 0 0 0-14.6-4.6"/><path d="M4 4v5h5"/><path d="M4 13a8 8 0 0 0 14.6 4.6"/><path d="M20 20v-5h-5"/></svg>
            Refresh Quota
          </button>
          <button className="page-action-btn page-action-btn-primary" onClick={() => setShowAdd(true)}>
            <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" fill="none">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Add New
          </button>
        </div>
      </div>

      <div className="section-head">
        <div className="section-title">Account Overview</div>
      </div>
      <div className="stat-grid">
        <div className="stat-cell">
          <div className="stat-top">
            <div className="stat-label">Total Accounts</div>
            <span className="stat-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8">
                <path d="M4 19a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4" />
                <circle cx="12" cy="8" r="4" />
              </svg>
            </span>
          </div>
          <div className="stat-num">{accounts.length}</div>
        </div>
        <div className="stat-cell">
          <div className="stat-top">
            <div className="stat-label">Active</div>
            <span className="stat-icon" style={{ color: "#16a34a" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke-width="1.9">
                <circle cx="12" cy="12" r="8" />
                <path d="m8.5 12 2.4 2.4 4.8-4.8" />
              </svg>
            </span>
          </div>
          <div className="stat-num" style={{ color: "#16a34a" }}>{activeCount}</div>
        </div>
        <div className="stat-cell">
          <div className="stat-top">
            <div className="stat-label">Exhausted</div>
            <span className="stat-icon" style={{ color: "#8d6bbd" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8">
                <path d="M6 19h12" />
                <path d="M12 16V9" />
              </svg>
            </span>
          </div>
          <div className="stat-num" style={{ color: "#8d6bbd" }}>{exhaustedCount}</div>
        </div>
        <div className="stat-cell">
          <div className="stat-top">
            <div className="stat-label">Total Quota (Remaining)</div>
            <span className="stat-icon" style={{ color: "#4c9168" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><path d="M3 6h18"/><path d="M3 12h18"/><path d="M3 18h18"/></svg>
            </span>
          </div>
          <div className="stat-num" style={{ color: "#4c9168" }}>{fmt(totalQuotaRemaining)}</div>
        </div>
        <div className="stat-cell">
          <div className="stat-top">
            <div className="stat-label">Error</div>
            <span className="stat-icon" style={{ color: "#b66a63" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>
            </span>
          </div>
          <div className="stat-num" style={{ color: "#b66a63" }}>{errorCount}</div>
        </div>
      </div>

      <div className="section-head">
        <div className="section-title">
          Account Details <span className="section-count-badge">{filtered.length}</span>
        </div>
      </div>

      <div className="filter-bar">
        {[
          ["all", "All"],
          ["active", "Active"],
          ["exhausted", "Exhausted"],
          ["error", "Error"],
        ].map(([k, l]) => (
          <button key={k} className={`filter-chip ${filter === k ? "active" : ""}`} onClick={() => setFilter(k)}>
            {l}
            <span className="filter-chip-count">{counts[k] || 0}</span>
          </button>
        ))}
      </div>

      <div className="table-card">
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th className="table-center" style={{ width: 80 }}>Status</th>
              <th style={{ minWidth: 200 }}>Quota</th>
              <th style={{ width: 120 }}>Last Used</th>
              <th style={{ width: 120 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} className="empty-state">Loading...</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={5} className="empty-state">No accounts yet. Click "Add New" in the top right to add one.</td></tr>
            ) : (
              filtered.map((a) => {
                const isDisabled = !a.enabled;
                const isWarming = warming.has(a.id);
                return (
                  <tr key={a.id}>
                    <td>
                      <span className="tok">{a.email}</span>
                      {a.errorMessage && (
                        <div style={{ fontSize: 11, color: "#b66a63", marginTop: 2 }}>{a.errorMessage}</div>
                      )}
                    </td>
                    <td className="table-center">
                      <span className={`badge badge-${a.status === "active" ? "active" : a.status}`}>
                        {STATUS_LABEL[a.status] || a.status}
                      </span>
                      {isDisabled && (
                        <span className="badge badge-disabled" style={{ marginLeft: 4 }}>disabled</span>
                      )}
                    </td>
                    <td>{quotaCell(a)}</td>
                    <td style={{ fontSize: 12, color: "#9a9a9a" }}>{fmtDate(a.lastUsedAt)}</td>
                    <td>
                      <div className="row-actions">
                        <button className={`row-icon-btn ${isWarming ? "is-loading" : ""}`} title="Warmup" onClick={() => doWarmup(a.id)}>
                          <svg viewBox="0 0 24 24">
                            <path d="M20 11a8 8 0 0 0-14.6-4.6" />
                            <path d="M4 4v5h5" />
                            <path d="M4 13a8 8 0 0 0 14.6 4.6" />
                            <path d="M20 20v-5h-5" />
                          </svg>
                        </button>
                        <button className="row-icon-btn" title={isDisabled ? "Enable" : "Disable"} onClick={() => doToggle(a.id, isDisabled)}>
                          {isDisabled ? (
                            <svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.708" /><path d="M3 4v5h5" /></svg>
                          ) : (
                            <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" /><path d="M8.5 8.5 15.5 15.5" /></svg>
                          )}
                        </button>
                        <button className="row-icon-btn row-icon-danger" title="Delete"
                          onClick={() => setConfirm({ msg: `Delete account "${a.email}"? This cannot be undone.`, action: () => doDelete(a.id) })}>
                          <svg viewBox="0 0 24 24">
                            <path d="M5 7h14" /><path d="M9 7V4h6v3" /><path d="M8 10v7" />
                            <path d="M12 10v7" /><path d="M16 10v7" /><path d="M7 7l1 13h8l1-13" />
                          </svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {showAdd && (
        <AddAccountModal
          mode={addMode}
          setMode={setAddMode}
          onClose={() => setShowAdd(false)}
          onDone={() => { setShowAdd(false); load(); }}
          showToast={showToast}
          onLoginStart={onLoginStart}
        />
      )}

      {confirm && (
        <ConfirmModal
          title="Confirm"
          body={confirm.msg}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => { await confirm.action(); setConfirm(null); }}
        />
      )}
    </>
  );
}

function AddAccountModal({
  mode,
  setMode,
  onClose,
  onDone,
  showToast,
  onLoginStart,
}: {
  mode: "login" | "manual";
  setMode: (m: "login" | "manual") => void;
  onClose: () => void;
  onDone: () => void;
  showToast: (msg: string, type?: "success" | "error" | "info") => void;
  onLoginStart: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [tokens, setTokens] = useState("");
  const [loading, setLoading] = useState(false);
  const [headless, setHeadless] = useState(false);

  const submit = async () => {
    setLoading(true);
    try {
      if (mode === "login") {
        onLoginStart();
        await loginAccount(email, password, headless);
        showToast("Login successful, account added", "success");
      } else {
        const parsed = JSON.parse(tokens);
        await addAccountManual(email, parsed);
        showToast("Account added", "success");
      }
      onDone();
    } catch (e: any) {
      showToast(e.message, "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay open" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Add Postman Account</div>
        <div className="filter-bar" style={{ marginBottom: 16 }}>
          <button className={`filter-chip ${mode === "login" ? "active" : ""}`} onClick={() => setMode("login")}>
            Browser Login
          </button>
          <button className={`filter-chip ${mode === "manual" ? "active" : ""}`} onClick={() => setMode("manual")}>
            Manual Token
          </button>
        </div>
        <div className="dialog-body">
          <div className="dialog-field">
            <span className="dialog-label">Email</span>
            <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="user@example.com" />
          </div>
          {mode === "login" ? (
            <>
              <div className="dialog-field">
                <span className="dialog-label">Password</span>
                <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
              <label className="headless-toggle">
                <input type="checkbox" checked={headless} onChange={(e) => setHeadless(e.target.checked)} />
                <span>Headless mode (no visible browser window)</span>
              </label>
            </>
          ) : (
            <div>
              <div className="dialog-help">Postman tokens JSON (postman_sid, user_id, workspace_id, workspace_subdomain)</div>
              <textarea
                className="input"
                style={{ minHeight: 100, fontFamily: "ui-monospace,monospace", fontSize: 12 }}
                value={tokens}
                onChange={(e) => setTokens(e.target.value)}
                placeholder='{"postman_sid":"...","user_id":"...","workspace_id":"...","workspace_subdomain":"..."}'
              />
            </div>
          )}
        </div>
        <div className="dialog-actions">
          <button className="dialog-btn" onClick={onClose}>Cancel</button>
          <button className="dialog-btn dialog-btn-primary" disabled={loading} onClick={submit}>
            {loading ? "Working..." : mode === "login" ? "Login" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}

function quotaCell(a: Account) {
  const limit = a.quotaLimit || 0;
  const remaining = a.quotaRemaining || 0;
  const used = limit - remaining;
  const pct = limit > 0 ? Math.max(0, Math.min(100, Math.round((remaining / limit) * 100))) : 0;
  const color = pct <= 0 ? "#c9c9cf" : pct < 15 ? "#b0632a" : "#4c9168";

  if (!limit) return <span className="quota-empty">Not fetched</span>;

  return (
    <div className="quota-rows">
      <div className="quota-row">
        <span className="quota-row-name">AI Credits</span>
        <span className="quota-row-track"><span className="quota-row-fill" style={{ width: `${pct}%`, background: color }}></span></span>
        <span className="quota-row-val">{fmt(remaining)} / {fmt(limit)}</span>
      </div>
    </div>
  );
}

function ConfirmModal({
  title,
  body,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-overlay open" onClick={onCancel}>
      <div className="modal" style={{ maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{title}</div>
        <div className="dialog-help">{body}</div>
        <div className="dialog-actions">
          <button className="dialog-btn" onClick={onCancel}>Cancel</button>
          <button className="dialog-btn dialog-btn-danger" onClick={onConfirm}>Confirm</button>
        </div>
      </div>
    </div>
  );
}

function StatsTab() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    const get = () => fetchStats().then((r) => setStats(r.data));
    get();
    const interval = setInterval(get, 5000);
    return () => clearInterval(interval);
  }, []);

  if (!stats) return <div className="empty-state">Loading...</div>;

  return (
    <>
      <div className="page-hd">
        <div>
          <div className="page-title">Request Statistics</div>
          <div className="page-sub">Real-time request monitoring · Token usage tracking</div>
        </div>
        <div className="page-actions">
          <span className="live-dot">Auto-refresh 5s</span>
        </div>
      </div>

      <div className="section-head">
        <div className="section-title">Overview</div>
      </div>
      <div className="stat-grid">
        <div className="stat-cell">
          <div className="stat-top">
            <div className="stat-label">Total Requests</div>
            <span className="stat-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>
            </span>
          </div>
          <div className="stat-num">{stats.totalRequests}</div>
        </div>
        <div className="stat-cell">
          <div className="stat-top">
            <div className="stat-label">Success</div>
            <span className="stat-icon" style={{ color: "#16a34a" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke-width="1.9"><circle cx="12" cy="12" r="8" /><path d="m8.5 12 2.4 2.4 4.8-4.8" /></svg>
            </span>
          </div>
          <div className="stat-num" style={{ color: "#16a34a" }}>{stats.successRequests}</div>
        </div>
        <div className="stat-cell">
          <div className="stat-top">
            <div className="stat-label">Errors</div>
            <span className="stat-icon" style={{ color: "#b66a63" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>
            </span>
          </div>
          <div className="stat-num" style={{ color: "#b66a63" }}>{stats.errorRequests}</div>
        </div>
        <div className="stat-cell">
          <div className="stat-top">
            <div className="stat-label">Total Tokens</div>
            <span className="stat-icon" style={{ color: "#4c76b2" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><path d="M4 19a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4" /><circle cx="12" cy="8" r="4" /></svg>
            </span>
          </div>
          <div className="stat-num" style={{ color: "#4c76b2" }}>{fmt(stats.totalTokens)}</div>
        </div>
        <div className="stat-cell">
          <div className="stat-top">
            <div className="stat-label">Prompt Tokens</div>
            <span className="stat-icon" style={{ color: "#8a8a8a" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><path d="M3 6h18" /><path d="M3 12h18" /><path d="M3 18h18" /></svg>
            </span>
          </div>
          <div className="stat-num">{fmt(stats.totalPromptTokens)}</div>
        </div>
        <div className="stat-cell">
          <div className="stat-top">
            <div className="stat-label">Completion Tokens</div>
            <span className="stat-icon" style={{ color: "#8a8a8a" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><path d="M3 6h18" /><path d="M3 12h12" /><path d="M3 18h18" /></svg>
            </span>
          </div>
          <div className="stat-num">{fmt(stats.totalCompletionTokens)}</div>
        </div>
      </div>

      <div className="section-head">
        <div className="section-title">
          Accounts <span className="section-count-badge">{stats.totalAccounts}</span>
        </div>
      </div>
      <div className="stat-grid">
        <div className="stat-cell">
          <div className="stat-top"><div className="stat-label">Total Accounts</div></div>
          <div className="stat-num">{stats.totalAccounts}</div>
        </div>
        <div className="stat-cell">
          <div className="stat-top">
            <div className="stat-label">Active Accounts</div>
            <span className="stat-icon" style={{ color: "#16a34a" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke-width="1.9"><circle cx="12" cy="12" r="8" /><path d="m8.5 12 2.4 2.4 4.8-4.8" /></svg>
            </span>
          </div>
          <div className="stat-num" style={{ color: "#16a34a" }}>{stats.activeAccounts}</div>
        </div>
      </div>

      {stats.recentRequests.length > 0 && (
        <>
          <div className="section-head">
            <div className="section-title">
              Recent Requests <span className="section-count-badge">{stats.recentRequests.length}</span>
            </div>
          </div>
          <div className="table-card">
            <table>
              <thead>
                <tr>
                  <th>Model</th>
                  <th className="table-center" style={{ width: 80 }}>Status</th>
                  <th className="table-center" style={{ width: 80 }}>Tokens</th>
                  <th className="table-center" style={{ width: 100 }}>Duration</th>
                  <th style={{ width: 160 }}>Time</th>
                </tr>
              </thead>
              <tbody>
                {stats.recentRequests.slice(0, 20).map((r: any) => (
                  <tr key={r.id}>
                    <td style={{ fontFamily: "ui-monospace,monospace", fontSize: 12 }}>{r.model || "—"}</td>
                    <td className="table-center">
                      <span className={`badge ${r.status === "success" ? "badge-active" : "badge-error"}`}>{r.status}</span>
                    </td>
                    <td className="table-center">{r.totalTokens || 0}</td>
                    <td className="table-center">{r.durationMs ? `${r.durationMs}ms` : "—"}</td>
                    <td style={{ fontSize: 12, color: "#9a9a9a" }}>{r.createdAt ? new Date(r.createdAt).toLocaleString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

function SettingsTab({ showToast }: { showToast: (msg: string, type?: "success" | "error" | "info") => void }) {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchSettings().then((r) => setSettings(r.data));
  }, []);

  return (
    <>
      <div className="page-hd">
        <div>
          <div className="page-title">Settings</div>
          <div className="page-sub">Gateway access control and configuration</div>
        </div>
      </div>

      <div className="settings-card">
        <div className="section-title" style={{ marginBottom: 16 }}>API Configuration</div>
        <div className="settings-row">
          <label>API Key (for /v1/* endpoints)</label>
          <div className="hint">
            Calls to <code>/v1/chat/completions</code> must include <code>Authorization: Bearer &lt;key&gt;</code>.
            Leave empty to use default.
          </div>
          <input
            className="input"
            value={settings.api_key || ""}
            onChange={(e) => setSettings({ ...settings, api_key: e.target.value })}
            style={{ fontFamily: "ui-monospace,monospace" }}
          />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
          <button
            className="dialog-btn dialog-btn-primary"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              try {
                await updateSettings(settings);
                showToast("Saved", "success");
              } catch (e: any) {
                showToast("Save failed: " + e.message, "error");
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      <div className="settings-card">
        <div className="section-title" style={{ marginBottom: 12 }}>Usage Instructions</div>
        <div className="hint" style={{ lineHeight: 1.9 }}>
          · Add Postman accounts in the "Accounts" tab via browser login or manual token paste.
          <br />
          · Requests are distributed via round-robin; accounts with exhausted quota will automatically switch to the
          next account.
          <br />
          · Account quotas and statuses are displayed in real-time on the "Accounts" page.
          <br />· Chat endpoint:{" "}
          <code id="endpoint">{location.origin}/v1/chat/completions</code> (compatible with OpenAI API protocol).
        </div>
      </div>
    </>
  );
}

function fmt(n: number): string {
  n = Number(n) || 0;
  return n >= 10000 ? (n / 1000).toFixed(1) + "k" : String(n);
}

function fmtDate(d?: string | null): string {
  if (!d) return "—";
  const dt = new Date(d);
  return isNaN(dt.getTime())
    ? "—"
    : dt.toLocaleString("en-US", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
