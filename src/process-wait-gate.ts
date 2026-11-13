import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { GptAdminTransport } from "./mesh/gptadmin.js";
import { unwrapResult } from "./mesh/protocol.js";

const execute = promisify(execFile);

export type ProcessWaitTarget = {
  harness: string;
  nativeSessionId: string;
  nodeRef?: string;
};

export type ProcessWaitDecision = {
  blocked: boolean;
  reason: string;
  sessionRefs?: string[];
  ruleRefs?: string[];
  observedAt?: string;
};

/** A read-only view of the canonical native authority, never another wait registry. */
export interface ProcessWaitSource {
  blocks(harness: string, sessionId: string, cwd?: string): Promise<boolean>;
}

type Options = {
  query?: (target: ProcessWaitTarget) => Promise<ProcessWaitDecision>;
  selector?: string;
  launcher?: string;
  nodeRef?: string;
  env?: NodeJS.ProcessEnv;
  /** Explicit canonical native MCP. It never uses fleet remapping or a local fallback. */
  authority?: string;
  transportFactory?: () => Promise<Pick<GptAdminTransport, "call"> | undefined>;
  now?: () => number;
};

async function privateBytes(filename: string): Promise<Buffer> {
  const info = await fs.lstat(filename);
  if (!path.isAbsolute(filename) || await fs.realpath(filename) !== filename
    || !info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.nlink !== 1) {
    throw new Error("untrusted process wait configuration");
  }
  if (info.size > 1024 * 1024) throw new Error("process wait configuration too large");
  return await fs.readFile(filename);
}

function unavailable(reason: string): ProcessWaitDecision {
  return { blocked: true, reason };
}

function validateDecision(value: unknown): ProcessWaitDecision {
  if (!value || typeof value !== "object") throw new Error("invalid process wait response");
  const decision = value as Record<string, unknown>;
  if (typeof decision.blocked !== "boolean" || typeof decision.reason !== "string"
    || !decision.reason || (decision.sessionRefs !== undefined && !Array.isArray(decision.sessionRefs))
    || (decision.ruleRefs !== undefined && !Array.isArray(decision.ruleRefs))) {
    throw new Error("invalid process wait response");
  }
  return decision as ProcessWaitDecision;
}


/** Reuse the approved GPTAdmin binding, never discover peers or mint a credential. */
function remoteTransport(options: Options, env: NodeJS.ProcessEnv): () => Promise<Pick<GptAdminTransport, "call"> | undefined> {
  if (options.transportFactory) return options.transportFactory;
  let current: { generation: string; transport: GptAdminTransport } | undefined;
  return async () => {
    const pin = env.AGENT_HERDER_FLEET_CREDENTIAL_PIN;
    if (!pin) return undefined;
    const { readFleetMeshBinding } = await import("./mesh/fleet-mesh-binding.js");
    const binding = await readFleetMeshBinding({
      configPath: env.AGENT_HERDER_FLEET_MESH_CONFIG, pin,
    });
    if (!binding) return undefined;
    if (current?.generation === binding.generation) return current.transport;
    const { FleetGptAdminTransport } = await import("./mesh/fleet-gptadmin-transport.js");
    const transport = new FleetGptAdminTransport({
      endpoint: binding.endpoint, headersProvider: () => ({ ...binding.headers }), readDeadlineMs: 5000,
    });
    current = { generation: binding.generation, transport };
    return transport;
  };
}

function authoritativeDecision(value: unknown, started: number, finished: number): ProcessWaitDecision {
  const result = unwrapResult(value);
  const decision = validateDecision(result);
  const observed = typeof result.observedAt === "string" ? Date.parse(result.observedAt) : NaN;
  if (result.version !== 1 || typeof result.configured !== "boolean"
    || typeof result.complete !== "boolean" || typeof result.mapped !== "boolean"
    || !Number.isFinite(observed) || observed < started - 5000 || observed > finished + 5000
    || !Array.isArray(result.sessionRefs) || !result.sessionRefs.every(item => typeof item === "string")
    || !Array.isArray(result.ruleRefs) || !result.ruleRefs.every(item => typeof item === "string")) {
    throw new Error("invalid canonical wait status");
  }
  if (!result.complete) return unavailable("process_wait_authority_incomplete");
  if (result.mapped === false && (result.sessionRefs.length !== 0 || result.ruleRefs.length !== 0)) {
    throw new Error("ambiguous canonical wait mapping");
  }
  return decision;
}

async function boundedRead<T>(read: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([read, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("process_wait_authority_deadline")), 5500);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** No negative-result cache: a newly armed wait must be visible to the next judge/send fence. */
export function createProcessWaitGate(options: Options = {}): ProcessWaitSource {
  const env = options.env ?? process.env;
  const explicitSelector = options.selector ?? env.AGENT_HERDER_PROCESS_WAIT_SELECTOR ?? env.HERDER_V1_ENTRY;
  const selector = explicitSelector ?? path.join(os.homedir(), ".config/agent-herder/gptadmin-entry.json");
  const launcher = options.launcher ?? env.AGENT_HERDER_PROCESS_WAIT_LAUNCHER
    ?? path.join(os.homedir(), ".local/bin/agent-herder-v1");
  const nodeRef = options.nodeRef ?? env.AGENT_HERDER_PROCESS_WAIT_NODE_REF;
  const authority = options.authority ?? env.AGENT_HERDER_PROCESS_WAIT_AUTHORITY;
  const explicitLocal = explicitSelector !== undefined || options.launcher !== undefined
    || env.AGENT_HERDER_PROCESS_WAIT_LAUNCHER !== undefined || nodeRef !== undefined;
  const clock = options.now ?? Date.now;
  const getTransport = remoteTransport(options, env);
  let observedConfiguration = false;

  const authorityQuery = async (target: ProcessWaitTarget): Promise<ProcessWaitDecision> => {
    if (typeof authority !== "string" || !/^mcp:shell:[A-Za-z0-9._-]+:AgentHerder$/.test(authority)) {
      return unavailable("process_wait_authority_invalid");
    }
    const started = clock();
    const transport = await boundedRead(getTransport());
    if (!transport) return unavailable("process_wait_authority_unavailable");
    const result = await boundedRead(transport.call(authority, "automation", {
      action: "wait_status", harness: target.harness, native_session_id: target.nativeSessionId,
      ...(target.nodeRef ? { node_ref: target.nodeRef } : {}),
    }));
    return authoritativeDecision(result, started, clock());
  };

  const installedQuery = async (target: ProcessWaitTarget): Promise<ProcessWaitDecision> => {
    let bytes: Buffer;
    try {
      bytes = await privateBytes(selector);
      observedConfiguration = true;
    } catch (error) {
      if (!explicitLocal && !observedConfiguration
        && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return { blocked: false, reason: "process_wait_unconfigured" };
      }
      return unavailable("process_wait_unavailable");
    }
    const selection = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    if (typeof selection.manifest !== "string" || typeof selection.manifest_sha256 !== "string") {
      return unavailable("process_wait_unavailable");
    }
    const manifestBytes = await privateBytes(selection.manifest);
    if (createHash("sha256").update(manifestBytes).digest("hex") !== selection.manifest_sha256) {
      return unavailable("process_wait_unavailable");
    }
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as Record<string, unknown>;
    if (manifest.process_config === undefined) {
      return { blocked: false, reason: "process_wait_unconfigured" };
    }
    if (typeof manifest.process_wait_reader !== "string") {
      return unavailable("process_wait_reader_unavailable");
    }
    // Only the trusted installed launcher chooses a manifest/profile. Request data
    // contains native identity only and never a command, database or config path.
    await privateBytes(launcher);
    const completed = await execute(launcher, ["--process-wait-status", JSON.stringify(target)], {
      env: { ...env, HERDER_V1_ENTRY: selector },
      timeout: 5000, maxBuffer: 64 * 1024, encoding: "utf8", windowsHide: true,
    });
    return validateDecision(JSON.parse(completed.stdout));
  };

  const query = options.query ?? (authority !== undefined ? authorityQuery : installedQuery);
  return {
    async blocks(harness, sessionId) {
      try {
        const decision = validateDecision(await query({
          harness, nativeSessionId: sessionId, ...(nodeRef ? { nodeRef } : {}),
        }));
        return decision.blocked;
      } catch {
        return true;
      }
    },
  };
}

const installedProcessWaits = createProcessWaitGate();

/** A failed canonical read is a deferral, including for injected gate providers. */
export async function processWaitBlocks(
  source: ProcessWaitSource | undefined, harness: string, sessionId: string, cwd?: string,
): Promise<boolean> {
  try {
    return await (source ?? installedProcessWaits).blocks(harness, sessionId, cwd);
  } catch {
    return true;
  }
}