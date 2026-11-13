import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

/** This marker is installed only by a reviewed, drained authority cutover. */
export interface CanonicalReleaseAuthority {
  version: 1;
  config: string;
  bridge: string;
  seal_id: string;
}

function containsLease(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsLease);
  return Object.entries(value).some(([key, nested]) => key === "lease" || containsLease(nested));
}

export function canonicalAuthority(state: unknown): CanonicalReleaseAuthority | undefined {
  const value = state as { version?: unknown; canonical?: CanonicalReleaseAuthority; projects?: Record<string, { lease?: unknown }> };
  if (value?.version === 1) {
    if ("canonical" in value) throw new Error("release_canonical_seal_invalid");
    return undefined;
  }
  const marker = value?.canonical;
  if (value?.version !== 2 || !marker || marker.version !== 1
      || typeof marker.config !== "string" || !isAbsolute(marker.config)
      || typeof marker.bridge !== "string" || !isAbsolute(marker.bridge)
      || typeof marker.seal_id !== "string" || !marker.seal_id
      || !value.projects || typeof value.projects !== "object" || Array.isArray(value.projects)
      || Object.values(value.projects).some(project => !project || typeof project !== "object" || Array.isArray(project))
      || containsLease(value))
    throw new Error("release_canonical_seal_invalid");
  return marker;
}

export async function readCanonicalAuthority(file: string): Promise<CanonicalReleaseAuthority | undefined> {
  try { return canonicalAuthority(JSON.parse(await readFile(file, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Tokens travel only in stdin. Neither spawn errors nor stderr echo capabilities. */
class BridgeSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly reader;
  private readonly lines: AsyncIterator<string>;
  private readonly spawnFailure: Promise<never>;
  constructor(authority: CanonicalReleaseAuthority) {
    this.child = spawn(authority.bridge, ["--config", authority.config], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.resume();
    this.child.stdin.on("error", () => {});
    this.reader = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.lines = this.reader[Symbol.asyncIterator]();
    this.spawnFailure = new Promise((_, reject) => this.child.once("error", () => reject(new Error("release_canonical_bridge_unavailable"))));
  }
  async call<T>(request: object): Promise<T> {
    this.child.stdin.write(JSON.stringify(request) + "\n");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const next = await Promise.race([
        this.lines.next(), this.spawnFailure,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("release_canonical_bridge_timeout")), 10_000); }),
      ]);
      if (next.done || next.value.length > 1024 * 1024) throw new Error("release_canonical_bridge_invalid_response");
      let response: { ok?: boolean; result?: T; error?: string };
      try { response = JSON.parse(next.value); } catch { throw new Error("release_canonical_bridge_invalid_response"); }
      if (response.ok !== true) throw new Error(typeof response.error === "string" && /^[a-z0-9_.:-]{1,160}$/.test(response.error)
        ? response.error : "release_canonical_bridge_rejected");
      if (!("result" in response)) throw new Error("release_canonical_bridge_invalid_response");
      return response.result as T;
    } finally { if (timer) clearTimeout(timer); }
  }
  close() {
    this.child.stdin.end();
    this.reader.close();
    // An unfinished guard observes EOF and retains durable UNKNOWN occupancy.
    const timer = setTimeout(() => this.child.kill("SIGTERM"), 1000);
    timer.unref();
    this.child.once("exit", () => clearTimeout(timer));
  }
}

export async function canonicalCall<T>(authority: CanonicalReleaseAuthority, request: object): Promise<T> {
  const session = new BridgeSession(authority);
  try { return await session.call<T>(request); } finally { session.close(); }
}

export async function withCanonicalGuard<T>(authority: CanonicalReleaseAuthority, request: object, effect: () => Promise<T>): Promise<T> {
  const session = new BridgeSession(authority);
  try {
    const acquired = await session.call<{ guarded: boolean }>({ ...request, action: "guard" });
    if (!acquired.guarded) throw new Error("release_canonical_guard_not_acquired");
    const result = await effect();
    await session.call({ action: "finished" });
    return result;
  } finally { session.close(); }
}
