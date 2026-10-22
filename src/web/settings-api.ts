import type { IncomingMessage, ServerResponse } from "node:http";
import { hostname } from "node:os";

import { verifyFleetOwnerCookie } from "./fleet-owner-auth.js";
import {
  SettingsStore,
  type SettingsAuditRecord,
  type SettingsEntity,
} from "./settings-store.js";

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
 * A change with a cookie of the cabinet is refused when it comes from
 * another origin: the cookie of the owner is an ambient credential, and a
 * change of the settings must not be reachable from another site.
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

    try {
      if (request.method === "GET" && url.pathname === "/api/settings") {
        respond(response, 200, await readView());
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
        // A change with a credential of the browser must come from the
        // cabinet of the owner itself.
        if (request.headers.cookie && !isSameOrigin(request)) {
          respond(response, 403, { ok: false, error: "Изменение доступно из своего кабинета" });
          return true;
        }
        const body = await readJson(request);
        if (body.launchPolicy !== undefined) {
          // The policy of the launch has one writer: the endpoint that owns
          // it, with its own version check. A second writer into the same
          // store would let two versions of the policy live side by side.
          throw new Error("the policy of the launch is changed at its own endpoint /api/automation/launch-policy");
        }
        const environment = readChanges(body.environment, "environment") as Record<string, string | null> | undefined;
        const fleetNode = readChanges(body.fleetNode, "fleetNode");
        // Everything is checked before the first write: a refused value never
        // leaves a half applied change behind.
        await store.validate({ environment, fleetNode });
        const applied: SettingsAuditRecord[] = [];
        if (environment) applied.push(...await store.applyEnvironment(environment));
        if (fleetNode) applied.push(...await store.applyNodeConfig(fleetNode));
        respond(response, 200, { ...await readView(), applied });
        return true;
      }
      if (request.method === "POST" && url.pathname === "/api/settings/rollback") {
        if (request.headers.cookie && !isSameOrigin(request)) {
          respond(response, 403, { ok: false, error: "Изменение доступно из своего кабинета" });
          return true;
        }
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
      respond(response, 400, { ok: false, error: (error as Error).message });
      return true;
    }
  };
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
