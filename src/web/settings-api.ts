import type { IncomingMessage, ServerResponse } from "node:http";
import { hostname } from "node:os";
import { isAbsolute } from "node:path";

import {
  setAutomationDisarm,
  setAutomationDisarmRecord,
  ALL_SCOPES,
  AUTOMATION_CANNOT_CHANGE_DISARM_REASON,
  AutomationDisarmStore,
  automationDisarmEtag,
  buildAutomationDisarmStateSummary,
  buildAutomationDisarmSummary,
  humanWorkKeys,
  readFleetDisarmState,
} from "../automation-disarm/index.js";
import { DirectFleetDisarmTransport } from "../automation-disarm/direct-transport.js";
import type { FleetDisarmNodeResult, FleetDisarmTransport } from "../automation-disarm/service.js";
import type { AutomationDisarmDocument } from "../automation-disarm/state.js";

import { verifyFleetOwnerCookie } from "./fleet-owner-auth.js";
import {
  SettingsStore,
  type SettingsAuditRecord,
  type SettingsDifference,
  type SettingsEntity,
  type SettingsProject,
} from "./settings-store.js";
import { SettingsConnectionStore, probeConnection } from "./settings-connection.js";
import { UnfinishedSessionLauncher } from "../autopilot/unfinished-session-launcher.js";
import { SettingsValueNotAllowedError, type SettingsProfile } from "./settings-catalog.js";

import {
  readFleetConfirmation,
  type SettingsFleetConfirmation,
} from "./settings-fleet-confirmation.js";

import {
  commonEnvironmentKeys,
  isCommonSettingId,
  readCommonSettingsFleet,
  redactCommonDocument,
  type CommonSettingsApplyResult,
  type CommonSettingsDocument,
  type CommonSettingsNodeState,
  type CommonSettingsRole,
  type CommonSettingsTransport,
} from "../common-settings/index.js";

/**
 * The API of the settings of the herder.
 *
 * The API is the server half of the owner form: it reads the current values
 * of the settings of the product and accepts the changes of the owner. The
 * form itself is a separate sheet.
 *
 * The access is the access of the panel of the herder: the native owner on
 * the loopback and the owner of the cabinet with the signed cookie. The
 * authority is the one of the panel — the verifier of the owner cookie and
 * the order of the checks of the server — and no new scheme of tokens and no
 * new endpoint of authentication is introduced here.
 */

/** The launch policy of the herder, read through the layer that already owns it. */
export interface SettingsLaunchPolicyLayer {
  /** The endpoint that owns the policy: the form changes the policy there. */
  endpoint: string;
  /** Read the current policy and the identity of its version. */
  read: () => Promise<{ kind: "valid" | "absent" | "invalid"; etag: string; policy?: unknown; error?: string }>;
}

export interface SettingsApiOptions {
  /** The durable settings of the herder product. */
  store: SettingsStore;
  /** The existing launch policy layer: the policy is read here and changed at its own endpoint. */
  launchPolicy?: SettingsLaunchPolicyLayer;
  /** The owner of this node: the audit journal names it. */
  actor?: string;
  /** The signed owner authority of the panel. */
  verifyOwnerCookie?: (cookie: string) => Promise<boolean>;
  /** The hostname of this node. */
  hostId?: string;
  /**
   * The store of the connection to the Notice Place.
   *
   * The connection is isolated: the herder keeps its own part of it in its
   * own store, and there is no shared env file.
   */
  connections?: SettingsConnectionStore;
  /**
   * The state of the lever of the owner over the automation.
   *
   * The route of the panel reads and writes the same runtime store that the
   * route of the herder uses, so the mesh has one state of the lever and not
   * two. The store and the transport are optional: without them the runtime
   * store of this node and the direct fleet transport are used, exactly as
   * the route of the herder uses them.
   */
  disarm?: {
    /** The durable store of the state of the lever. */
    store?: AutomationDisarmStore;
    /** The transport that reaches the other nodes of the fleet. */
    transport?: FleetDisarmTransport;
  };
  /**
   * The reader of the confirmation of the fleet.
   *
   * The reader asks the other nodes what they hold, so the owner asks for it
   * and it is not read with every view of the settings.
   */
  fleetConfirmation?: (input: {
    desiredRevision: string | null;
    localKind: "valid" | "absent" | "invalid";
  }) => Promise<SettingsFleetConfirmation>;
  /**
   * The common settings of the fleet.
   *
   * The document of the common settings is read from the files of the owner,
   * and the nodes that take it are asked over the transport of the fleet. The
   * option is absent on a node that has no common settings configured: such a
   * node answers that it has none and claims nothing.
   */
  commonSettings?: {
    /** The role of this node in the contour of the common settings. */
    role: CommonSettingsRole;
    /** The node that owns the document. */
    ownerHostId: string | null;
    /** The document of the common settings, read from the files of this node. */
    readDocument: () => Promise<CommonSettingsDocument | null>;
    /** The peers of the fleet: the node and the address of its runtime. */
    peers: readonly { hostId: string; target: string }[];
    /** The transport that reaches the other nodes of the fleet. */
    transport: CommonSettingsTransport;
    /** The state of this node. */
    state: () => Promise<CommonSettingsNodeState>;
    /** The opt-in flag of this node, set by the owner of this node. */
    setLocalOptIn?: (enabled: boolean) => Promise<void>;
    /** The local values of this node are put back. */
    restoreLocal?: () => Promise<CommonSettingsApplyResult>;
  };
}

/** The answer of the owner check. */
type OwnerCheck = { ok: true } | { ok: false; status: number; error: string };

/** The loopback of the node: the native owner reaches the herder through it. */
const LOOPBACK_ADDRESSES = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];

/** The names that mean the loopback of the node. */
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

/**
 * Whether the request comes from the loopback of this node.
 *
 * The native owner reaches the herder through the loopback, and such a
 * request carries no ambient credential of the browser, so it cannot be a
 * request of another site.
 */
function isLoopbackOwnerRequest(request: IncomingMessage): boolean {
  if (!LOOPBACK_ADDRESSES.includes(request.socket.remoteAddress ?? "")) return false;
  let host: URL;
  try {
    host = new URL(`http://${request.headers.host ?? ""}`);
  } catch {
    return false;
  }
  return LOOPBACK_HOSTS.includes(host.hostname.toLowerCase());
}

/**
 * Whether the request comes from the same origin it is addressed to.
 *
 * A change of the settings is refused when it comes from another origin: the
 * credential of the owner is an ambient credential of the browser, and a
 * change must not be reachable from another site. The check does not depend
 * on a cookie being present — a simple request of another site carries no
 * cookie at all, and it reaches the loopback of the owner just the same.
 *
 * The rule is the rule of the panel: the origin of a change must name the
 * host that serves the request. A change over the loopback names it with
 * the scheme `http`, a change over the cabinet names it with `https`.
 */
function isSameOrigin(request: IncomingMessage): boolean {
  const raw = request.headers.origin;
  if (typeof raw !== "string" || !raw) return false;
  let origin: URL;
  try {
    origin = new URL(raw);
  } catch {
    return false;
  }
  if (origin.host.toLowerCase() !== (request.headers.host ?? "").toLowerCase()) return false;
  if (origin.protocol === "https:") return true;
  return origin.protocol === "http:" && LOOPBACK_HOSTS.includes(origin.hostname.toLowerCase());
}

/**
 * The API of the settings of the herder.
 *
 * The handler answers `false` for every request that is not a request of the
 * settings, so the server keeps its own routes.
 */
export function createSettingsApi(options: SettingsApiOptions): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  const store = options.store;
  const actor = options.actor ?? "owner";
  const hostId = options.hostId ?? hostname();
  const verifyOwnerCookie = options.verifyOwnerCookie ?? verifyFleetOwnerCookie;

  /**
   * The conflict of a change: what moved since the owner read the settings.
   *
   * The answer names the difference and the current state, and the change is
   * not applied: the owner decides, the server never overwrites silently.
   */
  const findPrecondition = async (
    request: IncomingMessage,
    baseVersions: Record<string, number>,
  ): Promise<{ status: number; body: Record<string, unknown> } | null> => {
    const header = request.headers["if-match"];
    const expected = typeof header === "string" ? header.trim().replace(/^W\//, "").replace(/^"|"$/g, "") : undefined;
    if (expected === undefined) {
      // The same rule as the launch policy and the lever of the owner: a
      // change without the version it was made on is refused.
      return {
        status: 428,
        body: {
          ok: false,
          code: "precondition_required",
          error: "Нужна версия настроек, на которых вы правили: заголовок If-Match",
          current: { etag: await store.documentEtag() },
        },
      };
    }
    const current = await store.documentEtag();
    if (expected === current) return null;
    const difference: SettingsDifference[] = await store.difference(baseVersions);
    const records = await store.readRecords();
    return {
      status: 412,
      body: {
        ok: false,
        code: "version_conflict",
        error: "Настройки изменились, пока вы их правили. Посмотрите разницу и повторите.",
        current: { etag: current, records },
        difference,
      },
    };
  };


  /** The owner of the request: the native owner or the owner of the cabinet. */
  const checkOwner = async (request: IncomingMessage): Promise<OwnerCheck> => {
    const cookie = request.headers.cookie;
    const authorization = request.headers.authorization;
    // The native owner on the loopback: such a request carries no credential
    // of the browser, so there is nothing of another site to protect.
    if (!cookie && !authorization && isLoopbackOwnerRequest(request)) return { ok: true };
    if (typeof cookie !== "string" || !cookie || cookie.length > 16384) {
      return { ok: false, status: 401, error: "Войдите в кабинет владельца" };
    }
    if (!await verifyOwnerCookie(cookie)) {
      return { ok: false, status: 401, error: "Войдите в кабинет владельца" };
    }
    return { ok: true };
  };

  /** The current values of every setting of the contour. */
  const readView = async (): Promise<Record<string, unknown>> => {
    const environment = await store.readEnvironment();
    const fleetNode = await store.readNodeConfig();
    const audit = await store.readAudit(20);
    const records = await store.readRecords();
    const etag = await store.documentEtag();
    const profiles = await store.readProfiles();
    const projects = await store.readProjects();
    const secrets = await store.readSecretLifecycle();
    let launchPolicy: Record<string, unknown>;
    if (!options.launchPolicy) {
      launchPolicy = {
        endpoint: "/api/automation/launch-policy",
        state: "unavailable",
        error: "the launch policy is not configured on this node",
      };
    } else {
      const policy = await options.launchPolicy.read();
      launchPolicy = {
        endpoint: options.launchPolicy.endpoint,
        // The policy keeps its own endpoint and its own version check: the
        // form changes the policy there, and this API never writes it twice.
        managedBy: "the existing launch policy API of the herder",
        write: "PUT with the If-Match header of the version read here",
        state: policy.kind,
        etag: policy.etag,
        ...(policy.kind === "valid" ? { policy: policy.policy } : {}),
        ...(policy.kind === "invalid" ? { error: policy.error } : {}),
      };
    }
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      actor,
      product: "agent-herder",
      // The keys that travel to the nodes of the fleet: the form marks them,
      // so the owner sees where a common setting is changed once.
      commonSettings: { keys: commonEnvironmentKeys() },
      // The version of the whole document: a change that was made after the
      // owner read it is a conflict, and the owner sees the difference.
      etag,
      records,
      profiles,
      projects,
      secrets,
      environment: {
        entity: "herder.env",
        path: environment.path,
        present: environment.present,
        ...(environment.mode ? { mode: environment.mode } : {}),
        source: "The file of the product stays the source for the services; the form manages it.",
        applies: "The service of the node reads the file when it starts.",
        values: environment.values,
      },
      fleetNode: {
        entity: "node-config",
        path: fleetNode.path,
        present: fleetNode.present,
        hostId,
        managedKeys: fleetNode.managedKeys,
        config: fleetNode.config,
        ...(fleetNode.present ? {} : { note: "This node has no fleet node configuration; the deployment creates it." }),
      },
      launchPolicy,
      audit,
    };
  };

  /**
   * The common settings of the fleet, as the owner reads them.
   *
   * The document of the owner is read from the files of this node and the
   * nodes that take it are asked what they hold. A node that did not answer is
   * unknown, and unknown is never agreement.
   *
   * With `distribute` the nodes that hold another revision are told that the
   * document moved: they take it and apply it by themselves.
   */
  const readCommonView = async (input: { distribute?: boolean } = {}): Promise<Record<string, unknown>> => {
    const checkedAt = new Date().toISOString();
    const common = options.commonSettings;
    if (!common) {
      return {
        ok: false,
        role: "none",
        owner: null,
        revision: null,
        createdAt: null,
        document: null,
        nodes: [],
        notParticipating: [],
        state: "Записано",
        confirmed: 0,
        total: 0,
        unconfirmed: [],
        checkedAt,
        error: "Общие настройки флота не настроены на этой ноде.",
      };
    }
    const document = await common.readDocument();
    const fleet = await readCommonSettingsFleet({
      transport: common.transport,
      peers: common.peers,
      revision: document?.revision ?? null,
      ...(input.distribute ? { distribute: true } : {}),
    });
    return {
      ok: true,
      role: common.role,
      owner: common.ownerHostId,
      revision: document?.revision ?? null,
      createdAt: document?.createdAt ?? null,
      document: document ? redactCommonDocument(document) : null,
      ...fleet,
      checkedAt,
    };
  };

  /**
   * The lever of the owner over the automation of the mesh.
   *
   * The route of the panel lives in this module because the mounting of the
   * settings API is a prefix dispatcher: the frozen server keeps its own
   * route for the bearer callers, and the panel asks here. Both read and
   * write the same runtime store of the lever, so the mesh has one state and
   * not two.
   *
   * The browser never carries the token of the lever: the rights are checked
   * on the backend, by the same owner check as the other routes of the
   * settings. A node without the token configured fails closed — the lever is
   * not moved on the word of the panel alone.
   */
  const handleDisarm = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const disarmStore = options.disarm?.store ?? AutomationDisarmStore.forRuntime();
    const disarmTransport = options.disarm?.transport ?? new DirectFleetDisarmTransport();
    if (!process.env.AGENT_HERDER_DISARM_TOKEN?.trim()) {
      respond(response, 503, {
        ok: false, applied: false, records: [], nodes: [],
        summary: "рычаг не настроен на этой ноде — рычаг не сдвинут",
        error: "AGENT_HERDER_DISARM_TOKEN is not configured on this node",
        reason: "AGENT_HERDER_DISARM_TOKEN is not configured on this node",
      });
      return;
    }
    const stateView = (state: AutomationDisarmDocument) => ({
      ...state,
      blockedWorkKeysHuman: humanWorkKeys(state.blockedWorkKeys),
    });
    const nodeView = (nodes: FleetDisarmNodeResult[]) => nodes.map((node) => ({
      hostId: node.hostId, status: node.status, reason: node.reason ?? null,
    }));
    if (request.method === "GET") {
      // The read names the state, its revision and every node of the fleet.
      const state = await disarmStore.read();
      const etag = automationDisarmEtag(state);
      const nodes = await readFleetDisarmState({ transport: disarmTransport, state });
      response.setHeader("etag", etag);
      respond(response, 200, {
        ok: true,
        records: state.records,
        state: stateView(state),
        nodes: nodeView(nodes),
        summary: buildAutomationDisarmStateSummary({ records: state.records, nodes }),
        etag,
      });
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJson(request) as Record<string, unknown>;
    } catch (error) {
      respond(response, 400, { ok: false, applied: false, error: `Некорректное тело запроса: ${(error as Error).message}`, nodes: [] });
      return;
    }
    // The intent marker says what is asked: the lever moves only for an
    // explicit owner action, and a human request is not an authority.
    if (body.source !== "owner") {
      respond(response, 403, {
        ok: false, applied: false, records: [], nodes: [],
        summary: "запрос не является явным действием владельца — рычаг не сдвинут",
        error: AUTOMATION_CANNOT_CHANGE_DISARM_REASON,
        reason: AUTOMATION_CANNOT_CHANGE_DISARM_REASON,
      });
      return;
    }
    // The revision of the state the caller read. The answer always carries
    // the new revision.
    const ifMatchHeader = request.headers["if-match"];
    const ifMatch = (Array.isArray(ifMatchHeader) ? ifMatchHeader[0] : ifMatchHeader)?.trim();
    const policyRevision = await currentPolicyRevision();
    let workKeys: string[] | undefined;
    if (body.workKeys !== undefined) {
      if (!Array.isArray(body.workKeys) || body.workKeys.some((key: unknown) => typeof key !== "string")) {
        respond(response, 400, { ok: false, applied: false, error: "workKeys must be a list of strings", nodes: [] });
        return;
      }
      workKeys = body.workKeys as string[];
    }
    const answer = (result: {
      ok: boolean; applied: boolean; scope: string; forbidden: boolean;
      state: AutomationDisarmDocument; nodes: FleetDisarmNodeResult[]; summary: string;
    }): void => {
      const etag = automationDisarmEtag(result.state);
      response.setHeader("etag", etag);
      respond(response, 200, {
        ok: result.ok, applied: result.applied,
        scope: result.scope, forbidden: result.forbidden,
        disarmed: result.state.disarmed,
        state: stateView(result.state),
        records: result.state.records,
        nodes: nodeView(result.nodes),
        summary: result.summary,
        etag,
      });
    };
    // The scope shape: one record per scope, and the same interface lifts a
    // prohibition as it sets one.
    if (body.scope !== undefined) {
      if (typeof body.scope !== "string" || !body.scope.trim()) {
        respond(response, 400, { ok: false, applied: false, error: "scope must be * or an absolute project path", nodes: [] });
        return;
      }
      const scope = body.scope.trim();
      if (scope !== ALL_SCOPES && !isAbsolute(scope)) {
        respond(response, 400, { ok: false, applied: false, error: "scope must be * or an absolute project path", nodes: [] });
        return;
      }
      if (typeof body.forbidden !== "boolean") {
        respond(response, 400, { ok: false, applied: false, error: "forbidden must be a boolean", nodes: [] });
        return;
      }
      const result = await setAutomationDisarmRecord({
        scope,
        forbidden: body.forbidden,
        ...(typeof body.owner === "string" && body.owner.trim() ? { owner: body.owner.trim().slice(0, 200) } : {}),
        ...(typeof body.reason === "string" && body.reason.trim() ? { reason: body.reason.trim().slice(0, 500) } : {}),
        ...(workKeys === undefined ? {} : { workKeys }),
        ...(ifMatch ? { ifMatch } : {}),
        ...(policyRevision ? { policyRevision } : {}),
        reach: "fleet",
        source: "owner",
        store: disarmStore,
        transport: disarmTransport,
      });
      if (!result.applied && result.code === "state_conflict") {
        // The state moved under the caller: nothing was written.
        const etag = automationDisarmEtag(result.state);
        response.setHeader("etag", etag);
        respond(response, 412, {
          ok: false, applied: false, scope, forbidden: body.forbidden,
          records: result.state.records,
          state: stateView(result.state),
          nodes: [],
          summary: "состояние изменилось, пока вы его читали — ничего не записано",
          error: "state_conflict",
          reason: result.reason,
          etag,
        });
        return;
      }
      answer({
        ok: result.ok, applied: result.applied, scope: result.scope, forbidden: result.forbidden,
        state: result.state, nodes: result.nodes,
        summary: buildAutomationDisarmSummary({
          applied: result.applied, disarmed: result.forbidden, nodes: result.nodes, scope: result.scope,
        }),
      });
      return;
    }
    // The flat shape: the catch-all scope and the flat list of works.
    if (typeof body.disarmed !== "boolean") {
      respond(response, 400, { ok: false, applied: false, error: "disarmed must be a boolean", nodes: [] });
      return;
    }
    const result = await setAutomationDisarm({
      disarmed: body.disarmed,
      ...(workKeys === undefined ? {} : { workKeys }),
      ...(typeof body.reason === "string" && body.reason.trim() ? { reason: body.reason.trim().slice(0, 500) } : {}),
      ...(policyRevision ? { policyRevision } : {}),
      scope: "fleet",
      source: "owner",
      store: disarmStore,
      transport: disarmTransport,
    });
    answer({
      ok: result.ok, applied: result.applied,
      scope: ALL_SCOPES, forbidden: result.disarmed,
      state: result.state, nodes: result.nodes,
      summary: buildAutomationDisarmSummary(result),
    });
  };

  /**
   * The revision of the live launch policy at this moment.
   *
   * The revision travels with every owner decision, so the journal of the
   * lever says which launch policy was in force when the owner decided.
   */
  const currentPolicyRevision = async (): Promise<string | undefined> => {
    if (!options.launchPolicy) return undefined;
    try {
      const policy = await options.launchPolicy.read();
      return policy.etag;
    } catch {
      return undefined;
    }
  };

  /**
 * The key of the product that holds the token of the service account of the
 * herder for the center of notifications.
 */
const CONNECTION_TOKEN_KEY = "NOTIFY_CENTER_TOKEN";

/** The answer of the API: always without a cache and always as JSON. */
  const respond = (response: ServerResponse, status: number, body: unknown): void => {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify(body));
  };

  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/settings" && !url.pathname.startsWith("/api/settings/")) return false;

    const owner = await checkOwner(request);
    if (!owner.ok) {
      respond(response, owner.status, { ok: false, error: owner.error });
      return true;
    }

    // Every change of the settings must come from the origin it is addressed
    // to. The rule is the rule of the panel and it holds for every changing
    // method, with a cookie of the cabinet and without one.
    if (isChangingMethod(request.method) && !isSameOrigin(request)) {
      respond(response, 403, { ok: false, error: "Изменение доступно из своего кабинета" });
      return true;
    }

    if (url.pathname.startsWith("/api/settings/connections")) {
      // The part of the connection of the herder lives in the store of the
      // product, next to the settings of the herder: no wiring line is
      // needed and there is no shared env file.
      const connections = options.connections
        ?? new SettingsConnectionStore({ stateDir: store.stateDir });
      if (url.pathname === "/api/settings/connections" && request.method === "GET") {
        respond(response, 200, { ok: true, connection: await connections.read() });
        return true;
      }
      if (url.pathname === "/api/settings/connections" && request.method === "POST") {
        let body: Record<string, unknown>;
        try {
          body = await readJson(request) as Record<string, unknown>;
        } catch (error) {
          respond(response, 400, { ok: false, error: `Некорректное тело запроса: ${(error as Error).message}` });
          return true;
        }
        const centerUrl = typeof body.centerUrl === "string" ? body.centerUrl.trim() : "";
        if (!/^https?:\/\/[^\s]+$/.test(centerUrl)) {
          respond(response, 400, { ok: false, error: "адрес центра должен быть http(s)-адресом" });
          return true;
        }
        const purpose = typeof body.purpose === "string" ? body.purpose.trim() : "";
        if (!purpose) {
          respond(response, 400, { ok: false, error: "подключению нужна цель: центр её проверяет" });
          return true;
        }
        const permissions = Array.isArray(body.permissions)
          ? body.permissions.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim())
          : [];
        // The token of the service account is a secret of the product: it goes
        // into the file of the product, it is audited by its fingerprint and
        // it is never answered.
        let tokenFingerprint: string | undefined;
        if (typeof body.token === "string" && body.token.trim()) {
          await store.applyEnvironment({ [CONNECTION_TOKEN_KEY]: body.token.trim() });
          tokenFingerprint = (await store.checkSecret(CONNECTION_TOKEN_KEY)).fingerprint;
        }
        const connection = await connections.connect({
          centerUrl,
          purpose,
          permissions,
          ...(tokenFingerprint ? { tokenFingerprint } : {}),
        });
        respond(response, 200, { ok: true, connection });
        return true;
      }
      if (url.pathname === "/api/settings/connections/check" && request.method === "POST") {
        const connection = await connections.read();
        if (!connection) {
          respond(response, 409, { ok: false, error: "подключение не настроено" });
          return true;
        }
        if (connection.state === "revoked") {
          respond(response, 409, { ok: false, error: "подключение отозвано владельцем" });
          return true;
        }
        // The check reads the readiness of the center: it starts no executor
        // of the herder and creates no event in the center.
        const token = await store.readSecretValue(CONNECTION_TOKEN_KEY);
        const check = await probeConnection({ centerUrl: connection.centerUrl, purpose: connection.purpose, token });
        respond(response, 200, { ok: true, connection, check });
        return true;
      }
      if (url.pathname === "/api/settings/connections/revoke" && request.method === "POST") {
        try {
          const connection = await connections.revoke();
          respond(response, 200, { ok: true, connection });
        } catch (error) {
          respond(response, 409, { ok: false, error: (error as Error).message });
        }
        return true;
      }
    }

    if (url.pathname === "/api/settings/automation/stop-current" && request.method === "POST") {
      // The order of the owner: the state of the scope is forbidden first and
      // the live executors are stopped after it. Nothing new starts while the
      // old ones are stopped, and a later permission does not revive what was
      // stopped.
      let body: Record<string, unknown>;
      try {
        body = await readJson(request) as Record<string, unknown>;
      } catch (error) {
        respond(response, 400, {
          ok: false, applied: false, scope: "*", stopped: [], stillRunning: [],
          error: `Некорректное тело запроса: ${(error as Error).message}`,
        });
        return true;
      }
      if (body.source !== "owner") {
        respond(response, 403, {
          ok: false, applied: false, scope: "*", stopped: [], stillRunning: [],
          error: AUTOMATION_CANNOT_CHANGE_DISARM_REASON,
          reason: AUTOMATION_CANNOT_CHANGE_DISARM_REASON,
        });
        return true;
      }
      const scope = typeof body.scope === "string" && body.scope.trim() ? body.scope.trim() : "*";
      if (scope !== ALL_SCOPES && !isAbsolute(scope)) {
        respond(response, 400, {
          ok: false, applied: false, scope, stopped: [], stillRunning: [],
          error: "scope must be * or an absolute project path",
        });
        return true;
      }
      const disarmStore = options.disarm?.store ?? AutomationDisarmStore.forRuntime();
      const disarmTransport = options.disarm?.transport ?? new DirectFleetDisarmTransport();
      if (!process.env.AGENT_HERDER_DISARM_TOKEN?.trim()) {
        respond(response, 503, {
          ok: false, applied: false, scope, stopped: [], stillRunning: [],
          error: "AGENT_HERDER_DISARM_TOKEN is not configured on this node",
          reason: "AGENT_HERDER_DISARM_TOKEN is not configured on this node",
        });
        return true;
      }
      const policyRevision = await currentPolicyRevision();
      const forbid = await setAutomationDisarmRecord({
        scope,
        forbidden: true,
        ...(typeof body.reason === "string" && body.reason.trim() ? { reason: body.reason.trim().slice(0, 500) } : {}),
        ...(policyRevision ? { policyRevision } : {}),
        reach: "fleet",
        source: "owner",
        store: disarmStore,
        transport: disarmTransport,
      });
      // Then the live executors of the scope are stopped. The launcher of the
      // running process masks the records of the unfinished sessions and stops
      // the native sessions one by one: nothing is deleted.
      const launcher = UnfinishedSessionLauncher.forRuntime();
      const outcome = launcher
        ? await launcher.stopAutomaticSessionsOfScope(scope)
        : { stopped: [], stillRunning: [] };
      respond(response, 200, {
        ok: true,
        applied: forbid.applied,
        scope,
        stopped: outcome.stopped,
        stillRunning: outcome.stillRunning,
        ...(launcher ? {} : { detail: "автоматика не запущена на этой ноде: живых автоматических исполнителей здесь нет" }),
      });
      return true;
    }

    if (url.pathname === "/api/settings/automation/disarm" && (request.method === "GET" || request.method === "POST")) {
      await handleDisarm(request, response);
      return true;
    }

    try {
      if (request.method === "GET" && url.pathname === "/api/settings") {
        respond(response, 200, await readView());
        return true;
      }
      if (request.method === "GET" && url.pathname === "/api/settings/fleet-confirmation") {
        // The confirmation of the fleet: which node holds the wanted revision
        // and which node did not answer. The poll reaches the other nodes of
        // the fleet, so the owner asks for it and it is not read with every
        // view of the settings.
        let desiredRevision: string | null = null;
        let localKind: "valid" | "absent" | "invalid" = "valid";
        if (options.launchPolicy) {
          try {
            const policy = await options.launchPolicy.read();
            desiredRevision = policy.etag;
            localKind = policy.kind;
          } catch {
            // The policy is not readable on this node: there is no version of
            // the owner to compare the nodes with, and the reader says so.
          }
        }
        const confirmation = options.fleetConfirmation
          ? await options.fleetConfirmation({ desiredRevision, localKind })
          : await readFleetConfirmation({ desiredRevision, localKind, hostId });
        respond(response, 200, confirmation);
        return true;
      }
      if (request.method === "GET" && url.pathname === "/api/settings/common") {
        // The common settings of the fleet: the revision of the document and
        // what every node that takes it holds. The poll reaches the other
        // nodes, so the owner asks for it.
        respond(response, 200, await readCommonView());
        return true;
      }
      if (request.method === "POST" && url.pathname === "/api/settings/common/sync") {
        // The owner asks the nodes to take the document now. The nodes take it
        // by themselves and answer with the revision they hold.
        respond(response, 200, await readCommonView({ distribute: true }));
        return true;
      }
      if (request.method === "POST" && url.pathname === "/api/settings/common/opt-in") {
        // The opt-in of a node: the node itself declares that it takes the
        // common settings. The rights are the rights of the other settings:
        // the owner of the panel, and nothing else.
        const common = options.commonSettings;
        if (!common) {
          respond(response, 503, { ok: false, error: "Общие настройки флота не настроены на этой ноде." });
          return true;
        }
        let body: Record<string, unknown>;
        try {
          body = await readJson(request) as Record<string, unknown>;
        } catch (error) {
          respond(response, 400, { ok: false, error: `Некорректное тело запроса: ${(error as Error).message}` });
          return true;
        }
        if (typeof body.enabled !== "boolean") {
          respond(response, 400, { ok: false, error: "enabled must be a boolean" });
          return true;
        }
        const target = typeof body.hostId === "string" && body.hostId.trim() ? body.hostId.trim() : hostId;
        if (target !== hostId) {
          const peer = common.peers.find((candidate) => candidate.hostId === target);
          if (!peer) {
            respond(response, 404, { ok: false, error: `Нода ${target} не найдена во флоте.` });
            return true;
          }
          try {
            const status = await common.transport.setOptIn(peer.target, body.enabled);
            respond(response, 200, { ...await readCommonView(), node: status });
          } catch (error) {
            respond(response, 502, { ok: false, error: `Нода ${target} не ответила: ${(error as Error).message}` });
          }
          return true;
        }
        if (!common.setLocalOptIn) {
          respond(response, 503, { ok: false, error: "Эта нода не умеет объявлять opt-in." });
          return true;
        }
        await common.setLocalOptIn(body.enabled);
        respond(response, 200, { ok: true, ...await readCommonView() });
        return true;
      }
      if (request.method === "POST" && url.pathname === "/api/settings/common/restore") {
        // The local values of a node are put back after the common document
        // replaced them. The common value wins again at the next round.
        const common = options.commonSettings;
        if (!common) {
          respond(response, 503, { ok: false, error: "Общие настройки флота не настроены на этой ноде." });
          return true;
        }
        let body: Record<string, unknown> = {};
        try {
          body = (await readJson(request) ?? {}) as Record<string, unknown>;
        } catch {
          body = {};
        }
        const target = typeof body.hostId === "string" && body.hostId.trim() ? body.hostId.trim() : hostId;
        if (target !== hostId) {
          const peer = common.peers.find((candidate) => candidate.hostId === target);
          if (!peer) {
            respond(response, 404, { ok: false, error: `Нода ${target} не найдена во флоте.` });
            return true;
          }
          try {
            const status = await common.transport.restore(peer.target);
            respond(response, 200, { ...await readCommonView(), node: status });
          } catch (error) {
            respond(response, 502, { ok: false, error: `Нода ${target} не ответила: ${(error as Error).message}` });
          }
          return true;
        }
        if (!common.restoreLocal) {
          respond(response, 503, { ok: false, error: "Эта нода не хранит отклонения общих настроек." });
          return true;
        }
        const result = await common.restoreLocal();
        respond(response, 200, { ...await readCommonView(), restored: result });
        return true;
      }
      if (request.method === "GET" && url.pathname === "/api/settings/audit") {
        const limit = Number(url.searchParams.get("limit") ?? 100);
        respond(response, 200, {
          ok: true,
          actor,
          records: await store.readAudit(Number.isFinite(limit) ? limit : 100),
        });
        return true;
      }
      if (request.method === "PUT" && url.pathname === "/api/settings") {
        const body = await readJson(request);
        if (body.launchPolicy !== undefined) {
          // The policy of the launch has one writer: the endpoint that owns
          // it, with its own version check. A second writer into the same
          // store would let two versions of the policy live side by side.
          throw new Error("the policy of the launch is changed at its own endpoint /api/automation/launch-policy");
        }
        const environment = readChanges(body.environment, "environment") as Record<string, string | null> | undefined;
        const fleetNode = readChanges(body.fleetNode, "fleetNode");
        const secrets = readChanges(body.secrets, "secrets");
        const profiles = readArray(body.profiles, "profiles");
        const projects = readProjects(body.projects);
        const baseVersions = readBaseVersions(body.baseVersion);

        // The precondition of the write is checked before everything else: a
        // change made on a base that moved on is never applied silently.
        const precondition = await findPrecondition(request, baseVersions);
        if (precondition) {
          respond(response, precondition.status, precondition.body);
          return true;
        }

        // Everything is checked before the first write: a refused value never
        // leaves a half applied change behind.
        await store.validate({ environment, fleetNode });
        const applied: SettingsAuditRecord[] = [];
        const results: Record<string, unknown> = {};
        if (environment) applied.push(...await store.applyEnvironment(environment));
        // A common setting changed: the nodes that take the common settings
        // are told that the document moved. The round of taking happens in the
        // background: the owner sees who confirmed when it polls the fleet.
        const commonChanged = environment
          ? Object.keys(environment).some((key) => isCommonSettingId(`herder.env/${key}`))
          : false;
        if (commonChanged && options.commonSettings) {
          void readCommonView({ distribute: true }).catch(() => { /* the fleet answers on the next poll */ });
        }
        if (fleetNode) applied.push(...await store.applyNodeConfig(fleetNode));
        if (secrets) {
          for (const [key, operation] of Object.entries(secrets)) {
            const request = (operation ?? {}) as Record<string, unknown>;
            const kind = request.operation;
            if (kind === "revoke") {
              await store.revokeSecret(key);
              results[key] = { revoked: true };
              continue;
            }
            if (kind === "check") {
              const expected = typeof request.fingerprint === "string" ? request.fingerprint : undefined;
              results[key] = await store.checkSecret(key, expected);
              continue;
            }
            const purpose = typeof request.purpose === "string" ? request.purpose : undefined;
            const expiresAt = typeof request.expiresAt === "string" ? request.expiresAt : undefined;
            if (purpose === undefined && expiresAt === undefined) {
              results[key] = await store.checkSecret(key);
              continue;
            }
            results[key] = await store.setSecretMeta(key, { ...(purpose !== undefined ? { purpose } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}) });
          }
        }
        if (profiles) {
          const current = await store.readProfiles();
          for (const profile of profiles) {
            const id = profile.id;
            if (!id || typeof id !== "string") throw new Error("the profile needs an id");
            const index = current.findIndex((candidate) => candidate.id === id);
            const next: SettingsProfile = {
              id,
              humanName: typeof profile.humanName === "string" ? profile.humanName : id,
              action: typeof profile.action === "string" ? profile.action : "Профиль ИИ.",
              scope: isScope(profile.scope) ? profile.scope : { kind: "mesh" },
              harness: typeof profile.harness === "string" ? profile.harness : "codex",
              ...(typeof profile.model === "string" ? { model: profile.model } : {}),
              ...(Array.isArray(profile.fallbackModels) ? { fallbackModels: stringList(profile.fallbackModels) } : {}),
              ...(Array.isArray(profile.allowedTools) ? { allowedTools: stringList(profile.allowedTools) } : {}),
              ...(profile.limits && typeof profile.limits === "object" && !Array.isArray(profile.limits)
                ? { limits: profile.limits as Record<string, unknown> }
                : {}),
            };
            if (index >= 0) current[index] = next;
            else current.push(next);
          }
          await store.writeProfiles(current);
        }
        if (projects) applied.push(...await store.applyProjects(projects));
        respond(response, 200, { ...await readView(), applied, ...(Object.keys(results).length > 0 ? { results } : {}) });
        return true;
      }
      if (request.method === "POST" && url.pathname === "/api/settings/rollback") {
        const body = await readJson(request);
        const entity = body.entity;
        const key = body.key;
        if ((entity !== "herder.env" && entity !== "node-config") || typeof key !== "string" || !key.trim()) {
          respond(response, 400, { ok: false, error: "entity and key are required" });
          return true;
        }
        const historyId = typeof body.historyId === "string" ? body.historyId : undefined;
        const applied = await store.rollback({ entity: entity as SettingsEntity, key: key.trim(), ...(historyId ? { historyId } : {}) });
        respond(response, 200, { ...await readView(), applied: [applied] });
        return true;
      }
      respond(response, 405, { ok: false, error: "The settings API accepts a read, a change and a rollback" });
      return true;
    } catch (error) {
      // The message of an error never carries a value of a secret: the store
      // refuses a value before it is written and names the key, not the value.
      if (error instanceof SettingsValueNotAllowedError) {
        // The refusal of a value that does not fit the contract of its key:
        // the answer names the key, the allowed values and the received
        // value, and never a stack and never an internal id.
        respond(response, 400, { ok: false, applied: false, error: error.message });
        return true;
      }
      respond(response, 400, { ok: false, error: (error as Error).message });
      return true;
    }
  };
}

/** Whether the method changes something. */
function isChangingMethod(method: string | undefined): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

/** The versions of the records the owner edited. */
function readBaseVersions(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const versions: Record<string, number> = {};
  for (const [id, version] of Object.entries(value as Record<string, unknown>)) {
    if (typeof version === "number" && Number.isFinite(version)) versions[id] = version;
  }
  return versions;
}

/** The strings of a list of the request. */
function stringList(value: unknown[]): string[] {
  return value.filter((item): item is string => typeof item === "string");
}

/** Whether the value is a scope of a setting. */
function isScope(value: unknown): value is { kind: "mesh" | "project" | "node" | "user"; path?: string } {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "mesh" || kind === "project" || kind === "node" || kind === "user";
}

/**
 * The projects of the request.
 *
 * A project names the AI profile it runs in and the object of the Notice
 * Place that carries its escalation rule. The rule belongs to the center: a
 * project keeps the reference to the object and never a copy of the rule, so
 * a rule that arrives here is refused instead of being stored twice.
 */
function readProjects(value: unknown): SettingsProject[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error("projects must be a list of projects");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("a project must be an object");
    const raw = item as Record<string, unknown>;
    if (typeof raw.id !== "string" || !raw.id.trim()) throw new Error("the project needs an id");
    if (typeof raw.name !== "string" || !raw.name.trim()) throw new Error(`the project ${raw.id} needs a name`);
    if (typeof raw.path !== "string" || !raw.path.trim()) throw new Error(`the project ${raw.id} needs a path`);
    const project: SettingsProject = { id: raw.id.trim(), name: raw.name.trim(), path: raw.path.trim() };
    if (raw.profileId !== undefined && raw.profileId !== null && raw.profileId !== "") {
      if (typeof raw.profileId !== "string") {
        throw new Error(`the profile of the project ${project.id} must be a reference by id`);
      }
      project.profileId = raw.profileId.trim();
    }
    if (raw.escalation !== undefined && raw.escalation !== null) {
      if (typeof raw.escalation !== "object" || Array.isArray(raw.escalation)) {
        throw new Error(`the escalation of the project ${project.id} must be a reference to the object of the center`);
      }
      const escalation = raw.escalation as Record<string, unknown>;
      const extra = Object.keys(escalation).filter((key) => key !== "noticePlaceObjectId");
      if (extra.length > 0) {
        throw new Error(
          `the rule of the escalation belongs to the center: the project ${project.id} keeps the reference to the object and nothing else`,
        );
      }
      const objectId = escalation.noticePlaceObjectId;
      if (typeof objectId !== "string" || !objectId.trim()) {
        throw new Error(`the escalation of the project ${project.id} must name the object of the center by its id`);
      }
      project.escalation = { noticePlaceObjectId: objectId.trim() };
    }
    return project;
  });
}

/** The list of profiles of the request. */
function readArray(value: unknown, field: string): Array<Record<string, unknown>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be a list of profiles`);
  return value as Array<Record<string, unknown>>;
}

/**
 * The changes of one entity of the request.
 *
 * A value of `null` removes the key. An entity that is not in the request is
 * not changed at all.
 */
function readChanges(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object of settings`);
  }
  return value as Record<string, unknown>;
}

/** The body of the request: an object of a bounded size. */
async function readJson(request: IncomingMessage, maxBytes = 256 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error("The body of the request is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The body of the request must be an object");
  return parsed as Record<string, unknown>;
}
