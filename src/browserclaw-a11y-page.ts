import {
  BrowserClawA11yError,
  validateBrowserClawSemanticAction,
  type BrowserClawA11yActionInput,
  type BrowserClawA11ySnapshot,
  type BrowserClawSemanticAction,
} from "./browserclaw-a11y.js";

/** A page reported by BrowserClaw in the MCP session that owns it. */
export interface BrowserClawA11yTab {
  page: number;
  url: string;
}

/** Minimal BrowserClaw transport needed to keep one accessibility page lease. */
export interface BrowserClawA11yClient {
  readonly sessionRef: string;
  listTabs(): Promise<readonly BrowserClawA11yTab[]>;
  snapshotPage(page: number): Promise<BrowserClawA11ySnapshot>;
  actPage(page: number, action: BrowserClawSemanticAction): Promise<BrowserClawA11ySnapshot>;
}

export type BrowserClawA11yPageErrorCode = "browser_action_failed" | "page_lease_lost";

/** A transport/ownership failure distinct from malformed A11y content. */
export class BrowserClawA11yPageError extends Error {
  constructor(readonly code: BrowserClawA11yPageErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "BrowserClawA11yPageError";
  }
}

export interface BrowserClawA11yPage {
  snapshot(deadlineAt: number): Promise<BrowserClawA11ySnapshot>;
  act(input: BrowserClawA11yActionInput, deadlineAt: number): Promise<BrowserClawA11ySnapshot>;
}

export interface BrowserClawA11yDriver {
  acquirePage(): Promise<BrowserClawA11yPage>;
}

export interface BrowserClawA11yDriverOptions {
  /** One exact HTTPS origin/path. Query and fragment are deliberately ignored. */
  targetUrl: string;
  /** Optional target-origin path prefix for a same-tab SPA route transition. */
  allowPathPrefix?: string;
  /** When supplied, bind only this page id even if other matching pages are visible. */
  page?: number;
}

function normalizedTarget(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BrowserClawA11yPageError("browser_action_failed", "targetUrl is not a valid URL");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new BrowserClawA11yPageError("browser_action_failed", "targetUrl must be an HTTPS URL without credentials");
  }
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
}

function ensureDeadline(deadlineAt: number): void {
  if (!Number.isFinite(deadlineAt) || deadlineAt <= Date.now()) {
    throw new BrowserClawA11yPageError("browser_action_failed", "browser action deadline has elapsed");
  }
}

class OwnedBrowserClawA11yPage implements BrowserClawA11yPage {
  private latestSnapshot: BrowserClawA11ySnapshot | undefined;

  constructor(
    private readonly client: BrowserClawA11yClient,
    private readonly initialSessionRef: string,
    private readonly page: number,
    private readonly target: string,
    private readonly allowPathPrefix: string | undefined,
  ) {}

  async snapshot(deadlineAt: number): Promise<BrowserClawA11ySnapshot> {
    ensureDeadline(deadlineAt);
    await this.assertLease();
    const snapshot = await this.capture(() => this.client.snapshotPage(this.page));
    this.assertSnapshot(snapshot);
    this.latestSnapshot = snapshot;
    return snapshot;
  }

  async act(input: BrowserClawA11yActionInput, deadlineAt: number): Promise<BrowserClawA11ySnapshot> {
    ensureDeadline(deadlineAt);
    this.assertSession();
    if (!this.latestSnapshot) {
      throw new BrowserClawA11yError("stale_snapshot_ref", "semantic action requires a fresh page snapshot");
    }
    const action = validateBrowserClawSemanticAction(this.latestSnapshot, input).action;
    const snapshot = await this.capture(() => this.client.actPage(this.page, action));
    this.assertSnapshot(snapshot);
    this.latestSnapshot = snapshot;
    return snapshot;
  }

  private async assertLease(): Promise<void> {
    this.assertSession();
    const tabs = await this.capture(() => this.client.listTabs());
    const owned = tabs.find((tab) => tab.page === this.page && isValidPage(tab.page) && matchesTarget(tab.url, this.target, this.allowPathPrefix));
    if (!owned) {
      throw new BrowserClawA11yPageError("page_lease_lost", "owned target page disappeared, changed route, or became ambiguous");
    }
  }

  private assertSession(): void {
    if (this.client.sessionRef !== this.initialSessionRef) {
      throw new BrowserClawA11yPageError("page_lease_lost", "BrowserClaw MCP session changed");
    }
  }

  private assertSnapshot(snapshot: BrowserClawA11ySnapshot): void {
    if (snapshot.page !== this.page || !matchesTarget(snapshot.url, this.target, this.allowPathPrefix)) {
      throw new BrowserClawA11yPageError("page_lease_lost", "BrowserClaw action returned a different page or route");
    }
  }

  private async capture<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof BrowserClawA11yError || error instanceof BrowserClawA11yPageError) throw error;
      throw new BrowserClawA11yPageError("browser_action_failed", error instanceof Error ? error.message : "BrowserClaw operation failed");
    }
  }
}

function isValidPage(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function matchesTarget(url: string, target: string, allowPathPrefix?: string): boolean {
  try {
    if (allowPathPrefix !== undefined) {
      const candidate = new URL(url);
      const configured = new URL(target);
      return candidate.origin === configured.origin && candidate.pathname.startsWith(allowPathPrefix);
    }
    return normalizedTarget(url) === target;
  } catch {
    return false;
  }
}

/** Bind exactly one already-open BrowserClaw page. This function never opens or changes tabs. */
export function createBrowserClawA11yDriver(
  client: BrowserClawA11yClient,
  options: BrowserClawA11yDriverOptions,
): BrowserClawA11yDriver {
  const target = normalizedTarget(options.targetUrl);
  if (options.allowPathPrefix !== undefined && (!options.allowPathPrefix.startsWith("/") || options.allowPathPrefix.includes("?"))) {
    throw new BrowserClawA11yPageError("browser_action_failed", "allowPathPrefix must be an absolute path prefix");
  }
  return {
    async acquirePage(): Promise<BrowserClawA11yPage> {
      const sessionRef = client.sessionRef;
      const tabs = await client.listTabs();
      const matches = tabs.filter((tab) => isValidPage(tab.page) && matchesTarget(tab.url, target, options.allowPathPrefix));
      const selected = options.page === undefined ? (matches.length === 1 ? matches[0] : undefined) : matches.find((tab) => tab.page === options.page);
      if (!selected) {
        throw new BrowserClawA11yPageError("browser_action_failed", "expected exactly one target page in this BrowserClaw MCP session");
      }
      return new OwnedBrowserClawA11yPage(client, sessionRef, selected.page, target, options.allowPathPrefix);
    },
  };
}
