const root = process.env.AGENT_HERDER_ROOT || new URL("../../", import.meta.url).pathname.replace(/\/$/, "")

const coordinationEndpoint = process.env.AGENT_HERDER_URL || "http://127.0.0.1:18787"

// These are the only project roots covered by the human's restricted9 rule.
// Native child sessions are associated through Session.Info.parentID, not cwd
// text, prompt contents, or an agent-authored project label.
const restrictedProjectRoots = new Set([
  "/home/roomhacker/PycharmProjects/TelegramAuto",
  "/home/roomhacker/PycharmProjects/video_watching",
])
// >>> agent-herder:leaf-launch-policy (generated; do not edit) >>>
/**
 * The rule of the owner about one leaf of a route — ONE place.
 *
 * A leaf is one route as the provider sees it: the provider id and the
 * provider-facing model id. The rule says which leaves may be launched, and
 * every consumer of the product asks this module:
 *
 * - the launcher (`src/autopilot/unfinished-session-launcher.ts`) admits only
 *   the leaves of the allowed families;
 * - the guard of the OpenCode integration
 *   (`integrations/opencode/agent-herder-autopilot.js`) answers with the same
 *   rule, so the panel never promises a route the guard revokes;
 * - the resume client (`packages/agent-resume/src/harness/opencode/client.ts`)
 *   answers with the same rule again.
 *
 * The rule is data, so the consumers that cannot import this module (the guard
 * is one file without a bundler, the shared core is a separate package) get a
 * generated copy of it. `scripts/generate-leaf-launch-policy.mjs` writes those
 * copies and `tests/leaf-launch-policy-single-source.test.ts` fails when they
 * drift apart, so the rule cannot be described twice by accident.
 */
/**
 * The rule itself.
 *
 * The closed providers are refused whatever the owner switches: the switch of
 * the prohibitions relaxes the routes that are merely unknown, never the
 * providers the owner closed. The allowed families are the routes the
 * launcher admits.
 */
const LEAF_LAUNCH_POLICY = {
    version: 2,
    closedProviderPattern: "codex|claude|anthropic",
    allowedFamilies: [
        { providers: ["minimax", "minimax-code", "minimax-coding-plan"], modelPattern: "minimax|mmcode" },
        { providers: ["glm", "zai", "zai-coding-plan", "zhipu"], modelPattern: "(^|[/_-])glm([-_/]|$)" },
        { providers: ["zcode-start", "zcode-individual"], modelPattern: "^(?:(?:zcode-start|zcode-individual)/)?glm-5\\.3-flash$" },
    ],
};
/**
 * How the refusals of the rule are announced.
 *
 * The texts live here because two consumers must say the same words: the
 * guard of the OpenCode integration throws them, and the resume client
 * recognizes the refusal of the model request by its exact text.
 */
const LEAF_LAUNCH_REFUSAL_MESSAGES = {
    modelRequest: {
        closedProvider: "Agent Herder blocked this model request: the provider of this route is closed by the rule of the owner.",
        routeForbidden: "Agent Herder blocked this model request: the complete native provider route is forbidden or could not be verified for this project.",
    },
    subagent: {
        closedProvider: "Agent Herder blocked this child: the provider of this route is closed by the rule of the owner.",
        routeForbidden: "Agent Herder blocked this child: its complete native provider route is forbidden or could not be verified for this project.",
    },
};
/** The pattern of the closed providers, compiled once. */
const CLOSED_PROVIDER_PATTERN = new RegExp(LEAF_LAUNCH_POLICY.closedProviderPattern, "u");
/** The patterns of the allowed families, compiled once. */
const ALLOWED_FAMILY_PATTERNS = LEAF_LAUNCH_POLICY.allowedFamilies.map((family) => new RegExp(family.modelPattern, "u"));
/** The provider id and the model id of a leaf, as the rule reads them. */
function normalizedLeaf(leaf) {
    return {
        providerId: leaf.providerId.trim().toLocaleLowerCase("en-US"),
        modelId: leaf.modelId.trim().toLocaleLowerCase("en-US"),
    };
}
/**
 * True when the route leads to a provider the owner closed.
 *
 * A closed provider is refused always: no switch of the owner opens it.
 */
function isClosedProviderLeaf(leaf) {
    const { providerId, modelId } = normalizedLeaf(leaf);
    if (!providerId || !modelId)
        return false;
    return CLOSED_PROVIDER_PATTERN.test(`${providerId}/${modelId}`);
}
/**
 * True when the rule of the owner lets the launcher run this leaf.
 *
 * This is the rule of the launcher: the leaf must be of an allowed family, and
 * a closed provider is never of one.
 */
function isLeafAllowedByOwnerRule(leaf) {
    const { providerId, modelId } = normalizedLeaf(leaf);
    if (!providerId || !modelId)
        return false;
    if (isClosedProviderLeaf(leaf))
        return false;
    return LEAF_LAUNCH_POLICY.allowedFamilies.some((family, index) => family.providers.includes(providerId) && ALLOWED_FAMILY_PATTERNS[index].test(modelId));
}
/**
 * The answer of the rule about one leaf, with the switch of the owner.
 *
 * The provider the owner closed is refused always. The leaf of an allowed
 * family is allowed. Every other leaf is refused while the prohibitions are
 * on, and allowed when the owner switches them off — the switch relaxes the
 * routes the rule does not know, never the providers the owner closed.
 */
function leafLaunchVerdict(leaf, options) {
    if (isClosedProviderLeaf(leaf))
        return "denied";
    if (isLeafAllowedByOwnerRule(leaf))
        return "allowed";
    return options.prohibitionsEnabled ? "denied" : "allowed";
}
// <<< agent-herder:leaf-launch-policy <<<
const MAX_NATIVE_SESSION_DEPTH = 64

async function coordinationFetch(path, options = {}, observe) {
  const started = performance.now()
  let status
  const report = async (stage, data = {}) => {
    if (typeof observe !== "function") return
    const url = new URL(path, coordinationEndpoint)
    const sessionId = url.searchParams.get("sessionId") || (()=>{try{return JSON.parse(options.body||"{}").sessionId}catch{return undefined}})()
    try { await observe({stage,path:url.pathname,sessionId,elapsedMs:Math.round(performance.now()-started),status,...data}) } catch {}
  }
  try {
    const response = await fetch(`${coordinationEndpoint}${path}`, { ...options, signal: AbortSignal.timeout(1200) })
    status = response.status
    if (!response.ok) { await report("http_refused"); return null }
    const data = await response.json()
    await report("json", {humanStopHeld:typeof data?.humanStopHeld==="boolean"?data.humanStopHeld:undefined,activeInboxCount:Array.isArray(data?.activeInboxIds)?data.activeInboxIds.length:undefined,hasActiveContext:typeof data?.activeInboxContext==="string"&&data.activeInboxContext.length>0})
    return data
  } catch (error) {
    await report("error", {errorType:["Error","TypeError","SyntaxError","DOMException"].includes(error?.constructor?.name)?error.constructor.name:"unknown",errorName:["AbortError","TimeoutError","TypeError","SyntaxError"].includes(error?.name)?error.name:"other"})
    throw error
  }
}

/**
 * Whether the owner left the prohibitions on.
 *
 * The owner switches them from the panel (the section "Хуки"). While they are
 * on, the guard below forbids what the rule of the owner forbids. When the
 * owner switches them off, the guard stops forbidding anything: the work of
 * the session continues. The state is read from the same service the panel
 * writes, and it is remembered for two seconds, so a model request does not
 * wait for the network.
 */
let prohibitionsState = { at: 0, enabled: true }

async function prohibitionsEnabledByOwner() {
  const now = Date.now()
  if (now - prohibitionsState.at < 2000) return prohibitionsState.enabled
  let enabled = true
  try {
    const response = await fetch(`${coordinationEndpoint}/api/hooks/prohibitions`, { signal: AbortSignal.timeout(900) })
    if (response.ok) {
      const data = await response.json()
      if (data?.known === true) enabled = data.prohibitionsEnabled !== false
    }
  } catch { /* the service is unreachable: the prohibitions stay as they were */ }
  prohibitionsState = { at: now, enabled }
  return enabled
}

function coordinationPaths(value, out = new Set()) {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\*\*\* (?:Update|Add|Delete) File:\s*([^\n]+)/g)) out.add(match[1].trim())
    return out
  }
  if (Array.isArray(value)) { for (const item of value) coordinationPaths(item, out); return out }
  if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
    if (/^(path|file|file_path|filepath|filename)$/i.test(key) && typeof item === "string") out.add(item)
    else if (/^(paths|files)$/i.test(key) && Array.isArray(item)) for (const path of item) if (typeof path === "string") out.add(path)
    coordinationPaths(item, out)
  }
  return out
}

function coordinationIsWriteActivity(tool, args) {
  const name = String(tool || "").toLowerCase()
  if (/(?:write|edit|patch|apply_patch|create_file|delete_file|move_file|rename_file)/.test(name)) return true
  if (!/(?:bash|shell|terminal|exec|command)/.test(name)) return false
  const command = typeof args === "string" ? args : String(args?.command || args?.cmd || args?.script || "")
  return [
    /(?:^|[;&|\s])sed\s+-[^\n;]*\bi[^\n;]*/,
    /(?:^|[;&|\s])perl\s+-[^\n;]*\bi[^\n;]*/,
    /(?:^|[;&|\s])(?:tee|cp|mv|rm|touch|mkdir|truncate|install)(?:\s|$)/,
    /(?:^|[;&|\s])git\s+(?:checkout|restore|apply|mv|rm)(?:\s|$)/,
    /(?:^|[^<])>{1,2}\s*[^&]/,
  ].some((pattern) => pattern.test(command))
}

async function recordCoordinationActivity(sessionID, directory, tool, args) {
  if (!sessionID) return null
  const paths = coordinationIsWriteActivity(tool, args) ? [...coordinationPaths(args)].map((path) => path.replace(/^\.\//, "")).filter((path) => path && !path.startsWith("../")).slice(0, 32) : []
  if (!paths.length) return null
  return coordinationFetch("/api/coordination/activity", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ harness: "opencode", sessionId: sessionID, cwd: directory, paths }),
  })
}

function actionOf(value) {
  const action = String(value || "").trim().split(/\s+/)[0].toLowerCase()
  return ["on", "status", "off"].includes(action) ? action : "on"
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function responseData(value) {
  return value && typeof value === "object" && "data" in value ? value.data : value
}

function nativeSessionDirectory(session) {
  const value = session?.directory || session?.location?.directory || session?.cwd
  return typeof value === "string" && value.trim() ? value.replace(/\\/g, "/").replace(/\/+$/, "") : undefined
}

function nativeSessionParent(session) {
  const value = session?.parentID ?? session?.parentId
  return typeof value === "string" && value.trim() ? value : undefined
}

async function restrictedNativeRoot(ctx, sessionID) {
  if (typeof sessionID !== "string" || !sessionID || typeof ctx.session?.get !== "function") return { known: false }
  const visited = new Set()
  let currentId = sessionID
  let current
  for (let depth = 0; depth < MAX_NATIVE_SESSION_DEPTH; depth += 1) {
    if (visited.has(currentId)) return { known: false }
    visited.add(currentId)
    current = responseData(await ctx.session.get({ sessionID: currentId }))
    if (!plainObject(current) || current.id !== currentId) return { known: false }
    const parentID = nativeSessionParent(current)
    if (!parentID) {
      const directory = nativeSessionDirectory(current)
      return directory && restrictedProjectRoots.has(directory)
        ? { known: true, restricted: true, root: current }
        : directory ? { known: true, restricted: false, root: current } : { known: false }
    }
    currentId = parentID
  }
  return { known: false }
}

function nativeModelRef(value) {
  if (typeof value === "string") {
    const slash = value.indexOf("/")
    if (slash <= 0 || slash === value.length - 1 || value.trim() !== value) return undefined
    return { providerID: value.slice(0, slash), id: value.slice(slash + 1) }
  }
  if (!plainObject(value)) return undefined
  const providerID = value.providerID || value.providerId
  const id = value.id || value.model
  return typeof providerID === "string" && providerID && typeof id === "string" && id
    ? { providerID, id } : undefined
}

/**
 * The answer of the guard about the route of a model.
 *
 * The contract of the owner, in one place:
 * - `closed-provider` — the provider the owner closed (codex, claude,
 *   anthropic): refused always, the switch of the owner does not open it;
 * - `route-broken` — the local route proof is broken (unavailable, mismatched,
 *   malformed): the integrity of the route is broken, and the switch of the
 *   owner does not repair a broken proof;
 * - `route-forbidden` — the leaf is not confirmed, or it is not of an allowed
 *   family: refused while the prohibitions are on, and allowed when the owner
 *   switches them off, so the work of the session continues;
 * - undefined — the route may run.
 *
 * The switch of the owner is read only when the answer depends on it, exactly
 * as before.
 */
async function routeDenial(route) {
  if (route.kind === "proof-broken") return "route-broken"
  if (route.kind === "unconfirmed") return (await prohibitionsEnabledByOwner()) ? "route-forbidden" : undefined
  if (route.leaves.some(isClosedProviderLeaf)) return "closed-provider"
  if (route.leaves.every(isLeafAllowedByOwnerRule)) return undefined
  return (await prohibitionsEnabledByOwner()) ? "route-forbidden" : undefined
}

/** The words of one refusal: the closed provider is named apart from the route. */
function refusalMessage(denial, messages) {
  return denial === "closed-provider" ? messages.closedProvider : messages.routeForbidden
}

const PLUGIN_BUILD_ID = "native-route-proof-v2"
const HERDER_ROUTE_PROOF_PATH = "/api/native-model-route-proof"

/**
 * The route of the model of a session, as far as it could be read.
 *
 * The three answers mean different things and are kept apart on purpose:
 * - `leaves` — the route is proven, and the leaves are the routes of the
 *   provider behind the model;
 * - `proof-broken` — the local route proof could not be read, did not match,
 *   or was malformed. The integrity of the route is broken, and the switch of
 *   the owner does not repair a broken proof;
 * - `unconfirmed` — the leaf could not be confirmed (the model is not in the
 *   native catalog). The switch of the owner decides this one.
 */
function provenRoute(leaves) {
  return { kind: "leaves", leaves };
}

function brokenProofRoute() {
  return { kind: "proof-broken" };
}

function unconfirmedRoute() {
  return { kind: "unconfirmed" };
}

async function resolveNativeModelRoute(ctx, value) {
  const model = nativeModelRef(value)
  if (!model || typeof ctx.model?.list !== "function") return unconfirmedRoute()
  let available
  try { available = responseData(await ctx.model.list()) } catch { return unconfirmedRoute() }
  if (!Array.isArray(available)) return unconfirmedRoute()
  const entry = available.find(item => item?.providerID === model.providerID && item?.id === model.id)
  if (!entry) return unconfirmedRoute()
  if (model.providerID !== "omniroute") return provenRoute([{ providerId: model.providerID, modelId: model.id }])
  if (typeof fetch !== "function") return brokenProofRoute()
  // The catalog id is the OpenCode-side name of the model. The route proof is
  // about the provider-facing model id that the gateway receives upstream, and
  // that is the id the gateway catalog and its mappings are keyed by.
  const modelID = typeof entry.modelID === "string" && entry.modelID.trim() ? entry.modelID.trim() : model.id
  const nativeModelId = `${model.providerID}/${modelID}`
  let url
  try {
    const endpoint = process.env.AGENT_HERDER_URL || coordinationEndpoint
    url = new URL(HERDER_ROUTE_PROOF_PATH, endpoint)
    if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password) return brokenProofRoute()
    url.searchParams.set("modelId", nativeModelId)
  } catch { return brokenProofRoute() }
  try {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) return brokenProofRoute()
    const proof = responseData(await response.json())
    const leaves = proof?.resolvedProviderLeaves
    if (!plainObject(proof) || proof.nativeHarness !== "opencode" || proof.nativeModelId !== nativeModelId
      || !Array.isArray(leaves) || leaves.length === 0 || leaves.length > 64) return brokenProofRoute()
    const result = []
    const seen = new Set()
    for (const leaf of leaves) {
      if (!plainObject(leaf) || typeof leaf.providerId !== "string" || !leaf.providerId.trim()
        || typeof leaf.modelId !== "string" || !leaf.modelId.trim()) return brokenProofRoute()
      const key = `${leaf.providerId}\0${leaf.modelId}`
      if (seen.has(key)) return brokenProofRoute()
      seen.add(key)
      result.push({ providerId: leaf.providerId, modelId: leaf.modelId })
    }
    return provenRoute(result)
  } catch { return brokenProofRoute() }
}

async function enforceRestrictedSubagent(ctx, event) {
  if (event.action !== "subagent") return
  let lineage
  try { lineage = await restrictedNativeRoot(ctx, event.sessionID) } catch { lineage = { known: false } }
  if (!lineage.known) {
    event.effect = "deny"
    event.message = "Agent Herder cannot verify this session's project lineage, so child-agent admission is denied."
    return
  }
  if (!lineage.restricted) return
  const target = Array.isArray(event.resources) && event.resources.length === 1 ? event.resources[0] : undefined
  if (typeof target !== "string" || !target || typeof ctx.agent?.get !== "function") {
    event.effect = "deny"
    event.message = "Agent Herder requires one exact child-agent identity and verifiable model route in this project."
    return
  }
  try {
    const parentSession = responseData(await ctx.session.get({ sessionID: event.sessionID }))
    const configured = responseData(await ctx.agent.get({ agentID: target }))
    const model = configured?.model ?? parentSession?.model
    // ORCHESTRATOR-CONFLICT: integrations/opencode/agent-herder-autopilot.js:392 — контракт гарда L70 в старте листа: его код смотрит закрытого провайдера только по листьям маршрута, наш контракт fail-closed на сломанной proof + отказ закрытого провайдера всегда + неподтверждённый leaf по выключателю: его код / наш контракт; ждёт решения владельца
    // РЕШЕНО 24.10.2026 измерением: наш контракт (L70, routeDenial). Его вариант (616312f:187-212) даёт 9/16 тестов гарда и вообще не читает выключатель «Хуки» панели; наш: closed-provider и сломанная proof — отказ всегда, неподтверждённый leaf — по выключателю.
    const route = await resolveNativeModelRoute(ctx, model)
    const denial = await routeDenial(route)
    if (denial) {
      event.effect = "deny"
      event.message = refusalMessage(denial, LEAF_LAUNCH_REFUSAL_MESSAGES.subagent)
    }
    return
  } catch { /* the route could not be read at all: the leaf is not confirmed */ }
    // РЕШЕНО 24.10.2026 слиянием (лист L19): его WIP (рабочее дерево владельца, 23.10) добавлял выключатель запретов `prohibitionsEnabledByOwner()` — сохранена ПОБАЙТНО (sha256 блока совпадает с его файлом, строки 155-168) и она уже подключена к гарду через routeDenial (строки 285, 288). Его вариант функции гарда (его :214-247) заменён на наш контракт L70; его хардкод-регекс `restrictedModelToken` заменён единым источником LEAF_LAUNCH_POLICY (single-source, 21/21).
  if (!(await prohibitionsEnabledByOwner())) return
  // ORCHESTRATOR-CONFLICT: integrations/opencode/agent-herder-autopilot.js:391 — гард в старте листа: взят наш контракт routeDenial. Его вариант (resolveNativeModelLeaves/hasRestrictedProviderLeaf) ссылается на функции, которых в слитом файле НЕТ (измерено: определения отсутствуют, остались только вызовы) — его текст дал бы ReferenceError в рантайме; его семантика (закрытый провайдер — отказ всегда, выключатель запретов уважается) сохранена в routeDenial; его вариант не отказывал маршрут вне разрешённых семейств при включённых запретах — ломал бы tests/leaf-launch-policy-single-source.test.ts.
  event.effect = "deny"
  event.message = LEAF_LAUNCH_REFUSAL_MESSAGES.subagent.routeForbidden
}

async function enforceRestrictedModelRequest(ctx, event) {
  let lineage
  try { lineage = await restrictedNativeRoot(ctx, event.sessionID) } catch { lineage = { known: false } }
  if (!lineage.known) throw new Error("Agent Herder cannot verify the native session lineage; model request is denied.")
  if (!lineage.restricted) return
  // The route of the model, and the contract of the owner about it: the
  // providers the owner closed stay closed whatever the switch says, a broken
  // proof is not repaired by the switch, and a route that is merely not
  // confirmed follows the switch of the owner.
  // ORCHESTRATOR-CONFLICT: integrations/opencode/agent-herder-autopilot.js:415 — контракт гарда L70 в запросе модели: его код отказывает только по закрытому провайдеру среди листьев, наш контракт различает closed-provider и route-forbidden и fail-closed при сломанной proof: его код / наш контракт; ждёт решения владельца
  // РЕШЕНО 24.10.2026 измерением: наш контракт (L70, routeDenial). Его вариант (616312f:214-223) даёт 9/16 тестов гарда, общий текст отказа и без выключателя. Сняты 5 лишних строк (были 423-427): хвост его варианта инвертировал решение и отбивал доказанный разрешённый маршрут при включённых запретах — гард 13/16 -> 16/16.
  const route = await resolveNativeModelRoute(ctx, event.model)
  const denial = await routeDenial(route)
  if (denial === "closed-provider") {
    throw new Error(LEAF_LAUNCH_REFUSAL_MESSAGES.modelRequest.closedProvider)
  }
  if (denial) {
    throw new Error(LEAF_LAUNCH_REFUSAL_MESSAGES.modelRequest.routeForbidden)
  // РЕШЕНО 24.10.2026 слиянием (лист L19): хвост его варианта (5 строк: проверка выключателя перед отказом) снят — он инвертировал решение гарда и отбивал доказанный разрешённый маршрут при включённых запретах (гард 13/16 -> 16/16). Его выключатель сохранён и подключён внутри routeDenial: выключатель ВЫКЛЮЧЕН => route-forbidden не отказывает (регресс-тест tests/opencode-prohibitions-switch.test.ts).
  // ORCHESTRATOR-CONFLICT: integrations/opencode/agent-herder-autopilot.js:429 — гард в запросе модели: тот же выбор по тем же причинам (нет определений resolveNativeModelLeaves/hasRestrictedProviderLeaf в слитом файле; нет различения closed-provider/route-forbidden; нет fail-closed на сломанной proof). Наш routeDenial закрывает оба случая и уважает выключатель запретов.
  }
  // ORCHESTRATOR-CONFLICT: integrations/opencode/agent-herder-autopilot.js:433 — снят хвост его WIP в enforceRestrictedModelRequest («маршрут не прочитан → отказ при включённых запретах»), который слился ЧИСТЫМ (вне конфликтных хунктов) и ломал разрешённый путь: в нашей функции нет раннего return для разрешённого маршрута, поэтому этот throw срабатывал на каждом разрешённом запросе — измерение: 4 красных теста (tests/leaf-launch-policy-single-source.test.ts, tests/opencode-native-subagent-guard.test.ts), на чистом c80c5f6 те же 37 тестов зелёные. Его смысл уже внутри нашего routeDenial (unconfirmed → route-forbidden при включённых запретах, разрешено при выключенных), а fail-closed на сломанной proof — наш контракт (L19: хвост его варианта был снят тем же измерением, гард 13/16 -> 16/16).
}

async function installRestrictedProviderGuards(ctx) {
  if (typeof ctx.permission?.hook !== "function" || typeof ctx.session?.hook !== "function") {
    throw new Error("Agent Herder restricted-provider guard requires OpenCode V2 permission.evaluate and session.model.request hooks")
  }
  const permission = await ctx.permission.hook("evaluate", event => enforceRestrictedSubagent(ctx, event))
  const model = await ctx.session.hook("model.request", event => enforceRestrictedModelRequest(ctx, event))
  return async () => {
    await Promise.allSettled([permission?.dispose?.(), model?.dispose?.()])
  }
}

function nativeRole(message) {
  return message?.role || message?.type
}

function nativeProviderModel(message) {
  return {
    providerId: message?.providerID || message?.model?.providerID,
    modelId: message?.modelID || message?.model?.id,
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (!plainObject(value)) return JSON.stringify(value)
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`
}

function explicitQuotaError(error) {
  if (!plainObject(error)) return false
  const statusCode = Number(error.statusCode ?? error.status)
  if ([401, 403, 502].includes(statusCode)) return false
  const code = String(error.code || error.name || error.type || "").toLowerCase()
  const message = String(error.message || "").toLowerCase()
  return /quota|usage[_ -]?limit|limit[_ -]?exceeded/.test(code)
    || /quota exhausted|quota exceeded|weekly limit|monthly limit|usage limit|plan limit|limit exceeded|plan exhausted/.test(message)
}

function safeQuotaProofError(error) {
  const code = String(error.code || error.name || error.type || "").trim()
  const safeCode = /^[A-Za-z0-9_.-]{1,96}$/.test(code) ? code : undefined
  const message = String(error.message || "").trim()
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted-private-key]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|rk|pk|ghp|glpat|xox[baprs])-[-A-Za-z0-9_]{8,}\b/gi, "[redacted-key]")
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1[redacted]")
    .replace(/\s+/g, " ").slice(0, 320)
  const statusValue = Number(error.statusCode ?? error.status)
  const statusCode = Number.isInteger(statusValue) && statusValue >= 100 && statusValue <= 599 ? statusValue : undefined
  return {
    ...(safeCode ? { errorCode: safeCode } : {}),
    ...(message ? { errorMessage: message } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
  }
}

function createQuotaProofWriter(client) {
  const writes = new Map()
  return async candidate => {
    const previous = writes.get(candidate.sessionID) || Promise.resolve()
    const next = previous.catch(() => {}).then(async () => {
      const [sessionResponse, messagesResponse] = await Promise.all([
        client.session.get({ path: { id: candidate.sessionID } }),
        client.session.messages({ path: { id: candidate.sessionID }, query: { order: "asc", limit: 150 } }),
      ])
      const session = responseData(sessionResponse)
      const messages = responseData(messagesResponse)
      if (!plainObject(session) || session.id !== candidate.sessionID || session.outcome !== "failed" || !Array.isArray(messages)) return false
      const assistant = messages.map(item => item?.info || item).find(item => item?.id === candidate.assistantMessageId)
      const user = messages.map(item => item?.info || item).find(item => item?.id === candidate.userMessageId)
      const assistantModel = nativeProviderModel(assistant)
      const assistantError = plainObject(assistant?.error)
        ? { ...assistant.error, statusCode: assistant.statusCode ?? assistant.error.statusCode ?? assistant.error.status ?? candidate.statusCode }
        : assistant?.error
      if (!assistant || !user || nativeRole(assistant) !== "assistant" || nativeRole(user) !== "user"
        || assistant.parentID !== user.id || !explicitQuotaError(assistantError)
        || assistantModel.providerId !== candidate.providerId || assistantModel.modelId !== candidate.modelId) return false
      const assistantIndex = messages.findIndex(item => (item?.info || item)?.id === assistant.id)
      if (messages.slice(assistantIndex + 1).some(item => ["assistant", "user"].includes(nativeRole(item?.info || item)))) return false
      const userMetadata = plainObject(user.metadata) ? user.metadata : {}
      const stableInputId = typeof userMetadata.agentHerderInputId === "string" && userMetadata.agentHerderInputId
        ? userMetadata.agentHerderInputId : user.id
      if (candidate.inputId && candidate.inputId !== stableInputId) return false
      const proof = {
        version: 1,
        status: "failed",
        inputId: stableInputId,
        userMessageId: user.id,
        parentMessageId: assistant.parentID,
        assistantMessageId: assistant.id,
        nativeTurnId: assistant.id,
        providerId: candidate.providerId,
        modelId: candidate.modelId,
        ...safeQuotaProofError(assistantError),
      }
      const metadata = session.metadata
      if (!plainObject(metadata)) return false
      const namespace = metadata.agentHerder
      if (namespace !== undefined && !plainObject(namespace)) return false
      const expected = {
        ...metadata,
        agentHerder: { ...(namespace || {}), quotaFailure: proof },
      }
      await client.session.update({ path: { id: candidate.sessionID }, body: { metadata: expected } })
      const readback = responseData(await client.session.get({ path: { id: candidate.sessionID } }))
      return plainObject(readback?.metadata) && stableJson(readback.metadata) === stableJson(expected)
    })
    writes.set(candidate.sessionID, next)
    try { return await next } finally { if (writes.get(candidate.sessionID) === next) writes.delete(candidate.sessionID) }
  }
}

function createQuotaEventHandler(client) {
  const quotaCandidates = new Map()
  const writeQuotaProof = createQuotaProofWriter(client)
  return async event => {
    if (event.type === "message.updated") {
      const info = event.properties?.info
      const sessionID = info?.sessionID || event.properties?.sessionID
      const metadata = plainObject(info?.metadata) ? info.metadata : {}
      const model = nativeProviderModel(info)
      const nativeError = plainObject(info?.error)
        ? { ...info.error, statusCode: info.statusCode ?? info.error.statusCode ?? info.error.status }
        : info?.error
      const statusCode = typeof info?.statusCode === "number" ? info.statusCode
        : typeof info?.error?.statusCode === "number" ? info.error.statusCode
          : typeof info?.error?.status === "number" ? info.error.status : undefined
      if (sessionID && nativeRole(info) === "assistant" && typeof info.id === "string"
        && typeof info.parentID === "string" && typeof model.providerId === "string"
        && typeof model.modelId === "string" && explicitQuotaError(nativeError)) {
        quotaCandidates.set(sessionID, {
          sessionID,
          assistantMessageId: info.id,
          userMessageId: info.parentID,
          ...(typeof metadata.agentHerderInputId === "string" ? { inputId: metadata.agentHerderInputId } : {}),
          providerId: model.providerId,
          modelId: model.modelId,
          ...(statusCode !== undefined ? { statusCode } : {}),
        })
      }
      return
    }
    if (event.type !== "session.idle") return
    const sessionID = event.properties?.sessionID
    if (!sessionID) return
    const quotaCandidate = quotaCandidates.get(sessionID)
    quotaCandidates.delete(sessionID)
    if (quotaCandidate) {
      try { await writeQuotaProof(quotaCandidate) } catch { /* missing or changed native proof stays absent */ }
    }
  }
}

function installV2QuotaEventObserver(ctx) {
  const handleEvent = createQuotaEventHandler(ctx)
  const controller = new AbortController()
  const events = ctx.event.subscribe({ signal: controller.signal })
  const consumer = (async () => {
    for await (const event of events) await handleEvent(event)
  })()
  void consumer.catch(() => { /* OpenCode owns event stream errors and plugin teardown */ })
  return async () => {
    controller.abort()
    await consumer.catch(() => {})
  }
}

async function invoke($, payload) {
  const result = await $`env PLUGIN_ROOT=${root} bash ${root}/scripts/autopilot-command-launcher.sh ${JSON.stringify(payload)}`.quiet()
  return JSON.parse(result.text())
}

async function createV1Hooks({ directory, $, client }, options = {}) {
  const contextFetch = (path, fetchOptions) => coordinationFetch(path, fetchOptions, options.observeContextFetch)
  const enabled = new Set()
  const controlTurns = new Set()
  const handleQuotaEvent = createQuotaEventHandler(client)
  return {
    // Supported native loop context hook. No prompt endpoint or persisted user message.
    "experimental.chat.messages.transform": async (_input,output)=>{
      const user=[...(output.messages||[])].reverse().find(m=>m.info?.role==='user');
      const sessionID=user?.info?.sessionID,activeTurnId=user?.info?.id;
      const textPart=user?.parts?.findLast(p=>p.type==='text'&&typeof p.text==='string');
      if(!sessionID||!activeTurnId||!textPart)return;
      try{
        const q=new URLSearchParams({harness:'opencode',sessionId:sessionID,cwd:directory,activeTurnId,consumeActive:'1'});
        const data=await contextFetch(`/api/coordination/context?${q}`);
        if(!data?.activeInboxIds?.length||!data.activeInboxContext)return;
        textPart.text+='\n\n'+data.activeInboxContext;
        await contextFetch('/api/coordination/inbox-ack',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:sessionID,ids:data.activeInboxIds})});
      }catch{}
    },
    "experimental.chat.system.transform": async ({ sessionID }, output) => {
      if (!sessionID || !Array.isArray(output.system)) return
      try {
        const q = new URLSearchParams({ harness: "opencode", sessionId: sessionID, cwd: directory, touch: "1", consume: "1" })
        const data = await contextFetch(`/api/coordination/context?${q}`)
        if (data?.context) {
          output.system.push(data.context)
          if (data.inboxIds?.length) await contextFetch("/api/coordination/inbox-ack", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sessionId:sessionID,ids:data.inboxIds})})
        }
      } catch {}
    },
    "tool.execute.before": async ({ sessionID, tool }, output) => {
      try { await recordCoordinationActivity(sessionID, directory, tool, output.args) } catch {}
    },
    "tool.execute.after": async ({ sessionID, tool, args }) => {
      try { await recordCoordinationActivity(sessionID, directory, tool, args) } catch {}
    },
    config: async (config) => {
      config.command ||= {}
      config.command.autopilot = {
        description: "Включить Agent Herder autopilot для текущей сессии [on|status|off]",
        template: "Agent Herder autopilot control.",
      }
    },
    "command.execute.before": async ({ command, sessionID, arguments: args }, output) => {
      if (command !== "autopilot") return
      const action = actionOf(args)
      controlTurns.add(sessionID)
      const result = await invoke($, { command: action, harness: "opencode", sessionId: sessionID, cwd: directory })
      if (action === "on") enabled.add(sessionID)
      if (action === "off") enabled.delete(sessionID)
      output.parts.splice(0, output.parts.length, {
        type: "text",
        text: `Autopilot ${result.enabled ? "включён" : "выключен"} для текущей OpenCode-сессии (${sessionID}).`,
        synthetic: true,
      })
    },

    event: async ({ event }) => {
      await handleQuotaEvent(event)
      if (event.type !== "session.idle") return
      const sessionID = event.properties?.sessionID
      if (!sessionID) return
      if (controlTurns.delete(sessionID)) return
      if (!enabled.has(sessionID)) {
        const status = await invoke($, { command: "status", harness: "opencode", sessionId: sessionID, cwd: directory })
        if (!status.enabled) return
        enabled.add(sessionID)
      }
      await invoke($, {
        command: "stop",
        harness: "opencode",
        sessionId: sessionID,
        turnId: event.id || `idle-${Date.now()}`,
        cwd: directory,
      })
    },
  }
}

export default {
  id: "agent-herder-autopilot",
  async setup(ctx) {
    console.info(`[agent-herder-autopilot] build=${PLUGIN_BUILD_ID}`)
    const cleanupRestrictedGuards = await installRestrictedProviderGuards(ctx)
    const cleanupQuotaObserver = installV2QuotaEventObserver(ctx)
    return async () => {
      await Promise.allSettled([cleanupQuotaObserver(), cleanupRestrictedGuards()])
    }
  },
  async server(input, options = {}) {
    return createV1Hooks(input, options)
  },
}
