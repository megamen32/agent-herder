import { homedir } from "node:os";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { Worker } from "node:worker_threads";
import type { AgentSession } from "./types/index.js";
import { readActivitySources, type ActivityProgress, type ActivitySession, type ActivitySource } from "./session-statistics-sources.js";

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
    harness: "mixed";
    sessionRoot: string;
    writeSignal: "apply_patch";
    confidence: "high" | "medium";
    caveat: string;
    caveatRu: string;
    harnesses: Array<{ harness: string; state: "ready" | "unavailable" | "partial" | "pending"; reason?: string }>;
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
  deep: CodexDeepStatistics;
  byHarness: Array<{
    harness: "codex" | "opencode" | "zcode";
    sample: AgentActivityStatistics["sample"];
    deep: CodexDeepStatistics;
    activityGaps: DistributionSummary;
    sameFileRevisits: DistributionSummary;
    sameDirectoryRevisits: DistributionSummary;
    source: ActivitySource;
  }>;
  refreshing?: boolean;
  refreshError?: string;
  progress?: ActivityProgress;
  portfolio?: SessionPortfolioStatistics;
};

type TimedPath = { timestampSec: number; path: string };
type CacheEntry = { expiresAt: number; value: AgentActivityStatistics };

const DEFAULT_WINDOW_DAYS = 30;
const CACHE_TTL_MS = 60 * 60_000;
const caches = new Map<number, CacheEntry>();
let activeRefresh: { days:number; promise:Promise<AgentActivityStatistics> } | undefined;
let queuedRefresh:{days:number;sessionRoot:string}|undefined;
const refreshErrors = new Map<number,string>();
const refreshProgress = new Map<number,ActivityProgress>();
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
  if (!options.sessionRoot) {
    let cached=caches.get(days);
    if(!cached){const disk=await readDiskCache(days);if(disk){const expiresAt=Date.parse(disk.generatedAt)+CACHE_TTL_MS;cached={expiresAt,value:disk};caches.set(days,cached);}}
    const priorError=refreshErrors.get(days);
    if(!options.refresh&&priorError)return cached?{...cached.value,refreshError:priorError}:emptyStatistics(days,sessionRoot,false,priorError);
    if(!options.refresh&&cached&&cached.expiresAt>Date.now()){
      if(activeRefresh?.days===days){const progress=refreshProgress.get(days);return {...cached.value,refreshing:true,...(progress?{progress}:{})};}
      return cached.value;
    }
    if(activeRefresh&&options.refresh&&activeRefresh.days!==days)queuedRefresh={days,sessionRoot};
    if(!activeRefresh)startRefresh(days,sessionRoot);
    if(activeRefresh){const progress=refreshProgress.get(activeRefresh.days);return cached?{...cached.value,refreshing:true,...(progress?{progress}:{})}:{...emptyStatistics(days,sessionRoot,true,undefined,progress),refreshing:true};}
    if(cached)return {...cached.value,refreshError:refreshErrors.get(days)};
    return emptyStatistics(days,sessionRoot,false,refreshErrors.get(days));
  }
  return computeAgentActivityStatistics(days,sessionRoot);
}

function startRefresh(days:number,sessionRoot:string):void{
 refreshErrors.delete(days);refreshProgress.set(days,{harness:'codex',processed:0,total:0});const promise=computeInWorker(days,sessionRoot,value=>refreshProgress.set(days,value),true);activeRefresh={days,promise};
 void promise.then(async value=>{caches.set(days,{expiresAt:Date.now()+CACHE_TTL_MS,value});await writeDiskCache(days,value).catch(()=>undefined);}).catch(error=>{refreshErrors.set(days,`Не удалось обновить статистику: ${error instanceof Error?error.message:String(error)}`);}).finally(()=>{refreshProgress.delete(days);if(activeRefresh?.promise===promise)activeRefresh=undefined;const queued=queuedRefresh;queuedRefresh=undefined;if(queued)startRefresh(queued.days,queued.sessionRoot);});
}

function computeInWorker(days:number,sessionRoot:string,onProgress?:(value:ActivityProgress)=>void,includeArchived=false):Promise<AgentActivityStatistics>{
 const worker=new Worker(new URL('./session-statistics-worker.js',import.meta.url));
 return new Promise((resolve,reject)=>{let settled=false;const finish=(fn:()=>void)=>{if(settled)return;settled=true;void worker.terminate();fn();};worker.on('message',(message:{ok?:boolean;value?:AgentActivityStatistics;error?:string;progress?:ActivityProgress})=>{if(message.progress){onProgress?.(message.progress);return;}if(message.ok&&message.value)finish(()=>resolve(message.value!));else if(message.error)finish(()=>reject(new Error(message.error)));});worker.once('error',error=>finish(()=>reject(error)));worker.once('exit',code=>{if(!settled)finish(()=>reject(new Error(`statistics_worker_exited_${code}`)));});worker.postMessage({days,sessionRoot,includeArchived});});
}

function diskCachePath(days: number): string {
  return join(homedir(), ".cache", "agent-herder", `activity-statistics-${days}d.json`);
}

async function readDiskCache(days: number): Promise<AgentActivityStatistics | null> {
  try {
    const parsed = JSON.parse(await readFile(diskCachePath(days), "utf8")) as AgentActivityStatistics;
    return parsed?.schemaVersion === 2 && parsed?.windowDays === days && typeof parsed?.generatedAt === "string" && Boolean(parsed?.codexDeep)&&Boolean(parsed?.deep)&&Array.isArray(parsed?.byHarness) ? parsed : null;
  } catch { return null; }
}

async function writeDiskCache(days: number, value: AgentActivityStatistics): Promise<void> {
  const path = diskCachePath(days);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value) + "\n", { mode: 0o600 });
  await rename(tmp, path);
}

export async function computeAgentActivityStatistics(days: number, sessionRoot: string,onProgress?:(value:ActivityProgress)=>void,includeArchived=false): Promise<AgentActivityStatistics> {
  const result=await readActivitySources(days,sessionRoot,onProgress,includeArchived);const cutoff=Date.now()/1000-days*86400;
  const byHarness=result.sources.map(source=>summarizeHarness(source,result.sessions.filter(s=>s.harness===source.harness),cutoff));
  const codex=byHarness.find(x=>x.harness==='codex')!;
  const allSessions=result.sessions;
  const aggregate=summarizeHarness({harness:'codex',state:'ready',sessions:allSessions.length},allSessions,cutoff);
  const available=result.sources.filter(s=>s.state==='ready').length;
  const p95=aggregate.activityGaps.percentilesSec.p95;
  const inactivityLeaseSec=Number.isFinite(p95)&&p95>0?clamp(Math.ceil(p95/15)*15,60,180):60;
  const fileLeaseCoverage=coverageAt(aggregate.rawSameFile,inactivityLeaseSec);
  const sample={
    sessionFiles:byHarness.reduce((n,x)=>n+x.sample.sessionFiles,0),
    sessionsWithPatches:byHarness.reduce((n,x)=>n+x.sample.sessionsWithPatches,0),
    toolCalls:byHarness.reduce((n,x)=>n+x.sample.toolCalls,0),
    toolIntervals:aggregate.rawActivity.length,
    patchCalls:byHarness.reduce((n,x)=>n+x.sample.patchCalls,0),
    pathWriteEvents:byHarness.reduce((n,x)=>n+x.sample.pathWriteEvents,0),
    sameFileSeries:aggregate.fileSeriesCount,
    repeatedFileSeries:aggregate.repeatedFileSeries,
  };
  return {
    schemaVersion:2,generatedAt:new Date().toISOString(),windowDays:days,
    source:{harness:'mixed',sessionRoot,writeSignal:'apply_patch',confidence:'medium',caveat:'Activity is aggregated from successful native tool completions and Codex tool outputs. Each source reports coverage; unavailable or partial sources are not treated as zero-activity success.',caveatRu:'Статистика объединяет подтверждённые завершения инструментов и события Codex. Состояние каждого источника показано отдельно; недоступный источник не считается нулевой активностью.',harnesses:result.sources.map(({harness,state,reason})=>({harness,state,...(reason?{reason}:{})}))},
    sample,activityGaps:aggregate.activityGaps,sameFileRevisits:aggregate.sameFileRevisits,sameDirectoryRevisits:aggregate.sameDirectoryRevisits,
    recommendation:{inactivityLeaseSec,basis:'Rounded p95 gap between successful tool completions across ready harness sources, clamped to 60–180 seconds.',sameFileCoverageAtLeasePercent:fileLeaseCoverage.percent},
    codexDeep:codex.deep,deep:aggregate.deep,byHarness:byHarness.map(({rawActivity,rawSameFile,rawSameDirectory,fileSeriesCount,repeatedFileSeries,...publicValue})=>publicValue),
  };
}

function emptyStatistics(days:number,sessionRoot:string,refreshing:boolean,error?:string,progress?:ActivityProgress):AgentActivityStatistics{
 const state=refreshing?'pending':'unavailable';const reason=refreshing?'Статистика обновляется':error?'Обновление статистики завершилось ошибкой':'Нет доступных данных статистики';
 const sources:ActivitySource[]=(['codex','opencode','zcode'] as const).map(harness=>({harness,state,reason,sessions:0}));
 const emptyDeep:CodexDeepStatistics={sessions:0,tokenCoveragePercent:0,modelCoveragePercent:0,durationCoveragePercent:0,tokens:summarizeNumeric([]),durationSec:summarizeNumeric([]),models:[],sessionsByDay:[]};
 const emptySample:AgentActivityStatistics['sample']={sessionFiles:0,sessionsWithPatches:0,toolCalls:0,toolIntervals:0,patchCalls:0,pathWriteEvents:0,sameFileSeries:0,repeatedFileSeries:0};
 const emptyDistribution=summarize([]);
 return {schemaVersion:2,generatedAt:new Date().toISOString(),windowDays:days,source:{harness:'mixed',sessionRoot,writeSignal:'apply_patch',confidence:'medium',caveat:'Statistics are being refreshed; per-harness source state is pending or unavailable.',caveatRu:'Статистика обновляется; состояние каждого источника отмечено отдельно.',harnesses:sources.map(({harness,state,reason})=>({harness,state,...(reason?{reason}:{})}))},sample:emptySample,activityGaps:emptyDistribution,sameFileRevisits:emptyDistribution,sameDirectoryRevisits:emptyDistribution,recommendation:{inactivityLeaseSec:60,basis:'No activity samples are available yet.',sameFileCoverageAtLeasePercent:0},codexDeep:emptyDeep,deep:emptyDeep,byHarness:sources.map(source=>({harness:source.harness,sample:emptySample,deep:emptyDeep,activityGaps:emptyDistribution,sameFileRevisits:emptyDistribution,sameDirectoryRevisits:emptyDistribution,source})),...(refreshing?{refreshing:true}:{}),...(error?{refreshError:error}:{}),...(progress?{progress}:{})};
}

type HarnessAggregate={harness:'codex'|'opencode'|'zcode';sample:AgentActivityStatistics['sample'];deep:CodexDeepStatistics;activityGaps:DistributionSummary;sameFileRevisits:DistributionSummary;sameDirectoryRevisits:DistributionSummary;source:ActivitySource;rawActivity:number[];rawSameFile:number[];rawSameDirectory:number[];fileSeriesCount:number;repeatedFileSeries:number};
function summarizeHarness(source:ActivitySource,sessions:ActivitySession[],cutoff:number):HarnessAggregate{
 const recent=sessions.filter(s=>s.lastAt!==undefined&&s.lastAt>=cutoff),activity:number[]=[],fileSeries=new Map<string,number[]>(),directorySeries=new Map<string,number[]>(),tokens:number[]=[],durations:number[]=[],models=new Map<string,number>(),days=new Map<string,number>();let toolCalls=0,patchCalls=0,pathWriteEvents=0,sessionsWithPatches=0;
 for(const session of recent){const toolTimes:number[]=[];let hadPatch=false;for(const event of session.events){if(event.at<cutoff)continue;toolCalls++;toolTimes.push(event.at);if(!event.paths?.length)continue;patchCalls++;hadPatch=true;for(const path of event.paths){pathWriteEvents++;const key=`${session.harness}\0${session.id}\0${path}`;addSeries(fileSeries,key,event.at);addSeries(directorySeries,`${session.harness}\0${session.id}\0${dirname(path)||'.'}`,event.at);}}if(hadPatch)sessionsWithPatches++;for(const gap of consecutiveGaps(toolTimes))activity.push(gap);if(session.tokens!==undefined)tokens.push(session.tokens);if(session.model&&!session.model.startsWith('<'))models.set(session.model,(models.get(session.model)||0)+1);if(session.firstAt!==undefined&&session.lastAt!==undefined&&session.lastAt>=session.firstAt)durations.push(session.lastAt-session.firstAt);if(session.lastAt!==undefined){const day=new Date(session.lastAt*1000).toISOString().slice(0,10);days.set(day,(days.get(day)||0)+1);}}
 const sameFile=gapsFromSeries(fileSeries),sameDirectory=gapsFromSeries(directorySeries),count=source.sessions||recent.length;
 return {harness:source.harness,sample:{sessionFiles:source.files??count,sessionsWithPatches,toolCalls,toolIntervals:activity.length,patchCalls,pathWriteEvents,sameFileSeries:fileSeries.size,repeatedFileSeries:[...fileSeries.values()].filter(v=>new Set(v).size>=2).length},deep:{sessions:count,tokenCoveragePercent:count?tokens.length/count*100:0,modelCoveragePercent:count?[...models.values()].reduce((a,b)=>a+b,0)/count*100:0,durationCoveragePercent:count?durations.length/count*100:0,tokens:summarizeNumeric(tokens),durationSec:summarizeNumeric(durations),models:rankCounts(models),sessionsByDay:[...days].sort(([a],[b])=>a.localeCompare(b)).map(([day,n])=>({day,count:n}))},activityGaps:summarize(activity),sameFileRevisits:summarize(sameFile),sameDirectoryRevisits:summarize(sameDirectory),source,rawActivity:activity,rawSameFile:sameFile,rawSameDirectory:sameDirectory,fileSeriesCount:fileSeries.size,repeatedFileSeries:[...fileSeries.values()].filter(v=>new Set(v).size>=2).length};
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
  for (const values of series.values()) for (const gap of consecutiveGaps(values)) gaps.push(gap);
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
