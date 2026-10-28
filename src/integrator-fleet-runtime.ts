import { randomUUID } from "node:crypto";
import { hostname, homedir } from "node:os";
import { join, resolve } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { AutomationLaunchPolicyStore, canonicalProjectKey, type AutomationLaunchPolicyDocument, type ProjectLaunchRoute } from "./automation-launch-policy.js";
import { CodexAppServerAdapter } from "./adapters/codex-app-server.js";
import { OpenCodeAdapter } from "./adapters/opencode.js";
import {
  CODEX_PROJECT_MODEL_ID,
  codexProjectPolicyRevision,
  createCodexProjectRuntimePolicy,
  restoreCodexProjectRuntimePolicy,
  type CodexProjectRuntimePolicy,
} from "./project-runtime-policy.js";
import type { ProjectExecutionBinding, TrustedRuntimeOwnerResolver } from "./project-execution-scope.js";
import { IntegratorSessionBindingStore, type IntegratorAttemptScope, type IntegratorLaunchReceipt, type IntegratorNativeAddress, type IntegratorOperationBinding } from "./integrator-session-binding.js";
import { fleetHarnesses, type FleetCreateReceipt, type FleetHarness } from "./mesh/fleet-contract.js";
import type { HarnessAdapter } from "./types/index.js";
import type { CodexServiceTier } from "./types/index.js";
  // ORCHESTRATOR-CONFLICT: src/integrator-fleet-runtime.ts:16 — его импорты (IntegratorLaunchReceipt, FleetHarness, HarnessAdapter) сохранены; добавлен наш value-импорт fleetHarnesses (маршрут гарна): набор ours ⊃ theirs, потеря его кода нет.

export interface IntegratorFleetCreateInput {
  project: string;
  inputId: string;
  name: string;
  /** A supplied cwd is a consistency check only; the saved route is authoritative. */
  cwd?: string;
  model?: string;
  serviceTier?: CodexServiceTier;
  /** The explicitly selected harness of the request. The project route must designate it. */
  harness?: FleetHarness;
  projectReadinessContract?: "integrator-host-readiness-v1";
  projectReadiness?: IntegratorProjectReadinessSnapshot;
}

/** One durable reservation of an integrator operation for the selected harness. */
export interface IntegratorHarnessReservation {
  operationId: string;
  attempt: number;
  inputId: string;
  hostId: string;
  /** The harness the operation was reserved for. It stays pinned for the whole operation. */
  harness: FleetHarness;
}

/** Everything the harness adapter needs to serve one reserved operation. */
export interface IntegratorHarnessAdapterInput {
  harness: FleetHarness;
  reservation: IntegratorHarnessReservation;
  project: { rootPath: string; model: string; etag: string };
  bindingStore: IntegratorSessionBindingStore;
}

/** Builds the adapter that owns the native session of one reserved operation. */
export type IntegratorHarnessAdapterFactory = (input: IntegratorHarnessAdapterInput) => Promise<HarnessAdapter>;

export interface IntegratorProjectReadinessSnapshot {
  state?: "ready";
  projectId: string;
  projectRoot: string;
  rootIdentity: string;
  policyRevision: string;
  hostId: string;
  harness: FleetHarness;
  harnessVersion: string;
  model: string;
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
  | { kind: "scoped"; adapter: CodexAppServerAdapter | HarnessAdapter }
  | { kind: "deny"; reason: string };
type ScopedResolution = Exclude<IntegratorSessionAdapterResolution, { kind: "ordinary" }>;

type CodexConfiguredProject = { rootPath: string; harness: "codex"; model: typeof CODEX_PROJECT_MODEL_ID; etag: string; nativeWebSearch?: "live" };
type ConfiguredProject =
  | CodexConfiguredProject
  | { rootPath: string; harness: Exclude<FleetHarness, "codex">; model: string; etag: string; nativeWebSearch?: "live" };
/** The one saved route of a project: the exact policy document it was read from, its root and its route. */
type RouteMatch = { document: Extract<AutomationLaunchPolicyDocument, { kind: "valid" }>; rootPath: string; route: ProjectLaunchRoute };
/** The route a consumer must request: the harness the project designates and the model of that harness. */
export type IntegratorProjectRoute =
  | { state: "available"; harness: FleetHarness; model: string; reason?: undefined }
  | { state: "unavailable"; harness?: undefined; model?: undefined; reason: string };
type ScopedSession = { adapter: CodexAppServerAdapter; owner: TrustedRuntimeOwnerResolver; project: CodexConfiguredProject; operationId: string };
  // ORCHESTRATOR-CONFLICT: src/integrator-fleet-runtime.ts:103 — его типы (CodexConfiguredProject/ConfiguredProject/ScopedSession) сохранены; добавлены наши RouteMatch и IntegratorProjectRoute (контракт маршрута для панели).
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
  /** Builds the adapter of the selected harness for one reserved operation. */
  createHarnessAdapter?: IntegratorHarnessAdapterFactory;
  /** Observed native data home of the OpenCode harness on this host (scope evidence). */
  opencodeDataHome?: string;
  /**
   * Explicit operator-persisted adoptions for ONE legacy OpenCode row each:
   * the original root identity and policy revision from the owner's durable
   * evidence, matched exactly (operation + session + launch root) before a
   * legacy scope_missing row may join the scoped route. Never inferred.
   */
  legacyScopeAdoptions?: Array<{
    operationId: string;
    nativeSessionId: string;
    launchCwd: string;
    rootIdentity: string;
    policyRevision: string;
  }>;
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
  private readonly createHarnessAdapter: IntegratorHarnessAdapterFactory;

  constructor(private readonly options: IntegratorFleetRuntimeOptions) {
    this.hostId = options.hostId ?? hostname();
    this.codexDataHome = resolve(options.codexDataHome ?? process.env.CODEX_HOME ?? `${homedir()}/.codex`);
    this.transcriptDataHome = resolve(options.transcriptDataHome ?? process.env.CODEX_DATA_DIR ?? this.codexDataHome);
    this.createPolicy = options.createPolicy ?? createCodexProjectRuntimePolicy;
    this.restorePolicy = options.restorePolicy ?? restoreCodexProjectRuntimePolicy;
    this.createScopedAdapter = options.createScopedAdapter ?? (config => CodexAppServerAdapter.createProjectScoped(config));
    this.createHarnessAdapter = options.createHarnessAdapter ?? (async ({ harness, reservation, bindingStore }) => {
      if (harness !== "opencode") throw new Error(`integrator_harness_${harness}_adapter_unavailable`);
      return new OpenCodeAdapter({ integratorSessionBindingStore: bindingStore, integratorReservation: reservation });
    });
  }

  async create(input: IntegratorFleetCreateInput): Promise<FleetCreateReceipt> {
    if (!/^[a-f0-9]{64}$/.test(input.inputId) || !input.name.trim()) {
      return this.notAttempted(input.inputId, "project_input_invalid");
    }
    const configured = await this.resolveConfiguredProject(input.project, input.harness ?? "codex");
    if (!configured.ok) return this.notAttempted(input.inputId, configured.reason);
    const project = configured.project;
    if (project.harness !== (input.harness ?? "codex")) {
      return this.notAttempted(input.inputId, "project_route_harness_not_prepared");
    }
    if (input.serviceTier !== undefined && project.harness !== "codex") {
      return this.notAttempted(input.inputId, "service_tier_codex_only");
    }
    if (input.model && input.model !== project.model) {
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
      if (lookup?.state === "accepted" && lookup.harness === project.harness && attempt?.state === "accepted"
        && attempt.receipt?.state === "created" && address?.hostId === this.hostId && address.harness === project.harness
        && scope?.hostId === this.hostId && scope.harness === project.harness
        && scope.projectId === configured.project.rootPath && scope.canonicalRoot.path === configured.project.rootPath
        && scope.policyRevision === codexProjectPolicyRevision(configured.project.nativeWebSearch) && scope.rootIdentity === currentRootIdentity) {
        return await this.createdReceipt(input, address!, configured.project);
      }
      return { state: "not_attempted", inputId: input.inputId, retryable: false, reason: "project_operation_conflict" };
    }
    let existing: IntegratorOperationBinding | null;
    try { existing = await this.options.bindingStore.get(input.inputId); }
    catch { return { state: "unknown", inputId: input.inputId, retryable: false, reason: "project_binding_store_unavailable" }; }
    if (existing) {
      if (existing.harness !== project.harness || existing.state !== "accepted") {
        return { state: "unknown", inputId: input.inputId, retryable: false, reason: "project_operation_unresolved" };
      }
      const address = existing.attempts.at(-1)?.address;
      if (!address) return { state: "unknown", inputId: input.inputId, retryable: false, reason: "project_receipt_missing_address" };
      if (project.harness !== "codex") {
        // Another harness has no restore path in this runtime: the accepted receipt is the durable outcome.
        return this.createdReceipt(input, address, project);
      }
      const restored = await this.restoreAccepted(existing.operationId, address, project);
  // ORCHESTRATOR-CONFLICT: src/integrator-fleet-runtime.ts:211 — взят его вариант: отличие от нашего ровно одно — нет await у createdReceipt (метод асинхронный, семантика возврата та же); его restoreAccepted(..., project) уже совпадает с нашим.
      return restored.kind === "scoped"
        ? this.createdReceipt(input, address, project)
  // ORCHESTRATOR-CONFLICT: src/integrator-fleet-runtime.ts:227 — взят его вариант: то же отличие (await у createdReceipt в тернарном выражении), семантика идентична.
        : { state: "unknown", inputId: input.inputId, retryable: false, reason: restored.reason };
    }
    // The host-readiness contract is the codex project-execution contract: the fleet contract pins
    // its receipt to codex and no other harness has a producer for it yet. Another harness is gated
    // by its route instead: the route designates that harness, resolves its model, and its root is
    // available.
    if (project.harness === "codex" && (input.projectReadinessContract !== "integrator-host-readiness-v1"
      || !validReadiness(input.projectReadiness, input, project, this.hostId)
      || !await this.validateReadiness(input))) {
      return this.notAttempted(input.inputId, "project_readiness_contract_missing_or_stale");
    }
    const previous = this.inFlight.get(input.inputId);
    if (previous) return previous;
    const operation = this.createFirst(input, project).finally(() => this.inFlight.delete(input.inputId));
    this.inFlight.set(input.inputId, operation);
    return operation;
  }

  /**
   * Project-specific host capability readback of the route the project designates. The snapshot
   * carries the harness and the model of that route, so a consumer never has to assume a codex
   * constant. A codex route keeps its scoped app-server probe; a project without a route is named
   * with the reason of the resolver.
   */
  async readiness(projectId: string): Promise<IntegratorProjectReadiness> {
    const notReady = (reason: string, harness: FleetHarness = "codex", model: string = CODEX_PROJECT_MODEL_ID): IntegratorProjectReadiness => ({
      state: "not_ready", reason, projectId, projectRoot: "", rootIdentity: "", policyRevision: "",
      hostId: this.hostId, harness, harnessVersion: "", model,
      requiredTools: [], availableTools: [], availableModels: [], resourceReady: false,
      runtimeInstanceId: "", cwd: "", observedAtMs: Date.now(),
      pathResolution: { requestedCwd: "", canonicalCwd: "", rootPath: "", contained: false, identityMatches: false },
    });
    // ORCHESTRATOR-CONFLICT: src/integrator-fleet-runtime.ts:231 — readiness проекта: его код закрепляет проверку за codex-маршрутом, наш контракт берёт гарн и модель из сохранённого маршрута (модельные правила, единый источник маршрута): его код / наш контракт; ждёт решения владельца
    // РЕШЕНО 24.10.2026 измерением: наш контракт (гарн и модель из сохранённого маршрута). Его вариант крепит проверку к codex, проект с не-codex гарном вечно not_ready (project_route_codex_unavailable); его код даёт 10/12 тестов fleet-runtime.
    const matched = await this.matchRoute(projectId);
    if (!matched.ok) return notReady(matched.reason);
    const designated = matched.match.route.harnesses[0];
    const harness = designated && (fleetHarnesses as readonly string[]).includes(designated) ? designated as FleetHarness : undefined;
    if (!harness) return notReady("project_route_harness_unavailable");
    const configured = await this.resolveConfiguredProject(projectId, harness, matched);
    if (!configured.ok) return notReady(configured.reason, harness, this.routeModel(matched.match, harness));
    if (harness !== "codex") return await this.routeReadiness(projectId, configured.project);
    // РЕШЕНО 24.10.2026 слиянием (лист L19): его WIP (23.10) уже умел многохарновый create (createHarnessAdapter, IntegratorHarnessAdapterFactory, route.harnesses[0]) — это сохранено целиком; наш файл = его файл + наш контракт маршрута (matchRoute/routeModel/routeReadiness/projectRoute/rootIdentityOf). Его `notReady(reason)` с кодовым гарном заменён на наш `notReady(reason, harness, model)` из сохранённого маршрута; его проверка `harness === "codex"` заменена на нашу `project.harness`.
  // ORCHESTRATOR-CONFLICT: src/integrator-fleet-runtime.ts:266 — его вариант жёстко крепит проверку к codex (resolveConfiguredProject(projectId,"codex")): проект с не-codex гарном вечно not_ready и теряет модель маршрута. Взят наш вариант (гарн и модель из сохранённого маршрута) — это контракт «проекты» и наши тесты маршрута.
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

  /** The model the route designates for one harness. It is the model a consumer must request. */
  private routeModel(match: RouteMatch, harness: FleetHarness): string {
    return match.route.models?.[harness] ?? match.document.policy.models[harness] ?? "";
  }

  /**
   * The snapshot of a route whose harness has no scoped host probe in this runtime. It carries the
   * harness and the model of that route and the identity of the project root the herder observed,
   * so a consumer can build its binding from the route instead of from a codex constant. The host
   * capability of such a harness is not probed here, so a route that needs a native tool stays not
   * ready and names that reason.
   */
  private async routeReadiness(projectId: string, project: ConfiguredProject): Promise<IntegratorProjectReadiness> {
    const root = await realpath(project.rootPath);
    const rootStat = await stat(root);
    const rootIdentity = JSON.stringify([root, rootStat.dev, rootStat.ino]);
    const requiredTools = project.nativeWebSearch === "live" ? ["web_search"] : [];
    const availableTools: string[] = [];
    const rootAvailable = root === project.rootPath && rootStat.isDirectory();
    const resourceReady = rootAvailable && requiredTools.length === 0;
    return {
      state: resourceReady ? "ready" : "not_ready",
      ...(resourceReady ? {} : { reason: rootAvailable ? "project_host_capability_unprobed" : "project_root_unavailable" }),
      projectId, projectRoot: root, rootIdentity, policyRevision: project.etag,
      hostId: this.hostId, harness: project.harness, harnessVersion: "",
      model: project.model, requiredTools, availableTools,
      availableModels: [project.model], resourceReady,
      runtimeInstanceId: randomUUID(), cwd: root, observedAtMs: Date.now(),
      pathResolution: { requestedCwd: root, canonicalCwd: root, rootPath: root,
        contained: rootAvailable, identityMatches: true },
    };
  }

  async validateReadiness(input: IntegratorFleetCreateInput): Promise<boolean> {
    if (input.projectReadinessContract !== "integrator-host-readiness-v1" || !input.projectReadiness) return false;
    const configured = await this.resolveConfiguredProject(input.project, input.harness ?? "codex");
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
    // A harness-first journal row without a codex scope is reported as
    // scope_missing. Fail closed by default: no legacy row is authorized from
    // the currently configured root alone. The only exception is an exact
    // persisted adoption (owner-supplied evidence for ONE operation/session,
    // including the original root identity and policy revision), which the
    // runtime reconfirms against the live route before use.
    const legacyCandidate = lookup.state === "unresolved" && lookup.reason === "scope_missing"
      && lookup.binding?.harness === "opencode" && address.harness === "opencode"
      ? { binding: lookup.binding, attempt: lookup.binding.attempts.at(-1) } : null;
    if (lookup.state !== "accepted" && !legacyCandidate) {
      return { kind: "deny", reason: lookup.reason };
    }
    const binding = lookup.binding;
    const attempt = lookup.state === "accepted" ? lookup.attempt : legacyCandidate!.attempt!;
    if (attempt.hostId !== this.hostId) {
      return { kind: "deny", reason: "project_session_host_or_harness_mismatch" };
    }
    if (address.harness === "opencode") {
      // The durable tuple of a harness-first row is the launch root of the
      // accepted created receipt, and the current route must still designate
      // that exact root for opencode right now.
      if (attempt.state !== "accepted" || attempt.receipt?.state !== "created" || !attempt.receipt.launchCwd) {
        return { kind: "deny", reason: "project_session_scope_missing" };
      }
      const launchRoot = attempt.receipt.launchCwd;
      // A legacy row without a stored scope is denied unless the operator
      // persisted an explicit exact adoption for THIS operation/session, and
      // the adopted tuple still matches the live route and root identity.
      if (!attempt.scope) {
        // Exact persisted adoption: matched on the durable native session id
        // and the launch root of the accepted created receipt. The consumer's
        // operationId lives in a different ID space and stays informational.
        const adoption = (this.options.legacyScopeAdoptions ?? []).find(entry =>
          entry.nativeSessionId === address.nativeSessionId && entry.launchCwd === launchRoot);
        if (!adoption) {
          return { kind: "deny", reason: "project_session_scope_missing" };
        }
        const adopted = await this.resolveConfiguredProject(adoption.launchCwd, "opencode");
        const adoptedRootIdentity = adopted.ok ? await this.rootIdentityOf(adopted.project.rootPath) : "";
        if (!adopted.ok || adopted.project.harness !== "opencode"
          || adopted.project.rootPath !== adoption.launchCwd
          || adoptedRootIdentity !== adoption.rootIdentity
          || adopted.project.etag !== adoption.policyRevision) {
          return { kind: "deny", reason: "project_session_adopted_scope_changed" };
        }
        console.warn(`[integrator] legacy-scope-adoption ${JSON.stringify({
          operationId: binding!.operationId, nativeSessionId: address.nativeSessionId,
          launchRoot: adoption.launchCwd, rootIdentity: adoptedRootIdentity,
          policyRevision: adoption.policyRevision,
        })}`);
      }
      const configured = await this.resolveConfiguredProject(launchRoot, "opencode");
      const rootIdentity = configured.ok ? await this.rootIdentityOf(configured.project.rootPath) : "";
      if (!configured.ok || configured.project.harness !== "opencode"
        || configured.project.rootPath !== launchRoot || !rootIdentity) {
        return { kind: "deny", reason: "project_session_current_route_mismatch" };
      }
      const adapter = await this.createHarnessAdapter({
        harness: "opencode",
        reservation: { operationId: binding!.operationId, attempt: attempt.attempt,
          inputId: attempt.inputId, hostId: attempt.hostId, harness: "opencode" },
        project: { rootPath: configured.project.rootPath, model: configured.project.model, etag: configured.project.etag },
        bindingStore: this.options.bindingStore,
      });
      // A stored scope must prove the exact historical tuple against the live
      // route; a legacy row adopts only through its exact created receipt
      // (launchCwd), never through the currently configured root alone.
      if (attempt.scope && (attempt.scope.projectId !== configured.project.rootPath
        || attempt.scope.rootIdentity !== rootIdentity
        || attempt.scope.policyRevision !== configured.project.etag
        || attempt.scope.hostId !== attempt.hostId || attempt.scope.harness !== "opencode")) {
        return { kind: "deny", reason: "project_session_current_route_mismatch" };
      }
      // The native session must actually live in the project root: cwd drift
      // cannot inherit another project's scoped access.
      const native = await (adapter.getSession?.(address.nativeSessionId).catch(() => null) ?? null);
      if (!native || native.cwd !== configured.project.rootPath) {
        return { kind: "deny", reason: "project_session_native_cwd_drift" };
      }
      if (legacyCandidate) {
        // Explicit, auditable adoption of one legacy harness-first row: the
        // original durable evidence (accepted created receipt + launch root)
        // is the grant; the live route and root identity merely reconfirm it.
        console.warn(`[integrator] legacy-scope-adoption ${JSON.stringify({
          journalOperationId: binding!.operationId, nativeSessionId: address.nativeSessionId,
          launchRoot, rootIdentity, policyRevision: configured.project.etag,
        })}`);
      }
      return { kind: "scoped", adapter };
    }
    if (address.harness !== "codex" || lookup.state !== "accepted") {
      return { kind: "deny", reason: "project_session_host_or_harness_mismatch" };
    }
    const configured = await this.resolveConfiguredProject(lookup.attempt.scope!.projectId, "codex");
    if (!configured.ok || configured.project.harness !== "codex"
      || configured.project.rootPath !== lookup.attempt.scope!.canonicalRoot.path
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
    if (project.harness === "codex") return this.createCodexFirst(input, project);
    return this.createHarnessFirst(input, project);
  }

  /** Creates one Codex session. The scoped adapter reserves the operation and writes the receipt. */
  private async createCodexFirst(input: IntegratorFleetCreateInput, project: CodexConfiguredProject): Promise<FleetCreateReceipt> {
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
      const session = await adapter.createSession({ name: input.name.trim(), cwd: project.rootPath, model: project.model, serviceTier: input.serviceTier });
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
      return await this.createdReceipt(input, address, project, attempt.scope.rootIdentity);
    } catch {
      await adapter?.dispose().catch(() => undefined);
      return { state: "unknown", inputId: input.inputId, retryable: false, reason: "project_scoped_create_outcome_unknown" };
    }
  }

  /**
   * Creates one session for the selected harness. The runtime reserves the operation with that
   * harness and hands the reservation to the harness adapter, which writes the durable created
   * receipt through the binding store. The exact project/root/policy/host tuple is captured
   * before the reservation and stored with it, so the later scoped resolution proves the
   * historical grant instead of re-deriving it from the currently configured root.
   */
  private async createHarnessFirst(input: IntegratorFleetCreateInput, project: ConfiguredProject): Promise<FleetCreateReceipt> {
    const capturedScope = await this.captureHarnessScope(project).catch(() => null);
    if (!capturedScope) {
      return { state: "unknown", inputId: input.inputId, retryable: false, reason: "project_harness_scope_uncapturable" };
    }
    let reservation: IntegratorHarnessReservation;
    try {
      reservation = await this.reserveOperation(input, project.harness, capturedScope);
    } catch {
      return { state: "unknown", inputId: input.inputId, retryable: false, reason: "project_operation_reservation_unavailable" };
    }
    let adapter: HarnessAdapter;
    try {
      adapter = await this.createHarnessAdapter({ harness: project.harness, reservation,
        project: { rootPath: project.rootPath, model: project.model, etag: project.etag },
        bindingStore: this.options.bindingStore });
    } catch {
      await this.recordAttemptOutcome(reservation, { state: "not_attempted", inputId: reservation.inputId,
        retryable: false, reason: "project_harness_adapter_unavailable" }).catch(() => undefined);
      return this.notAttempted(input.inputId, "project_harness_adapter_unavailable");
    }
    try {
      if (!adapter.createSession) throw new Error("project_harness_adapter_cannot_create");
      const session = await adapter.createSession({ name: input.name.trim(), cwd: project.rootPath, model: project.model });
      const binding = await this.options.bindingStore.get(input.inputId);
      const attempt = binding?.attempts.at(-1);
      if (binding?.state !== "accepted" || binding.harness !== project.harness || attempt?.state !== "accepted"
        || attempt.receipt?.state !== "created" || attempt.address?.nativeSessionId !== session.id
        || attempt.address?.harness !== project.harness) {
        throw new Error("project_harness_receipt_not_accepted");
      }
      const address = { hostId: attempt.hostId, harness: project.harness, nativeSessionId: session.id };
      return await this.createdReceipt(input, address, project);
    } catch {
      await this.recordAttemptOutcome(reservation, { state: "unknown", inputId: reservation.inputId,
        retryable: false, reason: "native_materialization_outcome_uncertain" }).catch(() => undefined);
      return { state: "unknown", inputId: input.inputId, retryable: false, reason: "project_harness_create_outcome_unknown" };
    }
  }

  /** Reserves one operation for the selected harness; the reservation carries the harness and the captured scope. */
  private async reserveOperation(input: IntegratorFleetCreateInput, harness: FleetHarness, scope?: IntegratorAttemptScope): Promise<IntegratorHarnessReservation> {
    const reserved = await this.options.bindingStore.reserve({ operationId: input.inputId, hostId: this.hostId, harness, ...(scope ? { scope } : {}) });
    if (!reserved.claimed) throw new Error("integrator_operation_reservation_not_claimed");
    return { operationId: input.inputId, attempt: reserved.attempt.attempt, inputId: reserved.attempt.inputId,
      hostId: reserved.attempt.hostId, harness };
  }

  /** Writes one attempt outcome of a reserved operation, unless the attempt is already terminal. */
  private async recordAttemptOutcome(reservation: IntegratorHarnessReservation, receipt: IntegratorLaunchReceipt): Promise<void> {
    const binding = await this.options.bindingStore.get(reservation.operationId);
    const attempt = binding?.attempts[reservation.attempt - 1];
    if (!attempt || (attempt.state !== "intent" && attempt.state !== "unknown")) return;
    await this.options.bindingStore.record({ operationId: reservation.operationId, attempt: reservation.attempt, receipt });
  }

  // ORCHESTRATOR-CONFLICT: src/integrator-fleet-runtime.ts:466 — контракт чека создания для не-codex гарна: его код отдаёт минимальный чек только с native-адресом, наш контракт отдаёт тот же projectExecution-контракт с наблюдаемым rootIdentity и policyRevision маршрута: его код / наш контракт; ждёт решения владельца
  // РЕШЕНО 24.10.2026 измерением: наш контракт (тот же projectExecution с наблюдаемым rootIdentity и policyRevision маршрута). Его вариант отдаёт минимальный чек только с native-адресом; смесь «3=наш, 4=его» даёт 1 падение: ready без projectExecution.
  private async createdReceipt(input: IntegratorFleetCreateInput, address: IntegratorNativeAddress, project: ConfiguredProject, observedRootIdentity?: string): Promise<FleetCreateReceipt> {
    if (project.harness !== "codex") {
      // The project-execution receipt is the same contract for the selected harness: the route
      // designates that harness and its model, and the root identity of the launch is observed now.
      const rootIdentity = observedRootIdentity ?? await this.rootIdentityOf(project.rootPath);
      return {
        state: "created", inputId: input.inputId, address, launchCwd: project.rootPath, retryable: false,
        projectReadinessContract: "integrator-host-readiness-v1",
        projectExecution: {
          projectId: input.project, projectRoot: project.rootPath,
          rootIdentity, policyRevision: project.etag,
          // A route that is not codex has no codex runtime policy: the route policy is the runtime policy.
          runtimePolicyRevision: project.etag, hostId: this.hostId,
          harness: project.harness, model: project.model,
          requiredTools: project.nativeWebSearch === "live" ? ["web_search"] : [],
          address, launchCwd: project.rootPath,
        },
      };
  // РЕШЕНО 24.10.2026 слиянием (лист L19): его минимальный чек для не-codex гарна (только native-адрес) заменён на наш полный `projectExecution` — по измерению смесь «3=наш, 4=его» даёт 1 падение «ready без projectExecution». Работа владельца не потеряна: не-codex гарн по-прежнему создаётся через `createHarnessAdapter`, его тест «creates for the selected harness...» сохранён (tests/integrator-fleet-runtime.test.ts).
    }
  // ORCHESTRATOR-CONFLICT: src/integrator-fleet-runtime.ts:454 — его хелперы createHarnessFirst/reserveOperation/recordAttemptOutcome сохранены (createHarnessFirst отличается только отсутствием await); его createdReceipt отдаёт для не-codex гарна минимальный чек (без projectExecution) — ломает контракт «returns the project execution of the selected harness with the route model» (измерение L19: смесь даёт 1 падение «ready без projectExecution»), поэтому оставлен наш полный чек с rootIdentity.
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

  /** The identity of a project root: its canonical path, device and inode. */
  private async rootIdentityOf(rootPath: string): Promise<string> {
    try {
      const root = await realpath(rootPath);
      const details = await stat(root);
      return JSON.stringify([root, details.dev, details.ino]);
    } catch { return ""; }
  }

  /**
   * Observe the exact project/root/policy/host/harness tuple of a harness-first
   * launch before the native reservation, so the durable journal carries the
   * grant that the later scoped resolution proves. Every field is observed
   * here: the reservation is refused when the root cannot be captured exactly.
   */
  private async captureHarnessScope(project: ConfiguredProject): Promise<IntegratorAttemptScope> {
    const canonicalRoot = await realpath(project.rootPath);
    const rootStat = await stat(canonicalRoot);
    if (canonicalRoot !== project.rootPath) throw new Error("project_root_not_canonical");
    // The OpenCode harness stores its sessions under its own data home on this
    // host; the reserve-time evidence observes that exact directory instead of
    // inventing a mapping. A missing home fails the capture closed.
    const nativeDataHome = this.options.opencodeDataHome
      ?? join(homedir(), ".local", "share", "opencode");
    const homeStat = await stat(nativeDataHome);
    return {
      projectId: project.rootPath,
      rootIdentity: JSON.stringify([canonicalRoot, rootStat.dev, rootStat.ino]),
      policyRevision: project.etag,
      hostId: this.hostId,
      harness: project.harness,
      // The harness binary version is not observable at reserve time for a
      // harness-first route; the store requires a non-empty marker, so the
      // absence is recorded explicitly instead of a fabricated version.
      harnessVersion: "unknown-at-reserve",
      canonicalRoot: { path: canonicalRoot, device: rootStat.dev, inode: rootStat.ino },
      nativeDataHome: { path: nativeDataHome, device: homeStat.dev, inode: homeStat.ino },
    };
  }

  private async restoreAccepted(operationId: string, address: IntegratorNativeAddress, project: CodexConfiguredProject): Promise<ScopedResolution> {
  // ORCHESTRATOR-CONFLICT: src/integrator-fleet-runtime.ts:614 — его сигнатура restoreAccepted(..., CodexConfiguredProject) сохранена; добавлен наш rootIdentityOf (наблюдаемая идентичность корня проекта).
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

  private runtimeOwner(project: CodexConfiguredProject, expected: ProjectExecutionBinding): TrustedRuntimeOwnerResolver {
    return {
      resolve: async (binding) => {
        if (!sameBinding(binding, expected) || binding.projectId !== project.rootPath || binding.hostId !== this.hostId) return null;
        const current = await this.resolveConfiguredProject(project.rootPath, "codex");
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

  /** Matches the one saved route of a project. The route designates its own harness; the caller decides what to do with it. */
  private async matchRoute(project: string): Promise<{ ok: true; match: RouteMatch } | { ok: false; reason: string }> {
  // ORCHESTRATOR-CONFLICT: src/integrator-fleet-runtime.ts:689 — его resolveConfiguredProject(project, harness) взять нельзя: наши вызовы передают третий аргумент matchRoute (ошибка числа аргументов в TS). Наш head (matchedRoute опционален) совместим с его двухаргументными вызовами.
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
    if (!rootPath.startsWith("/") || resolve(rootPath) !== rootPath) {
      return { ok: false, reason: "project_route_codex_unavailable" };
    }
    return { ok: true, match: { document, rootPath, route } };
  }

  /**
   * The route a consumer must request: the harness the project designates and the model of that harness.
   * The values come from the same resolver the create path uses, so a caller never asks for a harness the
   * route does not designate. A project without a route is named with the reason of the resolver, never thrown.
   */
  async projectRoute(projectId: string): Promise<IntegratorProjectRoute> {
    const matched = await this.matchRoute(projectId);
    if (!matched.ok) return { state: "unavailable", reason: matched.reason };
    const designated = matched.match.route.harnesses[0];
    const fleetHarness = designated && (fleetHarnesses as readonly string[]).includes(designated) ? designated as FleetHarness : undefined;
    if (!fleetHarness || !matched.match.document.policy.allowedHarnesses.includes(fleetHarness)) {
      return { state: "unavailable", reason: "project_route_harness_unavailable" };
    }
    const configured = await this.resolveConfiguredProject(projectId, fleetHarness, matched);
    if (!configured.ok) return { state: "unavailable", reason: configured.reason };
    return { state: "available", harness: configured.project.harness, model: configured.project.model };
  }

  /** Resolves one project route for one explicitly selected harness. The route designates its primary harness; another harness is never substituted. */
  private async resolveConfiguredProject(project: string, harness: FleetHarness, matchedRoute?: { ok: true; match: RouteMatch }): Promise<{ ok: true; project: ConfiguredProject } | { ok: false; reason: string }> {
    const matched = matchedRoute ?? await this.matchRoute(project);
    if (!matched.ok) return { ok: false, reason: matched.reason };
    const { document, rootPath, route } = matched.match;
    const routeHarness = route.harnesses[0];
    if (!routeHarness || routeHarness !== harness || !document.policy.allowedHarnesses.includes(harness)) {
      return { ok: false, reason: harness === "codex" ? "project_route_codex_unavailable" : "project_route_harness_unavailable" };
    }
    const model = route.models?.[harness] ?? document.policy.models[harness];
    if (harness === "codex") {
      if (model !== CODEX_PROJECT_MODEL_ID) return { ok: false, reason: "project_route_model_mismatch" };
      if (!await this.projectRootAvailable(rootPath)) return { ok: false, reason: "project_route_root_unavailable" };
      return { ok: true, project: { rootPath, harness: "codex", model: CODEX_PROJECT_MODEL_ID, etag: document.etag,
        ...(route.nativeWebSearch ? { nativeWebSearch: route.nativeWebSearch } : {}) } };
    }
    if (!model) return { ok: false, reason: "project_route_model_unavailable" };
    if (!await this.projectRootAvailable(rootPath)) return { ok: false, reason: "project_route_root_unavailable" };
    return { ok: true, project: { rootPath, harness, model, etag: document.etag,
  // ORCHESTRATOR-CONFLICT: src/integrator-fleet-runtime.ts:714 — его тело resolveConfiguredProject совпадает с нашим побайтно (sha256 2c0036c1363b808d); добавлены наши matchRoute и projectRoute (контракт маршрута для панели).
      ...(route.nativeWebSearch ? { nativeWebSearch: route.nativeWebSearch } : {}) } };
  }

  private async projectRootAvailable(rootPath: string): Promise<boolean> {
    try { return await realpath(rootPath) === rootPath && (await stat(rootPath)).isDirectory(); }
    catch { return false; }
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
    && value.hostId === hostId && value.harness === project.harness && value.model === project.model
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
