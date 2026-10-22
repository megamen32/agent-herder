import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The applied revision of the policy of the launch, as the fleet sees it.
 *
 * The owner saves the policy of the launch and every node of the fleet holds
 * a copy of it. The version the owner saved is the desired revision; the
 * version a node holds is its applied revision. A node that holds a different
 * version is not synchronized, and the fleet answer says so without reading
 * the file of that node.
 *
 * The revision a node reports is the etag of the document it holds now: the
 * document is read at the moment of the answer, and no copy of it is kept.
 */

/** The state of one node with respect to the desired revision. */
export type FleetPolicyNodeStatus = "synchronized" | "diverged" | "unconfirmed";

/** What one node says about the policy it holds. */
export interface FleetPolicyNodeAnswer {
  /** The state of the document on the node. */
  kind: "valid" | "absent" | "invalid";
  /** The etag of the document the node holds. */
  appliedRevision: string;
}

/** The state of one node in the summary of the fleet. */
export interface FleetPolicyNodeResult {
  hostId: string;
  status: FleetPolicyNodeStatus;
  /** The version the node holds now, when it said so. */
  appliedRevision?: string;
  /** The version the owner wants. */
  desiredRevision: string;
  /** What the node held the last time it answered. */
  lastKnown?: { appliedRevision: string; at: string };
  reason?: string;
}

/** The summary of the fleet about the policy of the launch. */
export interface FleetPolicyRevisionSummary {
  ok: boolean;
  /** The version the owner wants for the scope. */
  desiredRevision: string;
  nodes: FleetPolicyNodeResult[];
  /**
   * Whether every node of the fleet holds the desired version.
   *
   * A node that did not answer keeps the answer unknown, so it is never
   * synchronized, and a node that holds another version is never
   * synchronized either.
   */
  synchronized: boolean;
  /** The nodes that hold a version of their own. */
  diverged: string[];
  /** The nodes that did not confirm: their state is unknown, not agreed. */
  unconfirmed: string[];
}

/** The transport that asks a node of the fleet. */
export interface FleetPolicyRevisionTransport {
  call(target: string, tool: string, args: Record<string, unknown>): Promise<unknown>;
}

/** One peer of the fleet. */
export interface FleetPolicyRevisionPeer {
  hostId: string;
  /** The address of the node: host and harness of the runtime. */
  target: string;
}

export interface FleetPolicyRevisionOptions {
  transport: FleetPolicyRevisionTransport;
  peers: readonly FleetPolicyRevisionPeer[];
  /** The version the owner wants for the scope. */
  desiredRevision: string;
  /** The local node: what it holds right now. */
  local?: { hostId: string; answer: FleetPolicyNodeAnswer };
  /** Where the last confirmation of every node is kept. */
  ledgerPath?: string;
  now?: () => Date;
}

interface LedgerEntry {
  appliedRevision: string;
  at: string;
}

/** The last confirmation of every node, as the file keeps it. */
async function readLedger(path: string | undefined): Promise<Record<string, LedgerEntry>> {
  if (!path) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const entries: Record<string, LedgerEntry> = {};
    for (const [hostId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as Partial<LedgerEntry>;
      if (typeof entry.appliedRevision === "string" && typeof entry.at === "string") {
        entries[hostId] = { appliedRevision: entry.appliedRevision, at: entry.at };
      }
    }
    return entries;
  } catch {
    // A ledger that cannot be read is an empty ledger: the nodes that do not
    // answer are unknown, and unknown is not agreement.
    return {};
  }
}

/** Keep the last confirmation of every node, so an answer that fails still leaves a trace. */
async function writeLedger(path: string | undefined, ledger: Record<string, LedgerEntry>): Promise<void> {
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
    renameSync(temporary, path);
  } catch {
    // The ledger is a convenience for the operator: a node that cannot be
    // written down is still unknown, and unknown is not agreement.
  }
}

/** The answer of the node, as the tool returned it. */
function readAnswer(value: unknown): FleetPolicyNodeAnswer | undefined {
  if (!value || typeof value !== "object") return undefined;
  const payload = (value as { structuredContent?: unknown }).structuredContent ?? value;
  if (!payload || typeof payload !== "object") return undefined;
  const policy = (payload as { launchPolicy?: unknown }).launchPolicy;
  if (!policy || typeof policy !== "object") return undefined;
  const kind = (policy as { kind?: unknown }).kind;
  const appliedRevision = (policy as { appliedRevision?: unknown }).appliedRevision;
  if (kind !== "valid" && kind !== "absent" && kind !== "invalid") return undefined;
  if (typeof appliedRevision !== "string" || appliedRevision.length === 0) return undefined;
  return { kind, appliedRevision };
}

/** The state of one node with respect to the desired version. */
function classify(
  hostId: string,
  answer: FleetPolicyNodeAnswer,
  desiredRevision: string,
): FleetPolicyNodeResult {
  if (answer.kind === "invalid") {
    // The node answered, but the document it holds cannot be read, so the
    // version it holds is unknown. Unknown is not agreement.
    return {
      hostId,
      status: "unconfirmed",
      desiredRevision,
      appliedRevision: answer.appliedRevision,
      reason: "Политика на ноде не читается: версию, которую она держит, подтвердить нельзя.",
    };
  }
  if (answer.appliedRevision === desiredRevision) {
    return { hostId, status: "synchronized", appliedRevision: answer.appliedRevision, desiredRevision };
  }
  if (answer.kind === "absent") {
    // The node holds no document at all. That is not a policy that was
    // applied, and it is not agreement either: the versions are named.
    return {
      hostId,
      status: "diverged",
      appliedRevision: answer.appliedRevision,
      desiredRevision,
      reason: `У ноды нет документа политики, а задана версия ${desiredRevision}.`,
    };
  }
  return {
    hostId,
    status: "diverged",
    appliedRevision: answer.appliedRevision,
    desiredRevision,
    reason: `Нода держит другую версию политики (${answer.appliedRevision}), а задана ${desiredRevision}.`,
  };
}

/**
 * Read the applied revision of the policy of the launch on every node.
 *
 * The desired version is the one the owner saved; every node is asked what it
 * holds now. A node that holds the same version is synchronized, a node that
 * holds another one is diverged and the versions are named, and a node that
 * did not answer is unconfirmed with the last confirmation that is known.
 */
export async function readFleetPolicyRevisions(
  options: FleetPolicyRevisionOptions,
): Promise<FleetPolicyRevisionSummary> {
  const now = options.now ?? (() => new Date());
  const ledger = await readLedger(options.ledgerPath);
  const nodes: FleetPolicyNodeResult[] = [];
  if (options.local) {
    nodes.push(classify(options.local.hostId, options.local.answer, options.desiredRevision));
  }
  const answers = await Promise.all(options.peers.map(async (peer) => {
    try {
      const answer = readAnswer(await options.transport.call(peer.target, "fleet_node_info", {}));
      if (!answer) {
        return {
          hostId: peer.hostId,
          status: "unconfirmed" as const,
          desiredRevision: options.desiredRevision,
          lastKnown: ledger[peer.hostId],
          reason: "Нода не отдала свою версию политики.",
        };
      }
      ledger[peer.hostId] = { appliedRevision: answer.appliedRevision, at: now().toISOString() };
      return classify(peer.hostId, answer, options.desiredRevision);
    } catch (error) {
      return {
        hostId: peer.hostId,
        status: "unconfirmed" as const,
        desiredRevision: options.desiredRevision,
        lastKnown: ledger[peer.hostId],
        reason: (error as Error).message,
      };
    }
  }));
  nodes.push(...answers);
  await writeLedger(options.ledgerPath, ledger);
  const diverged = nodes.filter((node) => node.status === "diverged").map((node) => node.hostId);
  const unconfirmed = nodes.filter((node) => node.status === "unconfirmed").map((node) => node.hostId);
  return {
    ok: true,
    desiredRevision: options.desiredRevision,
    nodes,
    synchronized: diverged.length === 0 && unconfirmed.length === 0,
    diverged,
    unconfirmed,
  };
}

/** The path of the ledger of the last confirmations, beside the policy of the launch. */
export function fleetPolicyRevisionLedgerPath(stateDir: string): string {
  return join(stateDir, "fleet-policy-revisions.json");
}
