import type { IncomingMessage, ServerResponse } from "node:http";
import { hostname } from "node:os";

import { verifyFleetOwnerCookie } from "./fleet-owner-auth.js";
import {
  SettingsStore,
  type SettingsAuditRecord,
  type SettingsDifference,
  type SettingsEntity,
} from "./settings-store.js";
import type { SettingsProfile } from "./settings-catalog.js";

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
      // The version of the whole document: a change that was made after the
      // owner read it is a conflict, and the owner sees the difference.
      etag,
      records,
      profiles,
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
