import { createHash } from "node:crypto";

/**
 * The contract of the shared core.
 *
 * Agent Herder pins this hash. Any change to the core's capability surface or
 * entrypoints changes the hash, which fails the Herder side until Herder is
 * rebuilt and re-pins it. That is what makes "ship a core change without the
 * dependent side" impossible.
 */
export const CORE_VERSION = "0.2.2";

export type CoreCapability =
  | "harness.protocol.opencode"
  | "harness.protocol.codex"
  | "harness.protocol.claude"
  | "harness.session-enumeration"
  | "harness.session-identity"
  | "harness.marker-search"
  | "resume.delivery"
  | "resume.receipts"
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
  "harness.session-identity",
  "harness.marker-search",
  "resume.delivery",
  "resume.receipts",
  "integration.hermes",
];

export const CORE_ENTRYPOINTS: readonly CoreEntrypoint[] = [
  { kind: "cli", command: "contract", purpose: "Print the machine-readable core contract used by the dependent build." },
  { kind: "cli", command: "config", purpose: "Print the effective state directory, default agent and core identity." },
  { kind: "cli", command: "find", purpose: "Find a native session by cwd, query or marker." },
  { kind: "cli", command: "command", purpose: "Print the command that would resume one bound session." },
  { kind: "cli", command: "resume", purpose: "Retired compatibility command; use the Agent Herder native resume transport." },
  { kind: "cli", command: "receipt", purpose: "Read the durable admission receipt for one idempotency key." },
  { kind: "cli", command: "job", purpose: "Retired compatibility alias; execution status belongs to Agent Herder." },
  { kind: "cli", command: "mcp", purpose: "Serve compatibility reads and explicit Herder facade aliases over stdio." },
  { kind: "mcp", tool: "get_resume_receipt", purpose: "Read the durable admission receipt for one idempotency key." },
  { kind: "mcp", tool: "query_resume_receipt", purpose: "Read the durable admission receipt for one idempotency key." },
  { kind: "mcp", tool: "get_config", purpose: "Read the effective core configuration and resolved endpoints." },
  { kind: "mcp", tool: "find_sessions", purpose: "Find candidate sessions by cwd, query or marker." },
  { kind: "mcp", tool: "build_resume_command", purpose: "Print the command that resumes one bound session." },
  { kind: "mcp", tool: "resume_bound_target", purpose: "Delegate to an explicit Herder facade or return a standalone retirement error." },
  { kind: "mcp", tool: "run_and_resume", purpose: "Delegate supervised execution to an explicit Herder facade or return a retirement error." },
  { kind: "mcp", tool: "attach_pid_and_resume", purpose: "Delegate exact process attachment to an explicit Herder facade or return a retirement error." },
  { kind: "mcp", tool: "attach_query_and_resume", purpose: "Retired process-query alias; Herder requires exact execution identity." },
  { kind: "mcp", tool: "wait_and_resume", purpose: "Delegate waiting to an explicit Herder facade or return a retirement error." },
  { kind: "mcp", tool: "wait_job_status", purpose: "Retired compatibility alias; execution status belongs to Agent Herder." },
  { kind: "library", symbol: "OpenCodeClient", purpose: "Native OpenCode protocol client owned by the core." },
  { kind: "library", symbol: "OpenCodeClient.announceIdentity", purpose: "Let a session learn its own name, id and workspace natively." },
  { kind: "library", symbol: "searchSessions", purpose: "Marker-first session discovery across every supported store." },
  { kind: "library", symbol: "JobRegistry", purpose: "Deprecated compatibility helper, never instantiated by product entrypoints." },
  { kind: "library", symbol: "HermesWakeClient", purpose: "Wake exactly one bound Hermes session through its authenticated seam." },
  { kind: "library", symbol: "createResumeMcpServer", purpose: "Compatibility reads and retired aliases without a local scheduler." },
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