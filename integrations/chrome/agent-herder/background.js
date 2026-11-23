import { providers, validEndpoint, validToken } from "./connection.js";
import { executeSite } from "./site.js";

const peers = new Map();
const anchors = new Map();
const created = new Map();
const recovering = new Set();
const retry = "herder-reconnect";
const heartbeat = JSON.stringify({ type: "heartbeat" });
const unknown = { status: "unknown" };

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const originOf = (url) => {
  try { return new URL(url).origin; } catch { return null; }
};

async function waitForTab(provider, tab) {
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    const current = await chrome.tabs.get(tab);
    const url = current.url;
    if (current.status === "complete" && url !== "about:blank") {
      if (originOf(url) !== providers[provider]) throw new Error("wrong_page");
      return url;
    }
    await sleep(100);
  }
  throw new Error("page_not_ready");
}

async function newTab(provider) {
  const tab = await chrome.tabs.create({ url: providers[provider] + "/", active: false });
  created.set(tab.id, provider);
  try {
    await waitForTab(provider, tab.id);
    return tab.id;
  } catch (error) {
    await closeTab(provider, tab.id);
    throw error;
  }
}

async function closeTab(provider, tab) {
  if (created.get(tab) !== provider) return;
  created.delete(tab);
  await chrome.tabs.remove(tab).catch(() => {});
}

chrome.tabs.onRemoved.addListener(tab => {
  created.delete(tab);
  for (const [provider, anchor] of anchors) if (anchor === tab) anchors.delete(provider);
});

async function readTab(provider) {
  // A service worker can restart independently of Chrome. Reuse its own
  // anchor only while it is still on this provider.
  const key = "anchor:" + provider;
  const saved = anchors.get(provider) ?? (await chrome.storage.session.get(key))[key];
  if (Number.isSafeInteger(saved)) {
    const tab = await chrome.tabs.get(saved).catch(() => null);
    if (originOf(tab?.url) === providers[provider]) {
      anchors.set(provider, saved);
      return saved;
    }
  }
  const tab = await newTab(provider);
  anchors.set(provider, tab);
  await chrome.storage.session.set({ [key]: tab });
  return tab;
}

async function projection(provider, tab, op, params) {
  // Chrome's script argument conversion drops null object fields. The blank
  // composer uses a null conversation ID and returns null receipt fields.
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab, frameIds: [0] },
    world: "MAIN",
    func: executeSite,
    args: [provider, op, JSON.stringify(params)],
  });
  if (typeof injection?.result !== "string") throw new Error("missing_page_result");
  return JSON.parse(injection.result);
}

async function hash(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function receiptKey(provider, { scope, id, requestKey }) {
  return "receipt:" + await hash([provider, scope, id, requestKey]);
}

async function recover(provider, tab, params) {
  const { scope, id, recovery, text, requestKey } = params;
  const nativeId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
  if (provider !== "chatgpt" || !nativeId(id) || !nativeId(recovery?.turnId) || !nativeId(recovery?.inputItemId)
      || recovery.turnId === recovery.inputItemId || !/^[a-f0-9]{64}$/u.test(scope)
      || typeof text !== "string" || !text.trim() || text.length > 8000
      || typeof requestKey !== "string" || !requestKey || requestKey.length > 4096) {
    return { status: "not_sent" };
  }
  const key = "recovery:" + await hash([provider, scope, id, recovery.turnId, recovery.inputItemId]);
  const digest = await hash([requestKey, text]);
  // A reconnect may arrive before the previous socket's handler finishes.
  if (recovering.has(key)) return unknown;
  recovering.add(key);
  try {
    const previous = (await chrome.storage.local.get(key))[key];
    if (previous) return previous.digest === digest ? previous.result : unknown;

    // Record admission before the click. After a worker restart the same
    // failed turn remains fenced until its result is known.
    await chrome.storage.local.set({ [key]: { digest, result: unknown } });
    const result = await projection(provider, tab, "recover", {
      scope, id, recovery, text, ticket: digest,
    });
    if (result?.status === "not_sent") {
      await chrome.storage.local.remove(key);
      return result;
    }
    if (result?.status === "sent" && result.id === id && nativeId(result.messageId)) {
      await chrome.storage.local.set({
        [key]: { digest, result },
        [await receiptKey(provider, params)]: result.messageId,
      });
      return result;
    }
    return unknown;
  } finally {
    recovering.delete(key);
  }
}

async function dispatch(provider, operation, args) {
  if (operation === "create") return newTab(provider);
  if (operation === "list") {
    const tabs = await chrome.tabs.query({ url: providers[provider] + "/*" });
    return tabs.filter(tab => originOf(tab.url) === providers[provider])
      .map(({ id, url }) => ({ id, url }));
  }
  if (operation === "close") {
    if (!Number.isSafeInteger(args.tab)) throw new Error("invalid_tab");
    await closeTab(provider, args.tab);
    return null;
  }
  if (operation !== "location" && operation !== "site") throw new Error("invalid_operation");
  const tab = args.tab === null ? await readTab(provider) : args.tab;
  if (!Number.isSafeInteger(tab)) throw new Error("invalid_tab");
  const href = await waitForTab(provider, tab);
  if (operation === "location") {
    const url = new URL(href);
    return { href, origin: url.origin, path: url.pathname };
  }
  if (args.op === "recover") {
    if (args.tab === null) throw new Error("invalid_tab");
    return recover(provider, tab, args.params);
  }
  if (args.op === "recovery-receipt" && provider === "chatgpt") {
    const account = await projection(provider, tab, "account", null);
    if (account?.origin !== providers[provider] ||
        ![account.scope, account.userioScope].includes(args.params.scope)) {
      throw new Error("wrong_account");
    }
    const key = await receiptKey(provider, args.params);
    return (await chrome.storage.local.get(key))[key] ?? null;
  }
  return projection(provider, tab, args.op, args.params);
}

function connect(provider, config) {
  const socket = new WebSocket(config.endpoint);
  const peer = { config, socket, ready: false, outstanding: false };
  peers.set(provider, peer);
  const send = body => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(body));
  };
  socket.addEventListener("open", () => {
    send({ type: "hello", version: 1, provider, token: config.token });
  });
  const keepAlive = setInterval(() => {
    if (peer.ready && socket.readyState === WebSocket.OPEN) socket.send(heartbeat);
  }, 20_000);
  socket.addEventListener("close", () => {
    clearInterval(keepAlive);
    if (peers.get(provider) === peer) {
      void chrome.storage.session.set({ ["connected:" + provider]: false });
      peers.delete(provider);
      setTimeout(refreshConnections, 1500);
    }
  });
  socket.addEventListener("message", async event => {
    if (peers.get(provider) !== peer) return;
    let request;
    try { request = JSON.parse(event.data); } catch { socket.close(); return; }
    if (!peer.ready) {
      if (request?.type === "ready" && request.version === 1) {
        peer.ready = true;
        void chrome.storage.session.set({ ["connected:" + provider]: true });
      }
      else socket.close();
      return;
    }
    if (!Number.isSafeInteger(request?.id) || peer.outstanding) {
      socket.close();
      return;
    }
    peer.outstanding = true;
    try {
      const result = await dispatch(provider, request.operation, request.args);
      send({ id: request.id, ok: true, result });
    } catch {
      send({ id: request.id, ok: false });
    } finally {
      peer.outstanding = false;
    }
  });
}

async function refreshConnections() {
  const { connections = {} } = await chrome.storage.local.get("connections");
  for (const provider of Object.keys(providers)) {
    const config = connections[provider];
    const peer = peers.get(provider);
    if (peer && peer.config.endpoint === config?.endpoint && peer.config.token === config.token) continue;
    peers.delete(provider);
    void chrome.storage.session.set({ ["connected:" + provider]: false });
    peer?.socket.close();
    if (validEndpoint(config?.endpoint) && validToken(config.token)) connect(provider, config);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.connections) void refreshConnections();
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === retry) void refreshConnections();
});
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
void chrome.alarms.create(retry, { periodInMinutes: 0.5 });
void refreshConnections();
