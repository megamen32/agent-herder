import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { AgentSession } from "./types/index.js";

type Cost = { input?: number; output?: number; cache_read?: number; cache_write?: number; reasoning?: number };
type Model = { id?: string; name?: string; cost?: Cost };
type Provider = { id?: string; name?: string; models?: Record<string, Model> };
export type ModelsDevCatalog = Record<string, Provider>;

export interface PricingMatch {
  provider: string;
  model: string;
  costUsd: number;
  rates: Cost;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

const numberMeta = (session: AgentSession, keys: string[]): number | undefined => {
  for (const key of keys) {
    const value = session.meta?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
};

function normalizedModel(value: string): string {
  return value.trim().replace(/^generic\./, "").replace(/^codexresponses\./, "");
}

function candidatePairs(catalog: ModelsDevCatalog, session: AgentSession): Array<[string, string]> {
  const raw = session.model?.trim();
  if (!raw) return [];
  const pairs: Array<[string, string]> = [];
  const push = (provider: string, model: string) => {
    if (catalog[provider]?.models?.[model]?.cost && !pairs.some(([p, m]) => p === provider && m === model)) pairs.push([provider, model]);
  };

  const explicitProvider = [session.meta?.billing_provider, session.meta?.billingProvider, session.meta?.model_provider, session.meta?.modelProvider]
    .find((value): value is string => typeof value === "string" && !!catalog[value]);
  if (explicitProvider) push(explicitProvider, raw);

  const segments = raw.split("/");
  for (let i = 0; i < segments.length - 1; i++) {
    const provider = segments[i];
    if (catalog[provider]) push(provider, segments.slice(i + 1).join("/"));
  }

  const model = normalizedModel(raw);
  if (raw.startsWith("codexresponses.") || session.harness === "codex" || /^gpt-|^o[1-9](?:-|$)/i.test(model)) push("openai", model);
  if (/^claude-/i.test(model)) push("anthropic", model);
  if (/^minimax-/i.test(model)) push("minimax", model.replace(/^minimax-/i, "MiniMax-"));
  if (/^glm-/i.test(model)) push("zai", model.toLowerCase());
  if (/deepseek.*-free$/i.test(model)) push("opencode", model);

  const preferred = ["openai", "anthropic", "minimax", "zai", "google", "deepseek", "opencode"];
  for (const provider of preferred) push(provider, model);
  if (pairs.length === 0) {
    const hits: Array<[string, string]> = [];
    for (const [provider, def] of Object.entries(catalog)) {
      if (def.models?.[model]?.cost) hits.push([provider, model]);
    }
    if (hits.length === 1) pairs.push(hits[0]);
  }
  return pairs;
}

export function estimateSessionCost(catalog: ModelsDevCatalog, session: AgentSession): PricingMatch | null {
  if (session.costUsd !== undefined || !session.model) return null;
  const input = numberMeta(session, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]);
  const output = numberMeta(session, ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"]);
  const cacheRead = numberMeta(session, ["cached_input_tokens", "cache_read_tokens", "cacheReadTokens", "cached_tokens"]) ?? 0;
  const cacheWrite = numberMeta(session, ["cache_write_tokens", "cacheWriteTokens"]) ?? 0;
  const total = numberMeta(session, ["total_tokens", "totalTokens", "tokens"]) ?? ((input ?? 0) + (output ?? 0));
  if (input === undefined && output === undefined && total === 0) return null;

  const pair = candidatePairs(catalog, session)[0];
  if (!pair) return null;
  const [provider, model] = pair;
  const rates = catalog[provider]!.models![model]!.cost!;
  const billedInput = Math.max(0, (input ?? Math.max(0, total - (output ?? 0))) - cacheRead - cacheWrite);
  const usd = (
    billedInput * (rates.input ?? 0)
    + (output ?? 0) * (rates.output ?? 0)
    + cacheRead * (rates.cache_read ?? rates.input ?? 0)
    + cacheWrite * (rates.cache_write ?? rates.input ?? 0)
  ) / 1_000_000;
  if (!Number.isFinite(usd)) return null;
  return { provider, model, costUsd: usd, rates, usage: { input: input ?? 0, output: output ?? 0, cacheRead, cacheWrite, total } };
}

export class ModelsDevPricing {
  private catalog: ModelsDevCatalog | null = null;
  private loadedAt = 0;
  private refresh: Promise<void> | null = null;
  private readonly ttlMs = 12 * 60 * 60_000;
  private readonly cachePath = join(homedir(), ".cache", "agent-herder", "models-dev-api.json");

  constructor() { void this.warm(); }

  async enrich(session: AgentSession): Promise<AgentSession> {
    await this.loadDiskOnce();
    if (!this.catalog || Date.now() - this.loadedAt >= this.ttlMs) void this.refreshCatalog().catch(() => undefined);
    if (session.costUsd !== undefined || !this.catalog) return session;
    const estimate = estimateSessionCost(this.catalog, session);
    if (!estimate) return session;
    return {
      ...session,
      costUsd: estimate.costUsd,
      meta: {
        ...session.meta,
        pricing_source: "models.dev",
        pricing_kind: "estimate",
        pricing_provider: estimate.provider,
        pricing_model: estimate.model,
        pricing_rates_per_million: estimate.rates,
        pricing_usage: estimate.usage,
      },
    };
  }

  async warm(): Promise<void> {
    await this.loadDiskOnce();
    if (!this.catalog || Date.now() - this.loadedAt >= this.ttlMs) void this.refreshCatalog().catch(() => undefined);
  }

  private async loadDiskOnce(): Promise<void> {
    if (this.catalog) return;
    try {
      this.catalog = JSON.parse(await readFile(this.cachePath, "utf8")) as ModelsDevCatalog;
      this.loadedAt = (await stat(this.cachePath)).mtimeMs;
    } catch { /* cold cache */ }
  }

  private refreshCatalog(): Promise<void> {
    if (this.refresh) return this.refresh;
    this.refresh = (async () => {
      const response = await fetch("https://models.dev/api.json", { headers: { "user-agent": "AgentHerder/1.0" }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`);
      const catalog = await response.json() as ModelsDevCatalog;
      if (!catalog.openai?.models) throw new Error("models.dev catalog has unexpected shape");
      await mkdir(dirname(this.cachePath), { recursive: true });
      const tmp = `${this.cachePath}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(catalog));
      await rename(tmp, this.cachePath);
      this.catalog = catalog;
      this.loadedAt = Date.now();
    })().finally(() => { this.refresh = null; });
    return this.refresh;
  }
}
