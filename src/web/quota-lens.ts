// quota-lens: кто тратит квоты моделей (opt-in, ENABLE_QUOTA_LENS=1).
// Мягкие зависимости: node:sqlite, ~/.omniroute/storage.sqlite, ~/.codex/auth.json,
// ~/.fast-agent/sessions — всё опционально; при отсутствии ручки отдают {error}.
// Никаких новых npm-зависимостей: только node:sqlite и глобальный fetch.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const TICK_MS = 5 * 60_000;
let samplerStarted = false;
let lastTickTs = 0;

// динамический импорт мимо tsc: модуль может отсутствовать в старых node
const dynamicImport = (module: string): Promise<any> => import(/* @vite-ignore */ module);

export function isQuotaLensEnabled(): boolean {
  const value = (process.env.ENABLE_QUOTA_LENS ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

const omniDbPath = () => process.env.QUOTA_LENS_DB?.trim() || join(homedir(), ".omniroute", "storage.sqlite");
const historyFile = () => process.env.QUOTA_LENS_HISTORY?.trim() || join(homedir(), ".local", "share", "quota-lens", "history.jsonl");
const codexAuthFile = () => process.env.QUOTA_LENS_CODEX_AUTH?.trim() || join(homedir(), ".codex", "auth.json");
const fastAgentHomePath = () => process.env.QUOTA_LENS_FAST_AGENT_HOME?.trim() || join(homedir(), ".fast-agent", "sessions");

async function omniQuery<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const dbPath = omniDbPath();
  if (!existsSync(dbPath)) throw new Error(`omniroute db not found: ${dbPath}`);
  const { DatabaseSync } = await dynamicImport("node:sqlite");
  const open = (): { close(): void; prepare(sql: string): { all(...params: unknown[]): unknown[] } } => {
    try {
      return new DatabaseSync(dbPath, { readOnly: true });
    } catch {
      return new DatabaseSync(dbPath);
    }
  };
  const db = open();
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

async function omniQuerySafe<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[] | { error: string }> {
  try {
    return await omniQuery<T>(sql, params);
  } catch (error) {
    return { error: String((error as Error).message).slice(0, 160) };
  }
}

function localCodexAuth(): { token: string; accountId: string } {
  const path = codexAuthFile();
  if (!existsSync(path)) return { token: "", accountId: "" };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { tokens?: { access_token?: string; account_id?: string } };
  const token = parsed.tokens?.access_token ?? "";
  const payloadPart = token.split(".")[1] ?? "";
  let accountId = parsed.tokens?.account_id ?? "";
  try {
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    accountId ||= payload?.["https://api.openai.com/auth"]?.chatgpt_account_id ?? "";
  } catch {}
  return { token, accountId };
}

function jwtClaim(jwt: string, claim: string): string {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8"));
    return payload?.["https://api.openai.com/auth"]?.[claim] ?? "";
  } catch {
    return "";
  }
}

async function codexUsage(): Promise<Record<string, unknown>> {
  const { token, accountId } = localCodexAuth();
  if (!token) return { error: "no local ~/.codex/auth.json" };
  try {
    const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        "chatgpt-account-id": accountId,
        "User-Agent": "agent-herder-quota-lens/1.0",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { error: `HTTP ${response.status}` };
    const data = response.json() as Promise<any>;
    const rl = (await data).rate_limit ?? {};
    return {
      plan: (await data).plan_type,
      email: (await data).email,
      primary_used: rl.primary_window?.used_percent,
      primary_reset_s: rl.primary_window?.reset_after_seconds,
      secondary_used: rl.secondary_window?.used_percent,
      limit_reached: rl.limit_reached,
    };
  } catch (error) {
    return { error: String((error as Error).message).slice(0, 160) };
  }
}

const WINDOW_DAYS = (days: string | null, fallback: number) => {
  const parsed = Number(days);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 90 ? parsed : fallback;
};

async function summary(days: number) {
  return omniQuerySafe(
    `SELECT model, provider, count(*) calls, sum(tokens_in+tokens_out) tokens,
            count(DISTINCT api_key_name) keys, max(timestamp) last_call, sum(status >= 400) errors
     FROM call_logs
     WHERE timestamp >= datetime('now', ?) AND model NOT IN ('', 'connection-test', 'model-sync')
     GROUP BY model, provider ORDER BY tokens DESC LIMIT 200`,
    [`-${days} days`],
  );
}

async function keySummary(days: number) {
  return omniQuerySafe(
    `SELECT coalesce(api_key_name, '(internal)') key, count(*) calls,
            sum(tokens_in+tokens_out) tokens, max(timestamp) last_call
     FROM call_logs
     WHERE timestamp >= datetime('now', ?) AND model NOT IN ('', 'connection-test', 'model-sync')
     GROUP BY key ORDER BY tokens DESC LIMIT 50`,
    [`-${days} days`],
  );
}

async function callRows(model: string | null, key: string | null, days: number, limit: number) {
  let sql = `SELECT timestamp, provider, model, api_key_name, status, tokens_in+tokens_out tokens, request_type, path
     FROM call_logs WHERE timestamp >= datetime('now', ?)`;
  const params: unknown[] = [`-${days} days`];
  if (model) { sql += " AND model = ?"; params.push(model); }
  if (key) {
    sql += key === "(internal)" ? " AND api_key_name IS NULL" : " AND api_key_name = ?";
    if (key !== "(internal)") params.push(key);
  }
  sql += " ORDER BY timestamp DESC LIMIT ?";
  params.push(limit);
  return omniQuerySafe(sql, params);
}

function listFastAgentSessions(): Record<string, unknown>[] | { error: string } {
  const home = fastAgentHomePath();
  if (!existsSync(home)) return { error: `no dir: ${home}` };
  const out: Record<string, unknown>[] = [];
  const entries = readdirSync(home, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .slice(0, 60);
  for (const entry of entries) {
    const dir = join(home, entry.name);
    const sessionFile = join(dir, "session.json");
    if (!existsSync(sessionFile)) continue;
    try {
      const session = JSON.parse(readFileSync(sessionFile, "utf8")) as any;
      const agent = session?.continuation?.active_agent || "dev";
      const historyFile = join(dir, `history_${agent}.json`);
      let messages = 0;
      if (existsSync(historyFile)) {
        const raw = JSON.parse(readFileSync(historyFile, "utf8"));
        messages = Array.isArray(raw) ? raw.length : Object.keys(raw?.messages ?? raw ?? {}).length;
      }
      out.push({
        id: session.session_id || entry.name,
        created: session.created_at,
        last_activity: session.last_activity,
        first_user: (session.metadata?.first_user_preview || "").slice(0, 120),
        messages,
      });
    } catch {}
  }
  return out;
}

function readTimeline(limit: number): Record<string, unknown>[] {
  const file = historyFile();
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  return lines.slice(-limit).map((line) => {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      // нормализация: старые записи python-сэмплера — секунды, возможные ms — приводим
      if (typeof record.ts === "number" && record.ts > 1e12) record.ts = Math.floor(record.ts / 1000);
      return record;
    } catch { return { ts: 0 }; }
  });
}

async function sampleOnce(): Promise<Record<string, unknown>> {
  const since = new Date(Math.max(lastTickTs - 1_000, 0)).toISOString().replace(/\.\d{3}Z$/, "");
  const quota = await codexUsage();
  const deltas = await omniQuerySafe(
    `SELECT coalesce(api_key_name,'(internal)') key, model, count(*) calls,
            sum(tokens_in+tokens_out) tokens
     FROM call_logs
     WHERE timestamp > ? AND model NOT IN ('', 'connection-test', 'model-sync')
     GROUP BY key, model ORDER BY tokens DESC LIMIT 10`,
    [since],
  );
  const record = { ts: Math.floor(Date.now() / 1000), quota, deltas }; // секунды, как в python-версии
  const file = historyFile();
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`);
  lastTickTs = Date.now();
  return record;
}

type HistoryPoint = { ts: number; quota?: { primary?: number; secondary?: number; limit_reached?: boolean; reset_s?: number } };

// Прогноз: когда окно кончится при текущем темпе. Скорость — среднее по парам
// замеров с гауссовым весом по свежести (σ минут, QUOTA_LENS_FORECAST_SIGMA_MIN).
function computeForecast(entries: HistoryPoint[], sigmaMin: number): Record<string, unknown> {
  const nowSec = Date.now() / 1000;
  const clean = entries
    .filter((e) => typeof e.ts === "number" && e.ts > 0 && e.quota && typeof e.quota.primary === "number")
    .map((e) => ({ ts: e.ts as number, primary: e.quota!.primary as number, secondary: e.quota!.secondary, quota: e.quota! }))
    .sort((a, b) => a.ts - b.ts);
  let wSum = 0, wRate = 0, wSum2 = 0, wRate2 = 0, pairs = 0;
  for (let i = 1; i < clean.length; i++) {
    const dtMin = (clean[i].ts - clean[i - 1].ts) / 60;
    if (dtMin <= 0.5 || dtMin > 60) continue;
    const dp = clean[i].primary - clean[i - 1].primary;
    if (dp <= 0.05) continue; // сброс окна или плато — не считаем расходом
    const ageMin = Math.max((nowSec - clean[i].ts) / 60, 0);
    const weight = Math.exp(-(ageMin * ageMin) / (2 * sigmaMin * sigmaMin));
    wSum += weight;
    wRate += weight * (dp / dtMin);
    pairs++;
    if (typeof clean[i].secondary === "number" && typeof clean[i - 1].secondary === "number") {
      const ds = (clean[i].secondary as number) - (clean[i - 1].secondary as number);
      if (ds > 0.05) { wSum2 += weight; wRate2 += weight * (ds / dtMin); }
    }
  }
  const last = clean[clean.length - 1];
  if (!last || pairs === 0 || wSum === 0) {
    return { available: false, reason: "мало замеров — нужен хотя бы один интервал роста", pairs, sigma_min: sigmaMin };
  }
  const ratePrimary = wRate / wSum;
  const rateSecondary = wSum2 > 0 ? wRate2 / wSum2 : 0;
  const exhausted = last.primary >= 99.5 || Boolean(last.quota.limit_reached);
  return {
    available: true,
    pairs,
    sigma_min: sigmaMin,
    current_primary: last.primary,
    rate_primary_per_min: Number(ratePrimary.toFixed(4)),
    exhausted,
    eta_primary_min: exhausted ? 0 : ratePrimary > 0 ? Math.round((100 - last.primary) / ratePrimary) : null,
    current_secondary: last.secondary ?? null,
    rate_secondary_per_min: Number(rateSecondary.toFixed(4)),
    eta_secondary_min: typeof last.secondary === "number" && rateSecondary > 0
      ? Math.round((100 - last.secondary) / rateSecondary)
      : null,
    secondary_reset_s: last.quota.reset_s ?? null,
  };
}

async function forecast(): Promise<Record<string, unknown>> {
  const sigmaMin = Math.max(5, Number(process.env.QUOTA_LENS_FORECAST_SIGMA_MIN) || 30);
  const entries = readTimeline(500) as HistoryPoint[];
  return computeForecast(entries, sigmaMin);
}

export function startQuotaLensSampler(): void {
  if (samplerStarted || !isQuotaLensEnabled()) return;
  samplerStarted = true;
  try {
    const lines = readFileSync(historyFile(), "utf8").split("\n").filter(Boolean);
    if (lines.length) lastTickTs = Number(JSON.parse(lines[lines.length - 1])?.ts) || 0;
  } catch {}
  const tick = () => { void sampleOnce().catch(() => {}); };
  void tick();
  setInterval(tick, TICK_MS).unref?.();
}

export async function handleQuotaLensRequest(pathname: string, params: URLSearchParams): Promise<unknown> {
  if (!pathname.startsWith("/api/quota-lens")) return null;
  if (!isQuotaLensEnabled()) return { enabled: false, hint: "set ENABLE_QUOTA_LENS=1 to opt in" };
  const days = WINDOW_DAYS(params.get("days"), 7);
  if (pathname === "/api/quota-lens/status") {
    return {
      enabled: true,
      omniroute_db: existsSync(omniDbPath()),
      codex_auth: existsSync(codexAuthFile()),
      fast_agent_home: existsSync(fastAgentHomePath()),
      history: historyFile(),
    };
  }
  if (pathname === "/api/quota-lens/summary") return summary(days);
  if (pathname === "/api/quota-lens/keys") return keySummary(days);
  if (pathname === "/api/quota-lens/rows") {
    return callRows(params.get("model"), params.get("key"), days, Math.min(Number(params.get("limit")) || 400, 2000));
  }
  if (pathname === "/api/quota-lens/codex") return codexUsage();
  if (pathname === "/api/quota-lens/fastagent") return listFastAgentSessions();
  if (pathname === "/api/quota-lens/timeline") return readTimeline(Math.min(Number(params.get("limit")) || 288, 2000));
  if (pathname === "/api/quota-lens/forecast") return forecast();
  return { error: `unknown quota-lens route: ${pathname}` };
}
