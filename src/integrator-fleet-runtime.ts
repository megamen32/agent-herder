import { hostname, homedir } from "node:os";
import { resolve } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { AutomationLaunchPolicyStore, canonicalProjectKey, type AutomationLaunchPolicyDocument } from "./automation-launch-policy.js";
import { CodexAppServerAdapter } from "./adapters/codex-app-server.js";
import {
  CODEX_PROJECT_MODEL_ID,
  codexProjectPolicyRevision,
  createCodexProjectRuntimePolicy,
  restoreCodexProjectRuntimePolicy,
  type CodexProjectRuntimePolicy,
} from "./project-runtime-policy.js";
import type { ProjectExecutionBinding, TrustedRuntimeOwnerResolver } from "./project-execution-scope.js";
import { IntegratorSessionBindingStore, type IntegratorNativeAddress, type IntegratorOperationBinding } from "./integrator-session-binding.js";
import type { FleetCreateReceipt } from "./mesh/fleet-contract.js";

export interface IntegratorFleetCreateInput {
  project: string;
  inputId: string;
  name: string;
  /** A supplied cwd is a consistency check only; the saved route is authoritative. */
  cwd?: string;
  model?: string;
  projectReadinessContract?: "integrator-host-readiness-v1";
  projectReadiness?: IntegratorProjectReadinessSnapshot;
}

export interface IntegratorProjectReadinessSnapshot {
  state?: "ready";
  projectId: string;
  projectRoot: string;
  rootIdentity: string;
  policyRevision: string;
  hostId: string;
  harness: "codex";
  harnessVersion: string;
  model: typeof CODEX_PROJECT_MODEL_ID;
  requiredTools: readonly string[];
  availableTools: readonly string[];
  availableModels: readonly string[];
  resourceReady: boolean;
  runtimeInstanceId: string;
  cwd: string;
  pathResolution: {
    requestedCwd: string;
    canonicalCwd: string;
    rootPath: string;
    contained: boolean;
    identityMatches: boolean;
  };
  observedAtMs: number;
}

const PROJECT_READINESS_MAX_CLOCK_SKEW_MS = 30_000;
const PROJECT_READINESS_MAX_AGE_MS = 30_000;

export type IntegratorProjectReadiness = Omit<IntegratorProjectReadinessSnapshot, "state"> & {
  state: "ready" | "not_ready";
  reason?: string;
};

export type IntegratorSessionAdapterResolution =
  | { kind: "ordinary" }
  | { kind: "scoped"; adapter: CodexAppServerAdapter }
  | { kind: "deny"; reason: string };
type ScopedResolution = Exclude<IntegratorSessionAdapterResolution, { kind: "ordinary" }>;

type ConfiguredProject = { rootPath: string; model: typeof CODEX_PROJECT_MODEL_ID; etag: string; nativeWebSearch?: "live" };
type ScopedSession = { adapter: CodexAppServerAdapter; owner: TrustedRuntimeOwnerResolver; project: ConfiguredProject; operationId: string };
type ScopedFactory = (input: Parameters<typeof CodexAppServerAdapter.createProjectScoped>[0]) => Promise<CodexAppServerAdapter>;

export interface IntegratorFleetRuntimeOptions {
  policyStore: Pick<AutomationLaunchPolicyStore, "readDocument">;
  bindingStore: IntegratorSessionBindingStore;
  hostId?: string;
  codexBin?: string;
  codexDataHome?: string;
  transcriptDataHome?: string;
  createPolicy?: typeof createCodexProjectRuntimePolicy;
  restorePolicy?: typeof restoreCodexProjectRuntimePolicy;
  createScopedAdapter?: ScopedFactory;
}

/** Connects one explicitly routed Codex project to the existing H32/H34 owner APIs. */
export class IntegratorFleetRuntime {
  private readonly hostId: string;
  private readonly codexDataHome: string;
  private readonly transcriptDataHome: string;
  private readonly sessions = new Map<string, ScopedSession>();
  private readonly inFlight = new Map<string, Promise<FleetCreateReceipt>>();
  private readonly createPolicy: typeof createCodexProjectRuntimePolicy;
  private readonly restorePolicy: typeof restoreCodexProjectRuntimePolicy;
  private readonly createScopedAdapter: ScopedFactory;

  constructor(private readonly options: IntegratorFleetRuntimeOptions) {
    this.hostId = options.hostId ?? hostname();
    this.codexDataHome = resolve(options.codexDataHome ?? process.env.CODEX_HOME ?? `${homedir()}/.codex`);
    this.transcriptDataHome = resolve(options.transcriptDataHome ?? process.env.CODEX_DATA_DIR ?? this.codexDataHome);
    this.createPolicy = options.createPolicy ?? createCodexProjectRuntimePolicy;
    this.restorePolicy = options.restorePolicy ?? restoreCodexProjectRuntimePolicy;
    this.createScopedAdapter = options.createScopedAdapter ?? (config => CodexAppServerAdapter.createProjectScoped(config));
  }

  async create(input: IntegratorFleetCreateInput): Promise<FleetCreateReceipt> {
    if (!/^[a-f0-9]{64}$/.test(input.inputId) || !input.name.trim()) {
      return this.notAttempted(input.inputId, "project_input_invalid");
    }
    const configured = await this.resolveConfiguredProject(input.project);
    if (!configured.ok) return this.notAttempted(input.inputId, configured.reason);
    if (input.model && input.model !== configured.project.model) {
      return this.notAttempted(input.inputId, "project_route_conflict");
    }
    const live = [...this.sessions.entries()].find(([, session]) => session.operationId === input.inputId);
    if (live) {
      const lookup = await this.options.bindingStore.get(input.inputId).catch(() => null);
      const attempt = lookup?.attempts.at(-1);
      const address = attempt?.address;
      const scope = attempt?.scope;
      let currentRootIdentity: string | undefined;
      try {
        const root = await realpath(configured.project.rootPath);
        const details = await stat(root);
        if (root === configured.project.rootPath && details.isDirectory()) {
          currentRootIdentity = JSON.stringify([root, details.dev, details.ino]);
        }
      } catch { /* A changed or missing configured root cannot reuse this receipt. */ }
      if (lookup?.state === "accepted" && lookup.harness === "codex" && attempt?.state === "accepted"
        && attempt.receipt?.state === "created" && address?.hostId === this.hostId && address.harness === "codex"
        && scope?.hostId === this.hostId && scope.harness === "codex"
        && scope.projectId === configured.project.rootPath && scope.canonicalRoot.path === configured.project.rootPath
        && scope.policyRevision === codexProjectPolicyRevision(configured.project.nativeWebSearch) && scope.rootIdentity === currentRootIdentity) {
        return this.createdReceipt(input, address!, configured.project);
      }
      return { state: "not_attempted", inputId: input.inputId, retryable: false, reason: "project_operation_conflict" };
    }
    let existing: IntegratorOperationBinding | null;
    try { existing = await this.options.bindingStore.get(input.inputId); }
    catch { return { state: "unknown", inputId: input.inputId, retryable: false, reason: "project_binding_store_unavailable" }; }
    if (existing) {
      if (existing.harness !== "codex" || existing.state !== "accepted") {
        return { state: "unknown", inputId: input.inputId, retryable: false, reason: "project_operation_unresolved" };
      }
      const address = existing.attempts.at(-1)?.address;
      if (!address) return { state: "unknown", inputId: input.inputId, retryable: false, reason: "project_receipt_missing_address" };
      const restored = await this.restoreAccepted(existing.operationId, address, configured.project);
      return restored.kind === "scoped"
        ? this.createdReceipt(input, address, configured.project)
        : { state: "unknown", inputId: input.inputId, retryable: false, reason: restored.reason };
    }
    if (input.projectReadinessContract !== "integrator-host-readiness-v1"
      || !validReadiness(input.projectReadiness, input, configured.project, this.hostId)
      || !await this.validateReadiness(input)) {
      return this.notAttempted(input.inputId, "project_readiness_contract_missing_or_stale");
    }
    const previous = this.inFlight.get(input.inputId);
    if (previous) return previous;
    const operation = this.createFirst(input, configured.project).finally(() => this.inFlight.delete(input.inputId));
    this.inFlight.set(input.inputId, operation);
    return operation;
  }

  /** Project-specific host capability readback. It starts only the scoped app-server and disposes it. */
  async readiness(projectId: string): Promise<IntegratorProjectReadiness> {
    const notReady = (reason: string): IntegratorProjectReadiness => ({
      state: "not_ready", reason, projectId, projectRoot: "", rootIdentity: "", policyRevision: "",
      hostId: this.hostId, harness: "codex", harnessVersion: "", model: CODEX_PROJECT_MODEL_ID,
      requiredTools: [], availableTools: [], availableModels: [], resourceReady: false,
      runtimeInstanceId: "", cwd: "", observedAtMs: Date.now(),
      pathResolution: { requestedCwd: "", canonicalCwd: "", rootPath: "", contained: false, identityMatches: false },
    });
    const configured = await this.resolveConfiguredProject(projectId);
    if (!configured.ok) return notReady(configured.reason);
    let adapter: CodexAppServerAdapter | undefined;
    try {
      const policy = await this.createPolicy({
        projectId: configured.project.rootPath,
        projectRoot: configured.project.rootPath,
        materialized: false,
        nativeWebSearchMode: configured.project.nativeWebSearch,
      });
      adapter = await this.createScopedAdapter({
        policy, codexBin: this.options.codexBin, cwd: configured.project.rootPath,
        codexDir: this.transcriptDataHome, integratorSessionBindingStore: this.options.bindingStore,
      });
      const evidence = await adapter.readProjectReadinessEvidence();
      const root = await realpath(configured.project.rootPath);
      const rootStat = await stat(root);
      const rootIdentity = JSON.stringify([root, rootStat.dev, rootStat.ino]);
      const harnessVersion = evidence.harnessVersion;
      const requiredTools = configured.project.nativeWebSearch === "live" ? ["web_search"] : [];
      const availableTools = evidence.nativeWebSearch.complete && evidence.nativeWebSearch.mode === "live"
        ? ["web_search"] : [];
      const resourceReady = root === configured.project.rootPath && rootStat.isDirectory()
        && evidence.isolated && !!harnessVersion && evidence.availableModels.includes(CODEX_PROJECT_MODEL_ID)
        && requiredTools.every(tool => availableTools.includes(tool));
      const pathResolution = {
        requestedCwd: root, canonicalCwd: root, rootPath: root,
        contained: root === configured.project.rootPath,
        identityMatches: rootIdentity === policy.binding.rootIdentity,
      };
      return {
        state: resourceReady ? "ready" : "not_ready",
        ...(resourceReady ? {} : { reason: "project_host_capability_unavailable" }),
        projectId, projectRoot: root, rootIdentity, policyRevision: configured.project.etag,
        hostId: this.hostId, harness: "codex", harnessVersion: harnessVersion ?? "",
        model: CODEX_PROJECT_MODEL_ID, requiredTools, availableTools,
        availableModels: evidence.availableModels, resourceReady,
        runtimeInstanceId: policy.binding.runtimeInstanceId, cwd: root, pathResolution, observedAtMs: Date.now(),
      };
    } catch {
      return notReady("project_host_readiness_unavailable");
    } finally {
      await adapter?.dispose().catch(() => undefined);
    }
  }

  async validateReadiness(input: IntegratorFleetCreateInput): Promise<boolean> {
    if (input.projectReadinessContract !== "integrator-host-readiness-v1" || !input.projectReadiness) return false;
    const configured = await this.resolveConfiguredProject(input.project);
    if (!configured.ok || !validReadiness(input.projectReadiness, input, configured.project, this.hostId)) return false;
    try {
      const root = await realpath(configured.project.rootPath);
      const details = await stat(root);
      return root === configured.project.rootPath && details.isDirectory()
        && JSON.stringify([root, details.dev, details.ino]) === input.projectReadiness.rootIdentity;
    } catch { return false; }
  }

  /** Resolve one exact native address for Fleet/session-tools; unresolved scoped rows never fall through. */
  async adapterForSession(address: IntegratorNativeAddress): Promise<IntegratorSessionAdapterResolution> {
    const lookup = await this.options.bindingStore.findByNativeAddress(address).catch(() => null);
    if (!lookup) return { kind: "deny", reason: "project_binding_store_unavailable" };
    if (lookup.state === "not_found") return { kind: "ordinary" };
    if (lookup.state !== "accepted") return { kind: "deny", reason: lookup.reason };
    if (lookup.attempt.hostId !== this.hostId || address.harness !== "codex") {
      return { kind: "deny", reason: "project_session_host_or_harness_mismatch" };
    }
    const configured = await this.resolveConfiguredProject(lookup.attempt.scope!.projectId);
    if (!configured.ok || configured.project.rootPath !== lookup.attempt.scope!.canonicalRoot.path
      || lookup.attempt.scope!.rootIdentity !== JSON.stringify([
        lookup.attempt.scope!.canonicalRoot.path,
        lookup.attempt.scope!.canonicalRoot.device,
        lookup.attempt.scope!.canonicalRoot.inode,
      ]) || lookup.attempt.scope!.policyRevision !== codexProjectPolicyRevision(configured.project.nativeWebSearch)) {
      return { kind: "deny", reason: "project_session_current_route_mismatch" };
    }
    const key = addressKey(address);
    const current = this.sessions.get(key);
    if (current) {
      const evidence = await current.adapter.resolveCurrentProjectScope({
        projectId: configured.project.rootPath,
        rootIdentity: lookup.attempt.scope!.rootIdentity,
        policyRevision: lookup.attempt.scope!.policyRevision,
        hostId: address.hostId,
        harness: "codex",
      }).catch(() => null);
      return evidence && await trusted(current.owner, evidence.binding) ? { kind: "scoped", adapter: current.adapter }
        : { kind: "deny", reason: "project_session_scope_changed" };
    }
    return this.restoreAccepted(lookup.binding.operationId, address, configured.project);
  }

  async dispose(): Promise<void> {
    const adapters = [...new Set([...this.sessions.values()].map(value => value.adapter))];
    this.sessions.clear();
    await Promise.all(adapters.map(adapter => adapter.dispose().catch(() => undefined)));
  }

  private async createFirst(input: IntegratorFleetCreateInput, project: ConfiguredProject): Promise<FleetCreateReceipt> {
    let adapter: CodexAppServerAdapter | undefined;
    try {
      const initial = await this.createPolicy({ projectId: project.rootPath, projectRoot: project.rootPath, materialized: true,
        nativeWebSearchMode: project.nativeWebSearch });
      const policy = withOperationId(initial, input.inputId);
      const owner = this.runtimeOwner(project, policy.binding);
      adapter = await this.createScopedAdapter({
        policy,
        codexBin: this.options.codexBin,
        cwd: project.rootPath,
        codexDir: this.transcriptDataHome,
        integratorSessionBindingStore: this.options.bindingStore,
        projectRuntimeOwner: owner,
      });
      const session = await adapter.createSession({ name: input.name.trim(), cwd: project.rootPath, model: project.model });
      const binding = await this.options.bindingStore.get(input.inputId);
      const attempt = binding?.attempts.at(-1);
      if (binding?.state !== "accepted" || attempt?.state !== "accepted"
        || attempt.receipt?.state !== "created" || attempt.address?.nativeSessionId !== session.id
        || !attempt.scope || attempt.scope.projectId !== project.rootPath || attempt.scope.canonicalRoot.path !== project.rootPath
        || attempt.scope.policyRevision !== codexProjectPolicyRevision(project.nativeWebSearch) || attempt.scope.hostId !== this.hostId) {
        throw new Error("project_scoped_receipt_not_accepted");
      }
      const address = { hostId: attempt.hostId, harness: "codex" as const, nativeSessionId: session.id };
      this.sessions.set(addressKey(address), { adapter, owner, project, operationId: input.inputId });
      return this.createdReceipt(input, address, project, attempt.scope.rootIdentity);
    } catch {
      await adapter?.dispose().catch(() => undefined);
      return { state: "unknown", inputId: input.inputId, retryable: false, reason: "project_scoped_create_outcome_unknown" };
    }
  }

  private createdReceipt(input: IntegratorFleetCreateInput, address: IntegratorNativeAddress, project: ConfiguredProject, observedRootIdentity?: string): FleetCreateReceipt {
    const readiness = input.projectReadiness!;
    return {
      state: "created", inputId: input.inputId, address, launchCwd: project.rootPath, retryable: false,
      projectReadinessContract: "integrator-host-readiness-v1",
      projectExecution: {
        projectId: readiness.projectId, projectRoot: project.rootPath,
        rootIdentity: observedRootIdentity ?? readiness.rootIdentity, policyRevision: project.etag,
        runtimePolicyRevision: codexProjectPolicyRevision(project.nativeWebSearch), hostId: this.hostId,
        harness: "codex", model: project.model, requiredTools: readiness.requiredTools,
        address, launchCwd: project.rootPath,
      },
    };
  }

  private async restoreAccepted(operationId: string, address: IntegratorNativeAddress, project: ConfiguredProject): Promise<ScopedResolution> {
    let adapter: CodexAppServerAdapter | undefined;
    try {
      const binding = await this.options.bindingStore.get(operationId);
      const attempt = binding?.attempts.at(-1);
      if (binding?.state !== "accepted" || binding.harness !== "codex" || attempt?.state !== "accepted"
        || attempt.receipt?.state !== "created" || !attempt.scope || !sameAddress(attempt.address, address)
        || attempt.scope.projectId !== project.rootPath || attempt.scope.canonicalRoot.path !== project.rootPath
        || attempt.scope.policyRevision !== codexProjectPolicyRevision(project.nativeWebSearch) || attempt.scope.hostId !== this.hostId) {
        return { kind: "deny", reason: "project_session_binding_changed" };
      }
      const policy = await this.restorePolicy({
        projectId: project.rootPath,
        projectRoot: project.rootPath,
        operationId,
        store: this.options.bindingStore,
        nativeDataHome: this.codexDataHome,
        nativeWebSearchMode: project.nativeWebSearch,
      });
      const owner = this.runtimeOwner(project, policy.binding);
      adapter = await this.createScopedAdapter({
        policy,
        codexBin: this.options.codexBin,
        cwd: project.rootPath,
        codexDir: this.transcriptDataHome,
        integratorSessionBindingStore: this.options.bindingStore,
        projectRuntimeOwner: owner,
      });
      const restored = await adapter.restoreMaterializedSession();
      if (!restored.ok || restored.sessionId !== address.nativeSessionId) {
        await adapter.dispose();
        return { kind: "deny", reason: "project_session_restore_refused" };
      }
      this.sessions.set(addressKey(address), { adapter, owner, project, operationId });
      return { kind: "scoped", adapter };
    } catch {
      await adapter?.dispose().catch(() => undefined);
      return { kind: "deny", reason: "project_session_restore_unavailable" };
    }
  }

  private runtimeOwner(project: ConfiguredProject, expected: ProjectExecutionBinding): TrustedRuntimeOwnerResolver {
    return {
      resolve: async (binding) => {
        if (!sameBinding(binding, expected) || binding.projectId !== project.rootPath || binding.hostId !== this.hostId) return null;
        const current = await this.resolveConfiguredProject(project.rootPath);
        if (!current.ok || current.project.rootPath !== project.rootPath || current.project.model !== project.model
          || current.project.nativeWebSearch !== project.nativeWebSearch) return null;
        try {
          const root = await realpath(project.rootPath);
          const details = await stat(root);
          if (root !== project.rootPath || !details.isDirectory()
            || JSON.stringify([root, details.dev, details.ino]) !== binding.rootIdentity) return null;
        } catch { return null; }
        const issuedAtMs = Date.now();
        return { kind: "trusted" as const, binding: { ...binding }, issuedAtMs, expiresAtMs: issuedAtMs + 20_000 };
      },
    };
  }

  private async resolveConfiguredProject(project: string): Promise<{ ok: true; project: ConfiguredProject } | { ok: false; reason: string }> {
    let document: AutomationLaunchPolicyDocument;
    try { document = await this.options.policyStore.readDocument(); }
    catch { return { ok: false, reason: "project_route_policy_unavailable" }; }
    if (document.kind !== "valid") return { ok: false, reason: document.kind === "invalid" ? "project_route_policy_invalid" : "project_route_unconfigured" };
    const matches = Object.entries(document.policy.projectRoutes ?? {}).filter(([root, route]) => {
      const requestKey = foldProject(canonicalProjectKey(project));
      return foldProject(canonicalProjectKey(root)) === requestKey
        || route.aliases?.some(alias => foldProject(canonicalProjectKey(alias)) === requestKey) === true;
    });
    if (matches.length === 0) return { ok: false, reason: "project_route_unconfigured" };
    if (matches.length !== 1) return { ok: false, reason: "project_route_ambiguous" };
    const [root, route] = matches[0]!;
    const rootPath = canonicalProjectKey(root);
    if (!rootPath.startsWith("/") || resolve(rootPath) !== rootPath
      || route.harnesses[0] !== "codex" || !document.policy.allowedHarnesses.includes("codex")) {
      return { ok: false, reason: "project_route_codex_unavailable" };
    }
    const model = route.models?.codex ?? document.policy.models.codex;
    if (model !== CODEX_PROJECT_MODEL_ID) return { ok: false, reason: "project_route_model_mismatch" };
    try {
      if (await realpath(rootPath) !== rootPath || !(await stat(rootPath)).isDirectory()) {
        return { ok: false, reason: "project_route_root_unavailable" };
      }
    } catch { return { ok: false, reason: "project_route_root_unavailable" }; }
    return { ok: true, project: { rootPath, model, etag: document.etag,
      ...(route.nativeWebSearch ? { nativeWebSearch: route.nativeWebSearch } : {}) } };
  }

  private notAttempted(inputId: string, reason: string): FleetCreateReceipt {
    return { state: "not_attempted", inputId, retryable: false, reason };
  }
}

function validReadiness(
  value: IntegratorProjectReadinessSnapshot | undefined,
  input: IntegratorFleetCreateInput,
  project: ConfiguredProject,
  hostId: string,
): value is IntegratorProjectReadinessSnapshot {
  const now = Date.now();
  const observedAtMs = value?.observedAtMs;
  const fresh = Number.isSafeInteger(observedAtMs)
    && observedAtMs! <= now + PROJECT_READINESS_MAX_CLOCK_SKEW_MS
    && now - observedAtMs! <= PROJECT_READINESS_MAX_AGE_MS;
  return !!value && fresh && value.projectId === input.project && value.projectRoot === project.rootPath
    && value.state === "ready"
    && value.rootIdentity.length > 0 && value.policyRevision === project.etag
    && value.hostId === hostId && value.harness === "codex" && value.model === project.model
    && JSON.stringify(value.requiredTools) === JSON.stringify(project.nativeWebSearch === "live" ? ["web_search"] : [])
    && value.requiredTools.every(tool => value.availableTools.includes(tool)) && value.availableModels.includes(project.model)
    && value.resourceReady && value.runtimeInstanceId.length > 0
    && value.cwd === value.pathResolution.canonicalCwd && value.cwd === project.rootPath
    && value.pathResolution.requestedCwd === value.cwd && value.pathResolution.rootPath === project.rootPath
    && value.pathResolution.contained && value.pathResolution.identityMatches
    && input.cwd === value.cwd;
}

function withOperationId(policy: CodexProjectRuntimePolicy, operationId: string): CodexProjectRuntimePolicy {
  return Object.freeze({ ...policy, materialized: true, binding: Object.freeze({ ...policy.binding, attemptId: operationId }) });
}

function foldProject(value: string): string { return value.toLocaleLowerCase("en-US"); }

function addressKey(address: IntegratorNativeAddress): string {
  return JSON.stringify([address.hostId, address.harness, address.nativeSessionId]);
}

function sameAddress(left: IntegratorNativeAddress | undefined, right: IntegratorNativeAddress): boolean {
  return !!left && left.hostId === right.hostId && left.harness === right.harness
    && left.nativeSessionId === right.nativeSessionId;
}

function sameBinding(left: ProjectExecutionBinding, right: ProjectExecutionBinding): boolean {
  return left.projectId === right.projectId && left.rootIdentity === right.rootIdentity
    && left.policyRevision === right.policyRevision && left.attemptId === right.attemptId
    && left.hostId === right.hostId && left.runtimeInstanceId === right.runtimeInstanceId;
}

async function trusted(owner: TrustedRuntimeOwnerResolver, binding: ProjectExecutionBinding): Promise<boolean> {
  try {
    const proof = await owner.resolve(binding);
    return !!proof && typeof proof === "object" && (proof as { kind?: unknown }).kind === "trusted"
      && sameBinding((proof as { binding: ProjectExecutionBinding }).binding, binding);
  } catch { return false; }
}
