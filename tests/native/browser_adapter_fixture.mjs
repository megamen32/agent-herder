// Rust attaches over real CDP. Chrome loads each provider document and API
// response from a loopback HTTPS server, including a new target's first GET.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { json as readJson } from "node:stream/consumers";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright-core");
const [harness, originPort, evidenceDir] = process.argv.slice(2);
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
let withholdReceipt = false;
const requests = {};
const documents = [];
const unexpected = [];
for (const [i, seed] of seeds.entries()) {
  chats.set(seedIds[i], Object.values(seed.data).map(row => ({
    id: row.id, role: row.role, text: row.content,
  })));
}

function inventory() {
  return [...chats.keys()].map((id, i) => ({
    id, title: "Fixture " + (i + 1), create_time: 1700000000 + i,
    update_time: 1700000000 + i, updated_at: 1700000000 + i,
    ...(harness === "chatgpt" ? { async_status: 0 } : { last_run: { status: "completed" } }),
  }));
}

function chatgptConversation(id, rows) {
  const mapping = {};
  let parent = null;
  for (const [i, row] of rows.entries()) {
    if (parent) mapping[parent].children.push(row.id);
    mapping[row.id] = { id: row.id, parent, children: [], message: {
      id: row.id, author: { role: row.role }, create_time: 1700000000 + i,
      content: { content_type: "text", parts: [row.text] },
      status: "finished_successfully", end_turn: true, recipient: "all",
    } };
    parent = row.id;
  }
  return { id, conversation_id: id, title: "Fixture chat", current_node: parent, mapping };
}

function zaiMessages(rows) {
  return Object.fromEntries(rows.map((row, i) => [row.id, {
    id: row.id, role: row.role, content: row.text, created_at: 1700000000 + i,
    parentId: rows[i - 1]?.id ?? null, childrenIds: rows[i + 1] ? [rows[i + 1].id] : [],
  }]));
}

// This page only records a send when the browser submits its actual form.
function renderPage(initialRows) {
  const composer = harness === "chatgpt"
    ? '<div id="prompt-textarea" contenteditable="true" role="textbox" data-composer-markdown></div>'
    : '<textarea id="chat-input" placeholder="Send a Message"></textarea>';
  return `<!doctype html><meta charset="utf-8"><title>Local browser fixture</title>
    <nav id="chat-group-tab-zai-web"></nav><main></main>
    <form>${composer}<button id="send-message-button" data-testid="send-button" aria-label="Send message" type="submit">Send</button></form>
    <script>
      const composer = document.querySelector('[contenteditable],textarea');
      function append(row) {
        const node = document.createElement('article');
        node.dataset.messageAuthorRole = row.role;
        node.dataset.messageId = row.id;
        node.textContent = row.text;
        document.querySelector('main').append(node);
      }
      ${JSON.stringify(initialRows).replaceAll("<", "\\u003c")}.forEach(append);
      document.querySelector('form').onsubmit = async event => {
        event.preventDefault();
        const text = composer.value ?? composer.innerText;
        const response = await fetch('/__fixture/send', {method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({id: location.pathname.split('/')[2] || null, text})});
        if (!response.ok) throw Error('fixture submit failed');
        const {id, rows} = await response.json();
        history.replaceState({}, '', '/c/' + id);
        if ('value' in composer) composer.value = ''; else composer.textContent = '';
        rows.forEach(append);
      };
    </script>`;
}

async function serve(request, response) {
  const url = new URL(request.url, "https://" + request.headers.host);
  const path = url.pathname;
  const method = request.method;
  response.setHeader("cache-control", "no-store");
  const json = (body, status = 200) =>
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  const count = key => { requests[key] = (requests[key] ?? 0) + 1; };
  const receiptUnavailable = id => withholdReceipt && id === sends[0]?.id;
  const denyReceiptRead = () => {
    count("withheldReceipt");
    return json({ error: "fixture receipt unavailable" }, 503);
  };
  if (url.origin === origin) {
    if (method === "GET" && (path === "/" || /^\/c\/[a-f\d-]+$/.test(path))) {
      count("document");
      documents.push(path);
      return response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(renderPage(chats.get(path.slice(3)) ?? []));
    }
    if (method === "GET" && path === "/favicon.ico") return response.writeHead(204).end();
    if (method === "POST" && path === "/__fixture/send") {
      const { id: addressed, text } = await readJson(request);
      const id = addressed ?? randomUUID();
      const turn = sends.length + 1;
      const rows = [
        { id: randomUUID(), role: "user", text },
        { id: randomUUID(), role: "assistant", text: "Fixture answer " + turn },
      ];
      sends.push({ id, addressed, account, rows });
      if (!addressed) chats.set(id, []);
      if (!chats.has(id)) return json({ error: "unknown conversation" }, 404);
      chats.get(id).push(...rows);
      return json({ id, rows });
    }
    if (harness === "chatgpt" && method === "GET") {
      if (path === "/api/auth/session") {
        count("account");
        return json({ account: { id: account }, accessToken: "local-fixture" });
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
          conversation_id: id, messages: Object.values(conversation.mapping).map(n => n.message),
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
        const data = zaiMessages(chats.get(id));
        if (match[2]) {
          count("batch");
          if (receiptUnavailable(id)) return denyReceiptRead();
          const { ids } = await readJson(request);
          return json({ chat_id: id, data: Object.fromEntries(ids.filter(k => k in data).map(k => [k, data[k]])) });
        }
        count("read");
        return json({ id, user_id: account, title: "Fixture chat",
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
try {
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  await new Promise(resolve => sink.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({ channel: "chrome", headless: true, args: [
    "--enable-automation", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=http://127.0.0.1:" + originPort,
    "--proxy-server=http://127.0.0.1:" + sink.address().port,
    "--proxy-bypass-list=<-loopback>;" + origin + ":443",
    "--host-resolver-rules=MAP " + hostname + ":443 127.0.0.1:" + provider.address().port + ", MAP * ~NOTFOUND",
    "--ignore-certificate-errors-spki-list=" + createHash("sha256").update(spki).digest("base64"),
    "--disable-quic",
  ] });
  const context = await browser.newContext({ serviceWorkers: "block" });
  context.on("request", request => {
    const url = new URL(request.url());
    if (["http:", "https:"].includes(url.protocol) && url.origin !== origin) {
      unexpected.push(request.method() + " " + url.origin + url.pathname);
    }
  });
  const page = await context.newPage();
  // Reading A while parked on B must never silently return the displayed chat.
  await page.goto(origin + "/c/" + seedIds[1]);
  const session = await context.newCDPSession(page);
  const { targetInfo } = await session.send("Target.getTargetInfo");
  const browserSession = await browser.newBrowserCDPSession();
  const { browserContextIds } = await browserSession.send("Target.getBrowserContexts");
  assert.ok(browserContextIds.includes(targetInfo.browserContextId), "expected non-default Chrome context");
  // Discover the endpoint allocated by this Chrome, even with concurrent fixtures.
  const { arguments: argv } = await browserSession.send("Browser.getBrowserCommandLine");
  const prefix = "--user-data-dir=";
  const profile = argv.find(arg => arg.startsWith(prefix)).slice(prefix.length);
  const [port, wsPath] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n");
  assert.match(port, /^[1-9]\d*$/);
  assert.match(wsPath, /^\/devtools\/browser\/[\da-f-]+$/);
  const { product } = await browserSession.send("Browser.getVersion");
  await browserSession.detach();
  await session.detach();
  const env = {
    AHAP_BROWSER_TRANSPORT: "direct-cdp",
    AHAP_BROWSER_CDP_WS_URL: "ws://127.0.0.1:" + port + wsPath,
    AHAP_BROWSER_CDP_ORIGIN_PORT: originPort,
    AHAP_BROWSER_CDP_CONTEXT_ID: targetInfo.browserContextId,
    AHAP_BROWSER_CDP_TARGET_ID: targetInfo.targetId,
    AHAP_BROWSER_ACCOUNT_SCOPE: createHash("sha256").update(accountName).digest("hex"),
  };
  for await (const line of createInterface({ input: process.stdin })) {
    const { id, method, params } = JSON.parse(line);
    let result;
    switch (method) {
      case "setup": result = { env, seedIds, version: product }; break;
      case "snapshot": result = { sends, requests, documents, unexpected, pinnedRoute: new URL(page.url()).pathname }; break;
      case "switchAccount": account = accountName + "-other"; result = true; break;
      case "withholdReceipt":
        assert.equal(typeof params.enabled, "boolean");
        withholdReceipt = params.enabled;
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
  sink.close();
  provider.close();
}
