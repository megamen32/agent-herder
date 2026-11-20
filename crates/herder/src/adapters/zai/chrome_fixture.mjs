// Test child. The only accessible provider document is fulfilled in memory.
// Closing stdin disposes this fresh Chrome process and its private profile.
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

function installFixture(delayedRender) {
    const old = 'aaaa000000000001', fresh = 'bbbb000000000002';
    const f = window.fixture = {
        old, fresh, user: 'fixture-account', owner: 'fixture-account', calls: [], clicks: 0,
        input: 0, navigations: 0, mode: '', status: null, listOwner: false, duplicate: false, wrongBatch: false,
        messages: {[old]: {'old-user': {id: 'old-user', role: 'user', content: 'same text'}}},
    };
    function render() {
        document.body.innerHTML = '<textarea placeholder="Send a Message"></textarea><button id="send-message-button" disabled>Send</button>';
        const editor = document.querySelector('textarea');
        const send = document.querySelector('button');
        editor.oninput = () => {
            f.input++;
            send.disabled = !editor.value;
        };
        send.onclick = () => {
            f.clicks++;
            const id = location.pathname.split('/')[2] || fresh;
            if (f.mode !== 'no-write') {
                const rows = f.messages[id] ||= {};
                const key = 'user-' + f.clicks;
                rows[key] = {id: key, role: 'user', content: editor.value};
                if (f.duplicate) rows['other-user'] = {...rows[key], id: 'other-user'};
            }
            editor.value = '';
            send.disabled = true;
            history.replaceState({}, '', '/c/' + id);
        };
    }
    onpopstate = () => {
        f.navigations++;
        if (f.mode === 'redirect') history.replaceState({}, '', '/');
        else render();
    };
    if (delayedRender) f.render = render;
    else render();
    window.fetch = async (path, options = {}) => {
        const url = new URL(path, location.origin);
        f.calls.push(url.pathname);
        if (url.origin !== location.origin) throw new Error('foreign fixture URL');
        if (url.pathname === '/api/v1/auths/') {
            const response = Response.json({id: f.user}, {status: f.authStatus ?? 200});
            f.afterAuth?.();
            return response;
        }
        if (url.pathname === '/api/v1/chats/') {
            if (f.mode === 'switch-on-list') f.user = 'other-account';
            return Response.json(Object.keys(f.messages).map(id => ({
                id, ...(f.listOwner ? {user_id: f.owner} : {}),
                ...(f.status ? {last_run: {status: f.status}} : {}),
            })));
        }
        const match = url.pathname.match(/^\/api\/v1\/chats\/([^/]+)(\/messages\/batch)?$/);
        if (!match || !f.messages[match[1]]) return Response.json({}, {status: 404});
        const id = match[1], rows = f.messages[id];
        if (!match[2]) return Response.json({id, user_id: f.owner,
            chat: {history: {messages: Object.fromEntries(Object.keys(rows).map(key => [key, {}]))}}});
        const {ids} = JSON.parse(options.body);
        if (ids.length > 60) throw new Error('oversized batch');
        if (f.mode === 'switch-after-read') f.user = 'other-account';
        return Response.json({chat_id: f.wrongBatch ? fresh : id,
            data: Object.fromEntries(ids.filter(key => rows[key]).map(key => [key, rows[key]]))});
    };
}

const dir = await mkdtemp(join(tmpdir(), 'herder-zai-fixture-'));
const chrome = spawn(process.env.HERDER_TEST_CHROME || 'google-chrome', [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-gpu', '--disable-quic', '--disable-dev-shm-usage',
    '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>',
    '--host-resolver-rules=MAP * ~NOTFOUND', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', '--remote-allow-origins=http://127.0.0.1:9222',
    '--user-data-dir=' + dir, ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), 'about:blank',
], {stdio: 'ignore'});
const closed = once(chrome, 'exit');
let socket;
try {
    let activePort;
    for (let attempt = 0; attempt < 100 && !activePort; attempt++) {
        if (chrome.exitCode !== null) throw new Error('fixture Chrome exited before publishing CDP');
        activePort = await readFile(join(dir, 'DevToolsActivePort'), 'utf8').catch(() => null);
        if (!activePort) await delay(50);
    }
    if (!activePort) throw new Error('fixture CDP did not start');
    const [port, path] = activePort.trim().split('\n');
    const endpoint = 'ws://127.0.0.1:' + port + path;
    socket = new WebSocket(endpoint);
    await once(socket, 'open');
    let seq = 0;
    const pending = new Map();
    function command(method, params, sessionId) {
        return new Promise((resolve, reject) => {
            const id = ++seq;
            pending.set(id, {resolve, reject});
            socket.send(JSON.stringify({id, method, params, sessionId}));
        });
    }
    const html = '<!doctype html><body><script>(' + installFixture + ')(' +
        process.argv.includes('--delayed-render') + ')</script></body>';
    socket.onmessage = async event => {
        const {id, result, error, method, params, sessionId} = JSON.parse(event.data);
        if (id) {
            const request = pending.get(id);
            pending.delete(id);
            if (error) request.reject(new Error(error.message));
            else request.resolve(result);
        } else if (method === 'Target.attachedToTarget') {
            await command('Fetch.enable', {patterns: [{urlPattern: '*'}]}, params.sessionId);
            await command('Runtime.runIfWaitingForDebugger', {}, params.sessionId);
        } else if (method === 'Fetch.requestPaused') {
            const home = params.request.url === 'https://chat.z.ai/';
            await command('Fetch.fulfillRequest', {
                requestId: params.requestId, responseCode: home ? 200 : 404,
                responseHeaders: [{name: 'content-type', value: 'text/html'}],
                body: Buffer.from(home ? html : '').toString('base64'),
            }, sessionId);
        }
    };
    const {browserContextId} = await command('Target.createBrowserContext', {});
    await command('Target.setAutoAttach', {autoAttach: true, waitForDebuggerOnStart: true,
        flatten: true, filter: [{type: 'page'}]});
    process.stdout.write(JSON.stringify({endpoint, browserContextId}) + '\n');
    process.stdin.resume();
    await once(process.stdin, 'end');
} finally {
    socket?.close();
    chrome.kill('SIGTERM');
    await closed;
    await rm(dir, {recursive: true, force: true, maxRetries: 3});
}
