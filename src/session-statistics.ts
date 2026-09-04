import { homedir } from "node:os";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { AgentSession } from "./types/index.js";

export type DistributionSummary = {
  count: number;
  percentilesSec: { p50: number; p75: number; p90: number; p95: number; p99: number };
  coverage: Array<{ seconds: number; count: number; percent: number }>;
  histogram: Array<{ label: string; minSec: number; maxSec?: number; count: number; percent: number }>;
};


export type NumericSummary = {
  count: number; mean: number; median: number; p75: number; p90: number; p95: number; p99: number; min: number; max: number;
};
export type RankedCount = { name: string; count: number; percent: number };
export type SessionPortfolioStatistics = {
  observedSessions: number; tokenCoveragePercent: number; durationCoveragePercent: number; modelCoveragePercent: number;
  harnesses: RankedCount[]; models: RankedCount[]; tokens: NumericSummary; durationSec: NumericSummary;
  sessionsByDay: Array<{ day: string; count: number }>; caveat: string;
};
export type CodexDeepStatistics = {
  sessions: number; tokenCoveragePercent: number; modelCoveragePercent: number; durationCoveragePercent: number;
  tokens: NumericSummary; durationSec: NumericSummary; models: RankedCount[]; sessionsByDay: Array<{ day: string; count: number }>;
};

export type AgentActivityStatistics = {
  schemaVersion: 2;
  generatedAt: string;
  windowDays: number;
  source: {
    harness: "codex";
    sessionRoot: string;
    writeSignal: "apply_patch";
    confidence: "high";
    caveat: string;
  };
  sample: {
    sessionFiles: number;
    sessionsWithPatches: number;
    toolCalls: number;
    toolIntervals: number;
    patchCalls: number;
    pathWriteEvents: number;
    sameFileSeries: number;
    repeatedFileSeries: number;
  };
  activityGaps: DistributionSummary;
  sameFileRevisits: DistributionSummary;
  sameDirectoryRevisits: DistributionSummary;
  recommendation: {
    inactivityLeaseSec: number;
    basis: string;
    sameFileCoverageAtLeasePercent: number;
  };
  codexDeep: CodexDeepStatistics;
  portfolio?: SessionPortfolioStatistics;
};

type TimedPath = { timestampSec: number; path: string };
type CacheEntry = { expiresAt: number; value: AgentActivityStatistics };

const DEFAULT_WINDOW_DAYS = 30;
const CACHE_TTL_MS = 60 * 60_000;
const caches = new Map<number, CacheEntry>();
const inflight = new Map<number, Promise<AgentActivityStatistics>>();
const PATCH_HEADER = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/gm;
const COVERAGE_SECONDS = [30, 60, 120, 180, 300];
const HISTOGRAM_BUCKETS = [
  { label: "≤30s", minSec: 0, maxSec: 30 },
  { label: "30–60s", minSec: 30, maxSec: 60 },
  { label: "1–2m", minSec: 60, maxSec: 120 },
  { label: "2–3m", minSec: 120, maxSec: 180 },
  { label: "3–5m", minSec: 180, maxSec: 300 },
  { label: "5–15m", minSec: 300, maxSec: 900 },
  { label: "15–60m", minSec: 900, maxSec: 3600 },
  { label: ">60m", minSec: 3600 },
];

export async function getAgentActivityStatistics(options: { days?: number; refresh?: boolean; sessionRoot?: string } = {}): Promise<AgentActivityStatistics> {
  const days = Math.max(1, Math.min(365, Math.round(options.days ?? DEFAULT_WINDOW_DAYS)));
  const sessionRoot = options.sessionRoot || process.env.CODEX_HOME
    ? resolve(options.sessionRoot || process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions")
    : join(homedir(), ".codex", "sessions");
  if (!options.refresh && !options.sessionRoot) {
    const cached = caches.get(days);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const disk = await readDiskCache(days);
    if (disk && Date.now() - Date.parse(disk.generatedAt) < CACHE_TTL_MS) {
      caches.set(days, { expiresAt: Date.now() + CACHE_TTL_MS, value: disk });
      return disk;
    }
    const running = inflight.get(days);
    if (running) return running;
  }
  const work = computeAgentActivityStatistics(days, sessionRoot);
  if (!options.sessionRoot) inflight.set(days, work);
  try {
    const value = await work;
    if (!options.sessionRoot) {
      caches.set(days, { expiresAt: Date.now() + CACHE_TTL_MS, value });
      await writeDiskCache(days, value).catch(() => undefined);
    }
    return value;
  } finally {
    if (!options.sessionRoot) inflight.delete(days);
  }
}

function diskCachePath(days: number): string {
  return join(homedir(), ".cache", "agent-herder", `activity-statistics-${days}d.json`);
}

async function readDiskCache(days: number): Promise<AgentActivityStatistics | null> {
  try {
    const parsed = JSON.parse(await readFile(diskCachePath(days), "utf8")) as AgentActivityStatistics;
    return parsed?.schemaVersion === 2 && parsed?.windowDays === days && typeof parsed?.generatedAt === "string" && Boolean(parsed?.codexDeep) ? parsed : null;
  } catch { return null; }
}

async function writeDiskCache(days: number, value: AgentActivityStatistics): Promise<void> {
  const path = diskCachePath(days);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value) + "\n", { mode: 0o600 });
  await rename(tmp, path);
}

export async function computeAgentActivityStatistics(days: number, sessionRoot: string): Promise<AgentActivityStatistics> {
  const cutoffMs = Date.now() - days * 24 * 60 * 60_000;
  const files = await collectSessionFiles(sessionRoot, cutoffMs);
  const activityGaps: number[] = [];
  const fileSeries = new Map<string, number[]>();
  const directorySeries = new Map<string, number[]>();
  let toolCalls = 0;
  let patchCalls = 0;
  let pathWriteEvents = 0;
  let sessionsWithPatches = 0;
  const codexDurations: number[] = [];
  const codexTokens: number[] = [];
  const codexModels = new Map<string, number>();
  const codexDays = new Map<string, number>();

  for (const file of files) {
    let raw: string;
    try { raw = await readFile(file, "utf8"); } catch { continue; }
    let currentCwd = "";
    const toolTimes: number[] = [];
    let sessionHasPatch = false;
    let firstTimestampSec: number | undefined;
    let lastTimestampSec: number | undefined;
    let latestTotalTokens: number | undefined;
    let latestModel: string | undefined;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let item: any;
      try { item = JSON.parse(line); } catch { continue; }
      const payload = item?.payload;
      const anyTimestampSec = timestampSeconds(item?.timestamp);
      if (anyTimestampSec !== undefined) { firstTimestampSec = firstTimestampSec === undefined ? anyTimestampSec : Math.min(firstTimestampSec, anyTimestampSec); lastTimestampSec = lastTimestampSec === undefined ? anyTimestampSec : Math.max(lastTimestampSec, anyTimestampSec); }
      if (item?.type === "turn_context" && payload) {
        if (typeof payload.cwd === "string") currentCwd = payload.cwd;
        if (typeof payload.model === "string" && payload.model.trim()) latestModel = payload.model.trim();
      }
      if (item?.type === "event_msg" && payload?.type === "token_count") {
        const total = payload?.info?.total_token_usage?.total_tokens;
        if (typeof total === "number" && Number.isFinite(total)) latestTotalTokens = total;
      }
      if (item?.type !== "response_item" || !payload || (payload.type !== "function_call" && payload.type !== "custom_tool_call")) continue;
      const timestampSec = anyTimestampSec;
      if (timestampSec === undefined) continue;
      toolCalls += 1;
      toolTimes.push(timestampSec);
      const patchText = extractPatchText(payload);
      if (!patchText) continue;
      const paths = extractPatchPaths(patchText, currentCwd);
      if (paths.length === 0) continue;
      patchCalls += 1;
      sessionHasPatch = true;
      for (const path of paths) {
        pathWriteEvents += 1;
        addSeries(fileSeries, `${file}\0${path}`, timestampSec);
        addSeries(directorySeries, `${file}\0${dirname(path) || "."}`, timestampSec);
      }
    }
    if (sessionHasPatch) sessionsWithPatches += 1;
    activityGaps.push(...consecutiveGaps(toolTimes));
    if (firstTimestampSec !== undefined) { const day = new Date(firstTimestampSec * 1000).toISOString().slice(0, 10); codexDays.set(day, (codexDays.get(day) || 0) + 1); }
    if (firstTimestampSec !== undefined && lastTimestampSec !== undefined && lastTimestampSec >= firstTimestampSec) codexDurations.push(lastTimestampSec - firstTimestampSec);
    if (latestTotalTokens !== undefined) codexTokens.push(latestTotalTokens);
    if (latestModel && !latestModel.startsWith("<")) codexModels.set(latestModel, (codexModels.get(latestModel) || 0) + 1);
  }

  const sameFileGaps = gapsFromSeries(fileSeries);
  const sameDirectoryGaps = gapsFromSeries(directorySeries);
  const activitySummary = summarize(activityGaps);
  const sameFileSummary = summarize(sameFileGaps);
  const sameDirectorySummary = summarize(sameDirectoryGaps);
  const p95 = activitySummary.percentilesSec.p95;
  const inactivityLeaseSec = Number.isFinite(p95) && p95 > 0 ? clamp(Math.ceil(p95 / 15) * 15, 60, 180) : 60;
  const fileLeaseCoverage = coverageAt(sameFileGaps, inactivityLeaseSec);

  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    windowDays: days,
    source: {
      harness: "codex",
      sessionRoot,
      writeSignal: "apply_patch",
      confidence: "high",
      caveat: "Write revisit statistics use explicit Codex apply_patch paths only; shell mutations and read-only tool calls are excluded.",
    },
    sample: {
      sessionFiles: files.length,
      sessionsWithPatches,
      toolCalls,
      toolIntervals: activityGaps.length,
      patchCalls,
      pathWriteEvents,
      sameFileSeries: fileSeries.size,
      repeatedFileSeries: [...fileSeries.values()].filter((values) => new Set(values).size >= 2).length,
    },
    activityGaps: activitySummary,
    sameFileRevisits: sameFileSummary,
    sameDirectoryRevisits: sameDirectorySummary,
    recommendation: {
      inactivityLeaseSec,
      basis: "Rounded p95 gap between consecutive Codex tool calls, clamped to 60–180 seconds. Existing edited paths should be renewed by session activity rather than only by another write to that file.",
      sameFileCoverageAtLeasePercent: fileLeaseCoverage.percent,
    },
    codexDeep: {
      sessions: files.length,
      tokenCoveragePercent: files.length ? codexTokens.length / files.length * 100 : 0,
      modelCoveragePercent: files.length ? [...codexModels.values()].reduce((a, b) => a + b, 0) / files.length * 100 : 0,
      durationCoveragePercent: files.length ? codexDurations.length / files.length * 100 : 0,
      tokens: summarizeNumeric(codexTokens),
      durationSec: summarizeNumeric(codexDurations),
      models: rankCounts(codexModels),
      sessionsByDay: [...codexDays.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, count]) => ({ day, count })),
    },
  };
}

export function withSessionPortfolioStatistics(base: AgentActivityStatistics, sessions: AgentSession[], days: number): AgentActivityStatistics {
  const cutoff = Date.now() - days * 24 * 60 * 60_000;
  const recent = sessions.filter((session) => { const time = Date.parse(session.lastActivity); return Number.isFinite(time) && time >= cutoff; });
  const harnessCounts = new Map<string, number>(); const modelCounts = new Map<string, number>(); const dayCounts = new Map<string, number>();
  const tokenValues: number[] = []; const durationValues: number[] = []; let modelsKnown = 0;
  for (const session of recent) {
    harnessCounts.set(session.harness, (harnessCounts.get(session.harness) || 0) + 1);
    if (session.model && !session.model.startsWith("<")) { modelsKnown += 1; modelCounts.set(session.model, (modelCounts.get(session.model) || 0) + 1); }
    const tokens = metaNumber(session.meta, ["total_tokens", "totalTokens", "tokens"]); if (tokens !== undefined) tokenValues.push(tokens);
    const created = metaString(session.meta, ["createdAt", "created_at", "created"]); const start = created ? Date.parse(created) : NaN; const end = Date.parse(session.lastActivity);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) durationValues.push((end - start) / 1000);
    const day = new Date(end).toISOString().slice(0, 10); dayCounts.set(day, (dayCounts.get(day) || 0) + 1);
  }
  return { ...base, portfolio: {
    observedSessions: recent.length,
    tokenCoveragePercent: recent.length ? tokenValues.length / recent.length * 100 : 0,
    durationCoveragePercent: recent.length ? durationValues.length / recent.length * 100 : 0,
    modelCoveragePercent: recent.length ? modelsKnown / recent.length * 100 : 0,
    harnesses: rankCounts(harnessCounts), models: rankCounts(modelCounts), tokens: summarizeNumeric(tokenValues), durationSec: summarizeNumeric(durationValues),
    sessionsByDay: [...dayCounts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, count]) => ({ day, count })),
    caveat: "Portfolio popularity uses sessions whose lastActivity falls inside the selected window. Token and duration summaries include only sessions where the harness exposes those fields; coverage is shown explicitly.",
  } };
}

function metaNumber(meta: Record<string, unknown> | undefined, keys: string[]): number | undefined { for (const key of keys) { const value = meta?.[key]; if (typeof value === "number" && Number.isFinite(value)) return value; } return undefined; }
function metaString(meta: Record<string, unknown> | undefined, keys: string[]): string | undefined { for (const key of keys) { const value = meta?.[key]; if (typeof value === "string" && value.trim()) return value; } return undefined; }
function summarizeNumeric(input: number[]): NumericSummary { const values = input.filter((v) => Number.isFinite(v) && v >= 0).sort((a,b)=>a-b); if (!values.length) return { count:0, mean:0, median:0, p75:0, p90:0, p95:0, p99:0, min:0, max:0 }; return { count: values.length, mean: values.reduce((a,b)=>a+b,0)/values.length, median: percentile(values,.5), p75: percentile(values,.75), p90: percentile(values,.9), p95: percentile(values,.95), p99: percentile(values,.99), min: values[0], max: values[values.length-1] }; }
function rankCounts(counts: Map<string, number>): RankedCount[] { const total=[...counts.values()].reduce((a,b)=>a+b,0); return [...counts.entries()].sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0])).map(([name,count])=>({name,count,percent: total ? count/total*100 : 0})); }

async function collectSessionFiles(root: string, cutoffMs: number): Promise<string[]> {
  const result: string[] = [];
  const visit = async (path: string): Promise<void> => {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); } catch { return; }
    await Promise.all(entries.map(async (entry) => {
      const full = join(path, entry.name);
      if (entry.isDirectory()) return visit(full);
      if (!entry.isFile() || extname(entry.name) !== ".jsonl") return;
      try {
        const info = await stat(full);
        if (info.mtimeMs >= cutoffMs) result.push(full);
      } catch { /* file disappeared during discovery */ }
    }));
  };
  await visit(root);
  return result.sort();
}

function extractPatchText(payload: any): string | null {
  const candidates: string[] = [];
  if (typeof payload.input === "string") candidates.push(payload.input);
  if (typeof payload.arguments === "string") {
    candidates.push(payload.arguments);
    try { collectStrings(JSON.parse(payload.arguments), candidates); } catch { /* not JSON */ }
  } else if (payload.arguments) collectStrings(payload.arguments, candidates);
  for (const candidate of candidates) {
    const decoded = candidate.includes("\\n") ? candidate.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"') : candidate;
    if (decoded.includes("*** Begin Patch") || decoded.match(PATCH_HEADER)) return decoded;
  }
  return null;
}

function collectStrings(value: unknown, output: string[]): void {
  if (typeof value === "string") { output.push(value); return; }
  if (Array.isArray(value)) { for (const item of value) collectStrings(item, output); return; }
  if (value && typeof value === "object") for (const item of Object.values(value as Record<string, unknown>)) collectStrings(item, output);
}

function extractPatchPaths(text: string, cwd: string): string[] {
  const paths = new Set<string>();
  PATCH_HEADER.lastIndex = 0;
  for (const match of text.matchAll(PATCH_HEADER)) {
    const raw = String(match[1] || "").trim().replace(/^["'`]|["'`]$/g, "");
    if (!raw) continue;
    paths.add(normalizeSessionPath(raw, cwd));
  }
  return [...paths];
}

function normalizeSessionPath(path: string, cwd: string): string {
  const expanded = path.replace(/^~(?=\/|$)/, homedir());
  if (isAbsolute(expanded)) {
    if (cwd && isAbsolute(cwd)) {
      const rel = relative(resolve(cwd), resolve(expanded));
      if (rel !== ".." && !rel.startsWith(`..${sep}`)) return normalize(rel || ".");
    }
    return normalize(expanded);
  }
  return normalize(expanded.replace(/^\.\//, ""));
}

function timestampSeconds(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms / 1000 : undefined;
}

function addSeries(map: Map<string, number[]>, key: string, timestamp: number): void {
  const values = map.get(key);
  if (values) values.push(timestamp);
  else map.set(key, [timestamp]);
}

function consecutiveGaps(values: number[]): number[] {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let index = 1; index < sorted.length; index++) if (sorted[index] >= sorted[index - 1]) gaps.push(sorted[index] - sorted[index - 1]);
  return gaps;
}

function gapsFromSeries(series: Map<string, number[]>): number[] {
  const gaps: number[] = [];
  for (const values of series.values()) gaps.push(...consecutiveGaps(values));
  return gaps;
}

function summarize(input: number[]): DistributionSummary {
  const values = input.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  return {
    count: values.length,
    percentilesSec: {
      p50: percentile(values, 0.50), p75: percentile(values, 0.75), p90: percentile(values, 0.90),
      p95: percentile(values, 0.95), p99: percentile(values, 0.99),
    },
    coverage: COVERAGE_SECONDS.map((seconds) => ({ seconds, ...coverageAt(values, seconds) })),
    histogram: HISTOGRAM_BUCKETS.map((bucket) => {
      const count = values.filter((value) => {
        const aboveMin = bucket.minSec === 0 ? value >= 0 : value > bucket.minSec;
        return aboveMin && (bucket.maxSec === undefined || value <= bucket.maxSec);
      }).length;
      return { ...bucket, count, percent: values.length ? count / values.length * 100 : 0 };
    }),
  };
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const index = (values.length - 1) * fraction;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return values[low];
  return values[low] * (high - index) + values[high] * (index - low);
}

function coverageAt(values: number[], seconds: number): { count: number; percent: number } {
  const count = values.filter((value) => value <= seconds).length;
  return { count, percent: values.length ? count / values.length * 100 : 0 };
}

function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
