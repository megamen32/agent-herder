import {createHash, timingSafeEqual} from "node:crypto";
import {open} from "node:fs/promises";
import {homedir, hostname, userInfo} from "node:os";
import {join} from "node:path";
import type {IncomingMessage, ServerResponse} from "node:http";
import {FleetCabinetService} from "../mesh/fleet-service.js";
import {createFleetApiHandler} from "../mesh/fleet-api.js";
import {FleetGptAdminTransport} from "../mesh/fleet-gptadmin-transport.js";
import {unwrapResult} from "../mesh/protocol.js";
import type {FleetHostDefinition} from "../mesh/fleet-contract.js";

export const fleetHosts: readonly FleetHostDefinition[] = [
  {hostId: "roomhacker-server-100", label: "Сервер 100", nativeUser: "roomhacker", uiUrl: "https://agent.bezrabotnyi.com"},
  {hostId: "server-44", label: "Сервер 44", nativeUser: "roomhacker", uiUrl: "https://agent44.bezrabotnyi.com"},
  {hostId: "roomhacker-server-88", label: "Сервер 88", nativeUser: "roomhacker", uiUrl: "https://agent88.bezrabotnyi.com"},
  {hostId: "mac-mini-2012.lan", label: "Mac Mini", nativeUser: "roomhacker", uiUrl: "https://agent-mac-mini.bezrabotnyi.com"},
  {hostId: "MacBook-Pro-User.local", label: "Mac M1", nativeUser: "user", uiUrl: "https://agent-mac-m1.bezrabotnyi.com"},
];

type Binding = {endpoint: string; headers: Record<string, string>; generation: string};
type Active = Binding & {service: FleetCabinetService};
const matches = (left: string, right: string) => {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Existing native consumer credentials stay on the owner host, never in a browser or another node. */
export function createConfiguredFleetApiHandler(options: {
  clientConfigPath?: string;
  userId?: string;
  stateRoot?: string;
  /** Exact approved existing caller; changing credentials requires effective-profile verification. */
  approvedCredentialGeneration?: string;
} = {}) {
  const userId = options.userId ?? userInfo().username;
  const configPath = options.clientConfigPath ?? join(homedir(), ".zcode", "cli", "config.json");
  const stateRoot = options.stateRoot ?? join(homedir(), ".local", "state", "agent-herder", "fleet");
  const approvedGeneration = options.approvedCredentialGeneration ?? process.env.AGENT_HERDER_FLEET_CREDENTIAL_PIN;
  let active: Active | undefined;
  let connecting: Promise<Active> | undefined;

  const readBinding = async (): Promise<Binding> => {
    const file = await open(configPath, "r");
    const buffer = Buffer.alloc(262145);
    let length = 0;
    try {
      if (!(await file.stat()).isFile()) throw new Error("fleet_config_invalid");
      while (length < buffer.length) {
        const {bytesRead} = await file.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
    } finally { await file.close(); }
    if (length > 262144) throw new Error("fleet_config_limit");
    const text = buffer.subarray(0, length).toString("utf8");
    const entry = JSON.parse(text)?.mcp?.servers?.gptadmin;
    if (!entry || entry.enabled === false || typeof entry.url !== "string") throw new Error("fleet_consumer_unavailable");
    const url = new URL(entry.url);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".gptadmin.bezrabotnyi.com") || url.username || url.password || url.hash || url.search) throw new Error("fleet_consumer_origin_invalid");
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(entry.headers ?? {})) {
      if (typeof value !== "string" || value.length > 8192 || /[\r\n]/.test(value)) throw new Error("fleet_consumer_headers_invalid");
      headers[key] = value;
    }
    if (!Object.keys(headers).some(key => key.toLowerCase() === "authorization")) throw new Error("fleet_consumer_auth_missing");
    const generation = createHash("sha256").update(JSON.stringify([url.href, headers])).digest("hex");
    // whoami currently proves the caller/mode, not an effective policy-profile ID.
    // Keep this delivery on the approved existing caller; never reinterpret its journal for another credential.
    if (!approvedGeneration || !matches(generation, approvedGeneration)) throw new Error("fleet_credential_approval_required");
    return {endpoint: url.href, headers, generation};
  };

  const bind = async (binding: Binding): Promise<Active> => {
    if (active?.generation === binding.generation) return active;
    if (connecting) await connecting;
    if (active?.generation === binding.generation) return active;
    // Headers are frozen for this credential generation; a rotated credential gets new MCP sessions.
    connecting = (async () => {
      // This first bind includes initialize, initialized and the Hub schema before identity verification.
      const transport = new FleetGptAdminTransport({endpoint: binding.endpoint, headersProvider: () => ({...binding.headers}), readDeadlineMs: 10_000});
      await transport.schema("hub");
      const identity = unwrapResult(await transport.call("hub", "access_clients", {action: "whoami"}));
      if (identity.client_id !== "zcode" || identity.access_mode !== "full") throw new Error("fleet_client_identity_mismatch");
      const profileId = `${new URL(binding.endpoint).origin}/client:${identity.client_id}`;
      // Journal identity survives credential rotation so UNKNOWN intents cannot be replayed.
      const journalKey = createHash("sha256").update(JSON.stringify([profileId, userId])).digest("hex");
      const service = new FleetCabinetService({
        hosts: fleetHosts, scope: {profileId, userId}, credentialGeneration: binding.generation,
        journalPath: join(stateRoot, `create-${journalKey}.json`),
        transportFactory: () => new FleetGptAdminTransport({endpoint: binding.endpoint, headersProvider: () => ({...binding.headers})}),
      });
      return active = {...binding, service};
    })().finally(() => { connecting = undefined; });
    return connecting;
  };

  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (!path.startsWith("/api/fleet/")) return false;
    const reject = (status: number, error: string) => {
      response.writeHead(status, {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"});
      response.end(JSON.stringify({error}));
      return true;
    };
    try {
      const binding = await readBinding();
      const configuredBearer = Object.entries(binding.headers).find(([key]) => key.toLowerCase() === "authorization")![1];
      const bearer = request.headers.authorization;
      const nativeAuthenticated = typeof bearer === "string" && matches(bearer, configuredBearer);
      if (!nativeAuthenticated) {
        const cookie = request.headers.cookie;
        if (!cookie || cookie.length > 16384) return reject(401, "Войдите в кабинет");
        const check = await fetch("http://127.0.0.1:18991/check", {headers: {Cookie: cookie}, redirect: "error", signal: AbortSignal.timeout(3000)});
        const valid = check.status === 204 && check.headers.get("X-GPTAdmin-User") === userId;
        await check.body?.cancel();
        if (!valid) return reject(403, "Для этого пользователя нет подключённого профиля флота");
        if (request.method === "POST") {
          let origin: URL;
          try { origin = new URL(request.headers.origin ?? ""); } catch { return reject(403, "Создание сессии доступно из своего кабинета"); }
          if (origin.protocol !== "https:" || origin.host.toLowerCase() !== request.headers.host?.toLowerCase()) return reject(403, "Создание сессии доступно из своего кабинета");
        }
      }
      // Managed remote cabinets use the same verified owner gate before exposing local sessions.
      // auth_request receives only a status; no upstream credential or profile data is returned.
      if (path === "/api/fleet/access") {
        if (request.method !== "GET") return reject(405, "Проверка доступа принимает только чтение");
        response.writeHead(204, {"Cache-Control": "no-store"});
        response.end();
        return true;
      }
      const connection = await bind(binding);
      const host = (request.headers.host ?? "").split(":")[0]!.toLowerCase();
      const defaultHostId = fleetHosts.find(node => new URL(node.uiUrl!).hostname === host)?.hostId ?? hostname();
      return createFleetApiHandler(connection.service, defaultHostId)(request, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const code = /^(fleet|gptadmin)_[a-z0-9_]+$/.test(message) ? message : "fleet_connection_failed";
      console.error(`[agent-herder] Fleet request unavailable: ${code}`);
      return reject(503, "Подключение флота пока недоступно. Повторите чтение позже.");
    }
  };
}
