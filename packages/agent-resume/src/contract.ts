import { createHash } from "node:crypto";

/**
 * The contract of the shared core.
 *
 * Agent Herder pins this hash. Any change to the core's capability surface or
 * entrypoints changes the hash, which fails the Herder side until Herder is
 * rebuilt and re-pins it — that is what makes "ship a core change without the
 * dependent side" impossible.
 */
export const CORE_VERSION = "0.2.2";

export type CoreCapability =
  | "harness.protocol.opencode"
  | "harness.protocol.codex"
  | "harness.protocol.claude"
  | "harness.session-enumeration"
  | "harness.marker-search"
  | "resume.delivery"
  | "resume.receipts"
  | "resume.detached-jobs"
  | "integration.hermes";

export type CoreEntrypoint =
  | { kind: "cli"; command: string; purpose: string }
  | { kind: "mcp"; tool: string; purpose: string }
  | { kind: "library"; symbol: string; purpose: string };

export interface CoreContract {
  readonly name: "agent-resume-core";
  readonly version: string;
  readonly capabilities: readonly CoreCapability[];
  readonly entrypoints: readonly CoreEntrypoint[];
}

/** Capabilities this core owns. Anything not listed here belongs to Herder. */
export const CORE_CAPABILITIES: readonly CoreCapability[] = [
  "harness.protocol.opencode",
  "harness.protocol.codex",
  "harness.protocol.claude",
  "harness.session-enumeration",
  "harness.marker-search",
  "resume.delivery",
  "resume.receipts",
  "resume.detached-jobs",
  "integration.hermes",
];

export const CORE_ENTRYPOINTS: readonly CoreEntrypoint[] = [
  { kind: "cli", command: "contract", purpose: "Print the machine-readable core contract used by the dependent build." },
  { kind: "cli", command: "config", purpose: "Print the effective state directory, default agent and core identity." },
  { kind: "cli", command: "find", purpose: "Find a native session by cwd, query or marker." },
  { kind: "cli", command: "command", purpose: "Print the command that would resume one bound session." },
  { kind: "cli", command: "resume", purpose: "Resume one native session with a goal, optionally detached." },
  { kind: "cli", command: "receipt", purpose: "Read the durable admission receipt for one idempotency key." },
  { kind: "cli", command: "job", purpose: "Read the state and liveness of one background watch job." },
  { kind: "cli", command: "mcp", purpose: "Serve the standalone MCP surface over stdio." },
  { kind: "mcp", tool: "get_resume_receipt", purpose: "Read the durable admission receipt for one idempotency key." },
  { kind: "mcp", tool: "query_resume_receipt", purpose: "Read the durable admission receipt for one idempotency key." },
  { kind: "mcp", tool: "get_config", purpose: "Read the effective core configuration and resolved endpoints." },
  { kind: "mcp", tool: "find_sessions", purpose: "Find candidate sessions by cwd, query or marker." },
  { kind: "mcp", tool: "build_resume_command", purpose: "Print the command that resumes one bound session." },
  { kind: "mcp", tool: "resume_bound_target", purpose: "Admit one goal into one already-selected target, exactly once." },
  { kind: "mcp", tool: "run_and_resume", purpose: "Watch a background command and admit one resume when it ends." },
  { kind: "mcp", tool: "attach_pid_and_resume", purpose: "Watch a pid and admit one resume when it exits." },
  { kind: "mcp", tool: "attach_query_and_resume", purpose: "Find a process by command substring, watch it and admit one resume." },
  { kind: "mcp", tool: "wait_and_resume", purpose: "Wait a fixed duration and admit one resume." },
  { kind: "mcp", tool: "wait_job_status", purpose: "Read the state and liveness of one background watch job." },
  { kind: "library", symbol: "OpenCodeClient", purpose: "Native OpenCode protocol client owned by the core." },
  { kind: "library", symbol: "searchSessions", purpose: "Marker-first session discovery across every supported store." },
  { kind: "library", symbol: "JobRegistry", purpose: "Durable records and liveness for long background work." },
  { kind: "library", symbol: "HermesWakeClient", purpose: "Wake exactly one bound Hermes session through its authenticated seam." },
  { kind: "library", symbol: "createResumeMcpServer", purpose: "The standalone MCP surface, built from this same source." },
  { kind: "library", symbol: "coreContractHash", purpose: "Stable hash Herder pins to detect an unshipped core change." },
];

export const CORE_CONTRACT: CoreContract = {
  name: "agent-resume-core",
  version: CORE_VERSION,
  capabilities: CORE_CAPABILITIES,
  entrypoints: CORE_ENTRYPOINTS,
};

/** Deterministic hash: field order is fixed by construction, not by object shape. */
export function coreContractHash(contract: CoreContract = CORE_CONTRACT): string {
  const canonical = JSON.stringify({
    name: contract.name,
    version: contract.version,
    capabilities: [...contract.capabilities].sort(),
    entrypoints: [...contract.entrypoints]
      .map((entry) => ({ kind: entry.kind, name: entry.kind === "library" ? entry.symbol : entry.kind === "mcp" ? entry.tool : entry.command, purpose: entry.purpose }))
      .sort((left, right) => `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`)),
  });
  return createHash("sha256").update(canonical).digest("hex");
}