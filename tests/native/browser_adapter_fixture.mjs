// Chrome loads provider documents and API responses from loopback HTTPS.
// The public owner uses either its own extension or the direct-CDP stand.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { buffer as readBytes, json as readJson } from "node:stream/consumers";
import { build as buildExtension } from "../../integrations/chrome/agent-herder/build.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright-core");
const [harness, originPort, evidenceDir, ...options] = process.argv.slice(2);
let useExtension = false;
let replyMode;
for (let i = 0; i < options.length; i++) {
  if (options[i] === "--echo") replyMode = options[i];
  else if (options[i] === "--extension") useExtension = true;
  else throw Error("unknown fixture option: " + options[i]);
}
const origin = { chatgpt: "https://chatgpt.com", zai: "https://chat.z.ai" }[harness];
assert.ok(origin && /^[1-9]\d*$/.test(originPort));
const { hostname } = new URL(origin);
const fixtures = new URL("../../acceptance/native/", import.meta.url);
const seeds = JSON.parse(await readFile(new URL("z-ai/recent-two-chats.json", fixtures)));
const seedIds = [
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
];
const accountName = "local-" + harness + "-fixture";
let account = accountName;
const chats = new Map();
const sends = [];
const files = new Map();
const uploads = [];
const downloads = [];
const stops = [];
const active = new Map();
let holdNext = false;
let withholdAfter = null;
let failNext = false;
let supersedeOnInput = null;
let superseded = false;
const requests = {};
const documents = [];
const unexpected = [];
for (const [i, seed] of seeds.entries()) {
  chats.set(seedIds[i], Object.values(seed.data).map(row => ({
    id: row.id, role: row.role, text: row.content,
  })));
}

function storeFile(name, mime_type, bytes) {
  const id = (harness === "chatgpt" ? "file-" : "") + randomUUID();
  const meta = { id, name, mime_type, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  files.set(id, { meta, bytes });
  return meta;
}

// These originals exist only at the provider. A local cache of sent inputs
// cannot satisfy a download from the assistant's message.
const replyOriginals = [
  { name: "answer.png", mime_type: "image/png",
    data_base64: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAADUlEQVR4nGNwOWMMRAAI/gKHQDGqxAAAAABJRU5ErkJggg==" },
  { name: "answer.bin", mime_type: "application/octet-stream",
    data_base64: Buffer.from([0x80, 0, 0xde, 0xad, 0x0a, 0xff]).toString("base64") },
];

function zaiRunStatus(id) {
  if (active.has(id)) return "running";
  return chats.get(id).at(-1)?.httpStatus === 429 ? "failed" : "completed";
}

function inventory() {
  return [...chats.keys()].map((id, i) => ({
    id, title: "Fixture " + (i + 1), create_time: 1700000000 + i,
    update_time: 1700000000 + i, updated_at: 1700000000 + i,
    ...(harness === "chatgpt" ? { async_status: active.has(id) ? 1 : 0 }
      : { last_run: { status: zaiRunStatus(id) } }),
  }));
}

function chatgptConversation(id, rows) {
  const mapping = {};
  let parent = null;
  for (const [i, row] of rows.entries()) {
    if (parent) mapping[parent].children.push(row.id);
    const attached = row.files ?? [];
    const images = attached.filter(f => f.mime_type.startsWith("image/")).map(f => ({
      content_type: "image_asset_pointer", asset_pointer: "file-service://" + f.id,
      size_bytes: f.size, width: 2, height: 1,
    }));
    const running = row.role === "assistant" && active.get(id) === parent;
    mapping[row.id] = { id: row.id, parent, children: [], message: {
      id: row.id, author: { role: row.role }, create_time: row.time ?? 1700000000 + i,
      content: { content_type: images.length ? "multimodal_text" : "text", parts: [...images, row.text] },
      metadata: { attachments: attached.map(({ id, name, mime_type, size }) => ({ id, name, mime_type, size })) },
      status: row.httpStatus === 429 ? "failed" : running ? "in_progress" : "finished_successfully",
      end_turn: !running && row.httpStatus !== 429, recipient: "all",
    } };
    parent = row.id;
  }
  return { id, conversation_id: id, title: "Fixture chat", current_node: parent, mapping,
    is_generating: active.has(id) };
}

function zaiMessages(id, rows) {
  return Object.fromEntries(rows.map((row, i) => {
    const attached = row.files ?? [];
    const inline = row.role === "assistant" ? attached.filter(f => f.mime_type.startsWith("image/")) : [];
    const message = {
      id: row.id, role: row.role, content: row.text, created_at: 1700000000 + i,
      parentId: rows[i - 1]?.id ?? null, childrenIds: rows[i + 1] ? [rows[i + 1].id] : [],
      done: !(row.role === "assistant" && active.get(id) === rows[i - 1]?.id),
      files: attached.filter(f => !inline.includes(f)).map(f => ({
        type: f.mime_type.startsWith("image/") ? "image" : "file", id: f.id, name: f.name,
        url: "/api/v1/files/" + f.id + "/content", size: f.size,
        file: { id: f.id, filename: f.name, meta: { name: f.name, content_type: f.mime_type, size: f.size } },
      })),
    };
    if (inline.length) {
      message.content_blocks = [{ type: "text", content: row.text }, ...inline.map(f => ({
        type: "image_url", name: f.name,
        image_url: { url: "data:" + f.mime_type + ";base64," + files.get(f.id).bytes.toString("base64") },
      }))];
    }
    return [row.id, message];
  }));
}

// Runs in Chrome. Only actual File objects from the picker's change event
// reach the upload endpoint, and only form submission links them to a message.
function installPage(harness, initialRows, activeInput, supersede) {
  const form = document.querySelector("form");
  const composer = form.querySelector("[contenteditable],textarea");
  const picker = document.querySelector("input[type=file]");
  const submit = form.querySelector("button[type=submit]");
  const stop = form.querySelector("button[type=button]");
  const chips = form.querySelector(".attachments");
  const uploaded = [];
  let pending = 0;
  const chatId = () => location.pathname.split("/")[2] || null;
  function controls() {
    submit.hidden = Boolean(activeInput);
    const hasText = Boolean((composer.value ?? composer.innerText).trim());
    // Z.ai 1.2.21 requires a caption even after the upload has finished.
    submit.disabled = pending > 0 || (!hasText && (harness === "zai" || !uploaded.length));
    stop.hidden = !activeInput;
  }
  async function post(path, payload) {
    const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(payload) });
    if (!response.ok) throw Error("fixture POST failed " + path);
    return response.json();
  }
  function append(row) {
    const node = document.createElement("article");
    node.className = row.role + "-message";
    node.dataset.messageAuthorRole = row.role;
    node.dataset.messageId = row.id;
    node.id = "message-" + row.id;
    node.textContent = row.text;
    for (const file of row.files ?? []) {
      if (!file.mime_type.startsWith("image/")) {
        const link = document.createElement("a");
        link.textContent = file.name;
        link.href = harness === "chatgpt" ? "/backend-api/files/" + file.id + "/download"
          : "/api/v1/files/" + file.id + "/content";
        node.append(link);
        continue;
      }
      const img = document.createElement("img");
      img.alt = file.name;
      // The displayed thumbnail deliberately differs from every original.
      img.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
      node.append(img);
    }
    document.querySelector("main").append(node);
  }
  picker.onchange = async () => {
    const selected = [...picker.files];
    pending++;
    controls();
    try {
      for (const file of selected) {
        const query = new URLSearchParams({ name: file.name, mime_type: file.type });
        const response = await fetch("/__fixture/upload?" + query, { method: "POST", body: file });
        if (!response.ok) throw Error("fixture upload failed");
        const meta = await response.json();
        uploaded.push(meta.id);
        const chip = document.createElement("span");
        if (harness === "chatgpt") {
          chip.dataset.fileId = meta.id;
          chip.dataset.testid = "file-pill";
          chip.textContent = file.name;
        } else {
          const label = document.createElement("span");
          label.className = "truncate";
          label.textContent = file.name;
          chip.append(label);
        }
        chips.append(chip);
      }
    } finally {
      picker.value = "";
      pending--;
      controls();
    }
  };
  composer.oninput = () => {
    controls();
    if (supersede && (composer.value ?? composer.innerText).startsWith("Продолжай")) {
      supersede = false;
      // Put the newer input on the provider before the extension can re-read
      // the failed boundary or click the composer.
      const request = new XMLHttpRequest();
      request.open("POST", "/__fixture/supersede", false);
      request.send(chatId());
    }
  };
  submit.addEventListener("click", () => {
    const count = Number(localStorage.getItem("fixtureSubmitClicks"));
    localStorage.setItem("fixtureSubmitClicks", String(count + 1));
  });
  form.onsubmit = async event => {
    event.preventDefault();
    if (submit.disabled || activeInput) return;
    const result = await post("/__fixture/send", {
      id: chatId(), text: composer.value ?? composer.innerText, files: uploaded.slice(),
    });
    history.replaceState({}, "", "/c/" + result.id);
    if ("value" in composer) composer.value = ""; else composer.textContent = "";
    uploaded.length = 0;
    chips.replaceChildren();
    result.rows.forEach(append);
    activeInput = result.activeInput;
    controls();
  };
  stop.onclick = async () => {
    await post("/__fixture/stop", { id: chatId(), inputMessageId: activeInput });
    activeInput = null;
    controls();
  };
  onpopstate = async () => {
    const response = await fetch("/__fixture/view/" + chatId());
    if (!response.ok) throw Error("fixture route not found");
    const data = await response.json();
    document.querySelector("main").replaceChildren();
    data.rows.forEach(append);
    activeInput = data.activeInput;
    controls();
  };
  initialRows.forEach(append);
  controls();
}

function renderPage(id) {
  const composer = harness === "chatgpt"
    ? '<div id="prompt-textarea" contenteditable="true" role="textbox" data-composer-markdown></div>'
    : '<textarea id="chat-input" placeholder="Send a Message"></textarea>';
  const stop = harness === "chatgpt"
    ? '<button type="button" data-testid="stop-button" aria-label="Stop generating" hidden>Stop</button>'
    : '<button type="button" hidden><span class="block size-3 rounded-xs bg-text-inverted">■</span></button>';
  const state = JSON.stringify([harness, chats.get(id) ?? [], active.get(id) ?? null, supersedeOnInput === id])
    .replaceAll("<", "\\u003c");
  const picker = harness === "chatgpt" ? '<input id="upload-files" type="file" multiple hidden>'
    : '<input type="file" multiple hidden>';
  return `<!doctype html><meta charset="utf-8"><title>Local browser fixture</title>
    <nav id="chat-group-tab-zai-web"></nav><main></main>
    ${harness === "zai" ? picker : ""}<form>${composer}${harness === "chatgpt" ? picker : ""}
    <div class="attachments${harness === "zai" ? " _upload-files-scope" : ""}"></div>
    <button id="send-message-button" data-testid="send-button" aria-label="Send message" type="submit">Send</button>${stop}</form>
    <script>(${installPage})(...${state});</script>`;
}

async function serve(request, response) {
  const url = new URL(request.url, "https://" + request.headers.host);
  const path = url.pathname;
  const method = request.method;
  response.setHeader("cache-control", "no-store");
  const json = (body, status = 200) =>
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  const count = key => { requests[key] = (requests[key] ?? 0) + 1; };
  const receiptUnavailable = id => withholdAfter !== null && id === sends[withholdAfter]?.id;
  const denyReceiptRead = () => {
    count("withheldReceipt");
    return json({ error: "fixture receipt unavailable" }, 503);
  };
  if (url.origin === origin) {
    if (method === "GET" && (path === "/" || /^\/c\/[a-f\d-]+$/.test(path))) {
      count("document");
      documents.push(path);
      return response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(renderPage(path.slice(3)));
    }
    if (method === "GET" && path === "/favicon.ico") return response.writeHead(204).end();
    if (method === "POST" && path === "/__fixture/supersede") {
      const id = (await readBytes(request)).toString();
      if (id !== supersedeOnInput || !chats.has(id)) return json({}, 400);
      chats.get(id).push({ id: randomUUID(), role: "user", text: "New input from the operator" });
      supersedeOnInput = null;
      superseded = true;
      return json({});
    }
    if (method === "POST" && path === "/__fixture/upload") {
      const file = storeFile(url.searchParams.get("name"), url.searchParams.get("mime_type"), await readBytes(request));
      uploads.push(file);
      return json(file);
    }
    if (method === "GET" && path.startsWith("/__fixture/view/")) {
      const id = path.slice("/__fixture/view/".length);
      return chats.has(id) ? json({ rows: chats.get(id), activeInput: active.get(id) ?? null }) : json({}, 404);
    }
    if (method === "POST" && path === "/__fixture/stop") {
      const { id, inputMessageId } = await readJson(request);
      const accepted = active.has(id) && active.get(id) === inputMessageId;
      stops.push({ id, inputMessageId, accepted });
      if (!accepted) return json({ error: "input is not generating" }, 409);
      active.delete(id);
      return json({ stopped: true });
    }
    if (method === "POST" && path === "/__fixture/send") {
      count("submit");
      const { id: addressed, text, files: selected } = await readJson(request);
      const id = addressed ?? randomUUID();
      if (addressed && !chats.has(id)) return json({ error: "unknown conversation" }, 404);
      if (active.has(id)) return json({ error: "chat is generating" }, 409);
      const turn = sends.length + 1;
      const attached = selected.map(key => files.get(key).meta);
      if (!text.trim() && (harness === "zai" || !attached.length)) return json({ error: "empty submit" }, 400);
      const replyFiles = !addressed && attached.length
        ? replyOriginals.map(f => storeFile(f.name, f.mime_type, Buffer.from(f.data_base64, "base64"))) : [];
      const rows = [
        { id: randomUUID(), role: "user", text, files: attached },
        { id: randomUUID(), role: "assistant", text: replyMode === "--echo" ? "Fixture received " + text : "Fixture answer " + turn, files: replyFiles },
      ];
      if (failNext) {
        Object.assign(rows[1], {httpStatus: 429, time: Date.now() / 1000, text: "Fixture provider returned HTTP 429"});
        failNext = false;
      }
      sends.push({ id, addressed, account, rows });
      if (!addressed) chats.set(id, []);
      chats.get(id).push(...rows);
      if (holdNext) active.set(id, rows[0].id);
      holdNext = false;
      return json({ id, rows, activeInput: active.get(id) ?? null });
    }
    // Both download services identify the original by file ID alone. The
    // adapter must prove chat/message membership before contacting one.
    const downloadMatch = harness === "chatgpt" ? path.match(/^\/backend-api\/files\/([^/]+)\/download$/) : null;
    if (method === "GET" && downloadMatch) {
      const id = downloadMatch[1];
      count("downloadLink");
      if (!files.has(id)) return json({}, 404);
      return json({ status: "success", file_name: files.get(id).meta.name,
        download_url: origin + "/backend-api/estuary/content?id=" + id });
    }
    const original = harness === "chatgpt"
      ? path === "/backend-api/estuary/content" && url.searchParams.get("id")
      : path.match(/^\/api\/v1\/files\/([^/]+)\/content$/)?.[1];
    if (method === "GET" && original) {
      const entry = files.get(original);
      if (!entry) return json({}, 404);
      downloads.push({ id: entry.meta.id, sha256: entry.meta.sha256, account });
      return response.writeHead(200, { "content-type": entry.meta.mime_type, "content-length": entry.bytes.length })
        .end(entry.bytes);
    }
    if (harness === "chatgpt" && method === "GET") {
      if (path === "/api/auth/session") {
        count("account");
        return json({ account: { id: account }, user: { id: "fixture-user" }, accessToken: "local-fixture" });
      }
      if (path === "/backend-api/conversations") {
        count("list");
        return json({ items: inventory(), total: chats.size });
      }
      const match = path.match(/^\/backend-api\/(conversations?)\/([^/]+)$/);
      if (match) {
        count("read");
        const [, endpoint, id] = match;
        if (!chats.has(id)) return json({}, 404);
        if (receiptUnavailable(id)) return denyReceiptRead();
        const conversation = chatgptConversation(id, chats.get(id));
        return endpoint === "conversation" ? json(conversation) : json({
          conversation_id: id, is_generating: active.has(id), messages: Object.values(conversation.mapping).map(n => n.message),
        });
      }
    }
    if (harness === "zai") {
      if (method === "GET" && path === "/api/v1/auths/") {
        count("account");
        return json({ id: account });
      }
      if (method === "GET" && path === "/api/v1/chats/") {
        count("list");
        return json(url.searchParams.get("page") === "1" ? inventory() : []);
      }
      const match = path.match(/^\/api\/v1\/chats\/([^/]+)(\/messages\/batch)?$/);
      if (match && (match[2] ? method === "POST" : method === "GET")) {
        const id = match[1];
        if (!chats.has(id)) return json({}, 404);
        const data = zaiMessages(id, chats.get(id));
        if (match[2]) {
          count("batch");
          if (receiptUnavailable(id)) return denyReceiptRead();
          const { ids } = await readJson(request);
          return json({ chat_id: id, data: Object.fromEntries(ids.filter(k => k in data).map(k => [k, data[k]])) });
        }
        count("read");
        return json({ id, user_id: accountName, title: "Fixture chat",
          last_run: { status: zaiRunStatus(id) },
          chat: { history: { messages: data, currentId: chats.get(id).at(-1)?.id } } });
      }
    }
  }
  unexpected.push(method + " " + url.origin + path);
  return json({ error: "unexpected fixture request" }, 404);
}

async function fixtureCertificate() {
  const dir = await mkdtemp(join(tmpdir(), "herder-fixture-tls-"));
  const keyPath = join(dir, "key.pem");
  try {
    const cert = execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt",
      "ec_paramgen_curve:P-256", "-nodes", "-keyout", keyPath, "-days", "1",
      "-subj", "/CN=" + hostname, "-addext", "subjectAltName=DNS:" + hostname]);
    return { cert, key: await readFile(keyPath) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const tls = await fixtureCertificate();
const spki = new X509Certificate(tls.cert).publicKey.export({ type: "spki", format: "der" });
const provider = createHttpsServer(tls, (request, response) => {
  serve(request, response).catch(() => {
    unexpected.push(request.method + " invalid fixture request");
    response.writeHead(400).end();
  });
});
const sink = createServer(socket => socket.destroy());
let browser;
let context;
let extensionRoot;
let worker;
try {
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  await new Promise(resolve => sink.listen(0, "127.0.0.1", resolve));
  const bypass = "<-loopback>;" + origin + ":443" + (useExtension ? ";127.0.0.1" : "");
  const localBridge = useExtension ? ", EXCLUDE 127.0.0.1" : "";
  const launchArgs = [
    "--enable-automation", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=http://127.0.0.1:" + originPort,
    "--proxy-server=http://127.0.0.1:" + sink.address().port,
    "--proxy-bypass-list=" + bypass,
    "--host-resolver-rules=MAP " + hostname + ":443 127.0.0.1:" + provider.address().port + localBridge + ", MAP * ~NOTFOUND",
    "--ignore-certificate-errors-spki-list=" + createHash("sha256").update(spki).digest("base64"),
    "--disable-quic",
  ];
  const scope = createHash("sha256").update(accountName).digest("hex");
  let env;
  if (useExtension) {
    extensionRoot = await mkdtemp(join(tmpdir(), "herder-extension-smoke-"));
    const extension = join(extensionRoot, "extension");
    await buildExtension(extension);
    const reservation = createServer();
    await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
    const host = "127.0.0.1:" + reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const token = randomBytes(32).toString("hex");
    const tokenPath = join(extensionRoot, "token");
    await writeFile(tokenPath, token + "\n", { mode: 0o600 });
    launchArgs.push(`--disable-extensions-except=${extension}`, `--load-extension=${extension}`);
    context = await chromium.launchPersistentContext(join(extensionRoot, "chrome-profile"), {
      channel: "chromium", headless: true, args: launchArgs, ignoreDefaultArgs: ["--disable-extensions"],
      executablePath: process.env.HERDER_FIXTURE_CHROMIUM || undefined,
    });
    worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
    await worker.evaluate(async ({ harness, endpoint, token }) => {
      const execute = chrome.scripting.executeScript.bind(chrome.scripting);
      const results = globalThis.fixtureCalls = [];
      chrome.scripting.executeScript = async request => {
        const op = request.args[1];
        try {
          const response = await execute(request);
          const row = typeof response[0]?.result === "string" ? JSON.parse(response[0].result) : null;
          const value = row?.value;
          results.push({ op, error: row?.error, outcome: row?.status, clicked: row?.clicked,
            value: Array.isArray(value) ? "array" : typeof value === "boolean" ? value : typeof value,
            ...(harness === "zai" && op === "recovery"
              ? { available: row?.available, lastRunStatus: row?.lastRunStatus } : {}) });
          return response;
        } catch (error) {
          results.push({ op, error: error.name });
          throw error;
        } finally {
          if (results.length > 64) results.shift();
        }
      };
      await chrome.storage.local.set({ connections: { [harness]: { endpoint, token } } });
    }, { harness, endpoint: "ws://" + host + "/browser-extension", token });
    env = {
      AHAP_BROWSER_TRANSPORT: "herder-extension",
      AHAP_BROWSER_EXTENSION_LISTEN: host,
      AHAP_BROWSER_EXTENSION_TOKEN_FILE: tokenPath,
      AHAP_BROWSER_ACCOUNT_SCOPE: scope,
    };
  } else {
    browser = await chromium.launch({ channel: "chrome", headless: true, args: launchArgs });
    context = await browser.newContext({ serviceWorkers: "block" });
  }
  context.on("request", request => {
    const url = new URL(request.url());
    if (["http:", "https:"].includes(url.protocol) && url.origin !== origin) {
      unexpected.push(request.method() + " " + url.origin + url.pathname);
    }
  });
  const page = await context.newPage();
  // Reading A while parked on B must never silently return the displayed chat.
  await page.goto(origin + "/c/" + seedIds[1]);
  let product;
  if (useExtension) {
    product = await page.evaluate(() => navigator.userAgent);
  } else {
    const session = await context.newCDPSession(page);
    const { targetInfo } = await session.send("Target.getTargetInfo");
    const browserSession = await browser.newBrowserCDPSession();
    const { browserContextIds } = await browserSession.send("Target.getBrowserContexts");
    assert.ok(browserContextIds.includes(targetInfo.browserContextId), "expected non-default Chrome context");
    const { arguments: argv } = await browserSession.send("Browser.getBrowserCommandLine");
    const prefix = "--user-data-dir=";
    const profile = argv.find(arg => arg.startsWith(prefix)).slice(prefix.length);
    const [port, wsPath] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n");
    assert.match(port, /^[1-9]\d*$/);
    assert.match(wsPath, /^\/devtools\/browser\/[\da-f-]+$/);
    ({ product } = await browserSession.send("Browser.getVersion"));
    await browserSession.detach();
    await session.detach();
    env = {
      AHAP_BROWSER_TRANSPORT: "direct-cdp",
      AHAP_BROWSER_CDP_WS_URL: "ws://127.0.0.1:" + port + wsPath,
      AHAP_BROWSER_CDP_ORIGIN_PORT: originPort,
      AHAP_BROWSER_CDP_CONTEXT_ID: targetInfo.browserContextId,
      AHAP_BROWSER_CDP_TARGET_ID: targetInfo.targetId,
      AHAP_BROWSER_ACCOUNT_SCOPE: scope,
    };
  }
  for await (const line of createInterface({ input: process.stdin })) {
    const { id, method, params } = JSON.parse(line);
    let result;
    switch (method) {
      case "setup": result = { env, seedIds, version: product, replyOriginals,
        extension: worker ? await worker.evaluate(() => chrome.runtime.getManifest().version) : null,
        userioScope: createHash("sha256").update(JSON.stringify({
          provider: harness, user_id: "fixture-user", account_id: accountName,
        })).digest("hex") }; break;
      case "waitExtension": {
        assert.ok(worker);
        const until = Date.now() + 15_000;
        result = false;
        while (!result && Date.now() < until) {
          result = await worker.evaluate(async provider => {
            const key = "connected:" + provider;
            return (await chrome.storage.session.get(key))[key] === true;
          }, harness);
          if (!result) await new Promise(resolve => setTimeout(resolve, 100));
        }
        break;
      }
      case "snapshot": result = { sends, requests, uploads, downloads, stops, active: Object.fromEntries(active),
        chatIds: [...chats.keys()], submitClicks: await page.evaluate(() => Number(localStorage.getItem("fixtureSubmitClicks"))),
        extensionCalls: worker ? await worker.evaluate(() => globalThis.fixtureCalls) : null,
        documents, unexpected, extension: useExtension, superseded, pinnedRoute: new URL(page.url()).pathname }; break;
      case "loseExtensionAck":
        await worker.evaluate(() => {
          const send = WebSocket.prototype.send;
          WebSocket.prototype.send = function (data) {
            const reply = JSON.parse(data);
            if (reply?.ok && reply.result?.status === "sent" && reply.result?.messageId) {
              WebSocket.prototype.send = send;
              this.close();
              return;
            }
            return send.call(this, data);
          };
        });
        result = true;
        break;
      case "switchAccount": account = accountName + "-other"; result = true; break;
      case "holdNext": holdNext = true; result = true; break;
      case "failNext": failNext = true; result = true; break;
      case "supersedeOnInput": supersedeOnInput = params.id; result = true; break;
      case "failedTurn": {
        const rows = chats.get(params.id);
        assert.ok(rows);
        const input = {id: randomUUID(), role: "user", text: "Original fixture task"};
        const failed = {id: randomUUID(), role: "assistant", text: "Fixture provider returned HTTP 429",
          httpStatus: 429, time: Date.now() / 1000};
        rows.push(input, failed);
        result = {inputId: input.id, turnId: failed.id, httpStatus: failed.httpStatus};
        break;
      }
      case "withholdReceipt":
        assert.equal(typeof params.enabled, "boolean");
        withholdAfter = params.enabled ? sends.length : null;
        result = true;
        break;
      case "screenshots":
        result = [];
        for (const [i, p] of context.pages().entries()) {
          const path = join(evidenceDir, "page-" + i + ".png");
          try {
            await p.screenshot({ path, timeout: 3000 });
            result.push(path);
          } catch (error) {
            if (!p.isClosed()) throw error;
          }
        }
        break;
      default: throw Error("unknown fixture method " + method);
    }
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }
} finally {
  if (browser) await browser.close();
  else await context?.close();
  if (extensionRoot) await rm(extensionRoot, { recursive: true, force: true });
  sink.close();
  provider.close();
}
