// Evaluated by value on the already-bound CDP target. Credentials and raw
// account identifiers stay in the page. Each invocation performs one operation.
async function zaiPage({op, expected, args, maxBytes}, zaiFiles, zaiStop) {
    const origin = location.origin;
    const failure = (error, extra = {}) => ({origin, error, ...extra});
    if (origin !== 'https://chat.z.ai') {
        return op === 'click' ? {origin, clicked: false} : {origin};
    }
    const {id, params} = args || {};
    const listPath = '/api/v1/chats/?page=1&type=all&channel=zai-web&project_id=';
    const chatPath = id => '/api/v1/chats/' + encodeURIComponent(id);
    const route = id => id == null ? '/' : '/c/' + id;
    const at = id => location.href === origin + route(id);
    const stateKey = Symbol.for('agent-herder.zai.submission');
    const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 256
        && id.trim() === id && !/[\x00-\x1f\x7f]/.test(id);
    const abort = reason => { throw {error: reason}; };
    const signal = AbortSignal.timeout(10_000);
    async function fetchJson(path, options = {}) {
        const response = await fetch(path, {credentials: 'same-origin', cache: 'no-store',
            mode: 'same-origin', redirect: 'error', signal, ...options});
        if (!response.ok) throw {status: response.status};
        return response.json();
    }
    async function hash(value) {
        const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
        return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
    }
    async function currentUser() {
        const user = await fetchJson('/api/v1/auths/');
        if (typeof user?.id !== 'string' || !user.id.trim()) abort('account_unverified');
        return user.id;
    }
    function checkOwner(value, user) {
        if (value?.user_id == null || String(value.user_id) !== user) abort('account_mismatch');
    }
    async function detail(id, user) {
        const chat = await fetchJson(chatPath(id));
        if (chat?.id !== id) abort('chat_mismatch');
        checkOwner(chat, user);
        return chat;
    }
    function historyIds(chat) {
        const history = chat.chat?.history?.messages;
        if (!isObject(history)) abort('invalid_history');
        return Object.keys(history);
    }
    async function batch(id, ids, user) {
        const raw = await fetchJson(chatPath(id) + '/messages/batch', {
            method: 'POST', headers: {'content-type': 'application/json'},
            body: JSON.stringify({ids}),
        });
        if (raw?.chat_id !== id || !isObject(raw.data)) abort('batch_mismatch');
        if (Object.hasOwn(raw, 'user_id')) checkOwner(raw, user);
        return raw.data;
    }

    const visible = element => element.getClientRects().length > 0 &&
        getComputedStyle(element).visibility === 'visible';
    const elements = selector => Array.from(document.querySelectorAll(selector)).filter(visible);
    const composerSelector = 'textarea[placeholder="Send a Message"], textarea#chat-input';
    const messageSelector = '[data-message-author-role], .user-message, .assistant-message';
    const chipSelector = '[data-file-chip], [data-file-id], [data-attachment-id], .file-chip, .attachment-chip, ' +
        '[data-testid*="file-chip"], [data-testid*="attachment-chip"], [data-testid="file-preview"], ' +
        '[aria-label^="Remove file" i], [aria-label^="Remove attachment" i], ' +
        '._upload-files-scope > :not(style)';
    const files = zaiFiles({abort, hash, isObject, maxBytes, signal, messageSelector, chipSelector});
    const busyStatus = status => ['running', 'pending', 'in_progress'].includes(status);
    function controls() {
        const editors = elements(composerSelector);
        const buttons = elements('button#send-message-button');
        const blocked = elements('dialog[open], [aria-modal="true"]').length > 0;
        const editor = editors.length === 1 && !editors[0].disabled && !editors[0].readOnly ? editors[0] : null;
        const form = editors.length === 1 ? editors[0].form : null;
        const stops = elements('button').filter(el =>
            el.querySelector(':scope > span.block.size-3.rounded-xs.bg-text-inverted') ||
            (form && form === el.form && el.getAttribute('aria-label') === 'Stop'));
        const button = buttons.length === 1 && (!form || form === buttons[0].form) ? buttons[0] : null;
        const stop = !blocked && editors.length === 1 && stops.length === 1 && !stops[0].disabled &&
            stops[0].getAttribute('aria-disabled') !== 'true' && (!form || stops[0].form === form)
            ? stops[0] : null;
        const phase = stops.length ? 'busy' : editor && button && !blocked ? 'idle' : 'unknown';
        const mounting = !stops.length && !blocked && buttons.length <= 1 &&
            (editors.length === 0 || (editor && !editor.value && !button));
        return {editor, button, stop, phase, mounting};
    }
    function cleanRoute(id, editor) {
        if (!at(id) || (id == null && document.querySelector(messageSelector))) return false;
        return files.selectionReady(editor, null);
    }
    function ready(id, draft) {
        const {editor, button, phase} = controls();
        return phase === 'idle' && editor.value === draft && cleanRoute(id, editor) ? {editor, button} : null;
    }
    function blankReady() {
        const {editor, phase, mounting} = controls();
        if (!cleanRoute(null, editor) || Array.from(document.querySelectorAll(composerSelector)).some(el => el.value)) {
            abort('not_blank');
        }
        if (phase === 'idle') return true;
        if (mounting) return false;
        abort('not_blank');
    }
    function nativeActivity(status, id) {
        const phase = at(id) ? controls().phase : 'unknown';
        if (phase === 'busy' || busyStatus(status)) return 'busy';
        if (phase === 'idle' || status === 'completed') return 'idle';
        return 'unknown';
    }

    let clicked = false;
    let attemptState;
    try {
        // Inspect the exact route again after awaited provider operations and
        // immediately before any focus, input, navigation or click.
        if (op === 'blank') blankReady();
        if (['prepare', 'click'].includes(op) && !ready(id, '')) abort('not_ready');
        if (op === 'open' && !ready(null, '')) abort('not_blank');
        const user = await currentUser();
        const scope = await hash(user);
        if (expected !== null && scope !== expected) abort('account_mismatch');
        const verified = (fields = {}) => ({origin, scope, scope_verified: true, chat_id: id, ...fields});
        if (op === 'account') return verified();
        if (op === 'blank') return verified({ready: blankReady()});
        if (op === 'cancel') {
            const cancelled = await zaiStop({id, input: params.input, user, at, controls, detail, batch,
                currentUser, abort, validId, busyStatus});
            return verified({input: params.input, cancelled});
        }
        if (op === 'attachment') {
            // The pinned read target may display another conversation. Resolve
            // the original only through the addressed chat and message.
            const page = location.href;
            const chat = await detail(id, user);
            const key = params.message;
            if (!historyIds(chat).includes(key)) abort('unknown_message');
            const rows = await batch(id, [key], user);
            const row = rows[key];
            if (!Object.hasOwn(rows, key) || row?.id !== key || !['user', 'assistant'].includes(row.role)) {
                abort('message_mismatch');
            }
            const file = (await files.messageFiles(row)).find(f => f.id === params.file);
            if (!file) abort('unknown_file');
            if (await currentUser() !== user) abort('account_mismatch');
            if (location.href !== page) abort('route_changed');
            const {data} = await files.original(file, maxBytes);
            if (await currentUser() !== user) abort('account_mismatch');
            if (location.href !== page) abort('route_changed');
            return verified({message: key, file: file.id,
                attachment: {name: file.name, mime_type: file.mime_type, data_base64: data}});
        }

        if (op === 'activity') {
            // Z.ai also publishes last_run in its lightweight list. Prove an
            // ownerless list row by its exact detail before trusting the row.
            const rows = await fetchJson(listPath);
            if (!Array.isArray(rows)) abort('invalid_list');
            const matching = rows.filter(row => row?.id === id);
            if (matching.length > 1) abort('ambiguous_chat');
            const row = matching[0];
            let status = row?.last_run?.status;
            if (row?.user_id != null) {
                checkOwner(row, user);
            } else {
                const chat = await detail(id, user);
                const latest = chat.last_run?.status;
                if (busyStatus(latest) || !busyStatus(status)) status = latest ?? status;
            }
            if (await currentUser() !== user) abort('account_mismatch');
            return verified({activity: nativeActivity(status, id)});
        }

        if (op === 'read') {
            const chat = await detail(id, user);
            const ids = historyIds(chat).slice(-180);
            if (!ids.every(validId)) abort('invalid_history');
            const data = Object.create(null);
            let size = 0;
            for (let offset = 0; offset < ids.length; offset += 60) {
                const part = ids.slice(offset, offset + 60);
                const raw = await batch(id, part, user);
                for (const key of part) {
                    const msg = raw[key];
                    if (!Object.hasOwn(raw, key) || !msg) continue;
                    if (msg.id !== key) abort('message_mismatch');
                    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
                    const projected = {id: key, role: msg.role,
                        attachments: (await files.messageFiles(msg)).map(files.metadata)};
                    if (typeof msg.content === 'string') projected.content = msg.content;
                    if (Array.isArray(msg.content_blocks)) {
                        if (msg.content_blocks.length > 1024) abort('projection_too_large');
                        projected.content_blocks = msg.content_blocks.map(block => ({
                            type: typeof block?.type === 'string' ? block.type : undefined,
                            content: typeof block?.content === 'string' &&
                                !(['image', 'file', 'image_url', 'file_url'].includes(block.type) && block.content.startsWith('data:'))
                                ? block.content : undefined,
                        }));
                    }
                    if (typeof msg.model === 'string') projected.model = msg.model;
                    if (Number.isSafeInteger(msg.created_at)) projected.created_at = msg.created_at;
                    if (Number.isSafeInteger(msg.timestamp)) projected.timestamp = msg.timestamp;
                    size += JSON.stringify(projected).length;
                    if (size > 210_000) abort('projection_too_large');
                    data[key] = projected;
                }
            }
            if (await currentUser() !== user) abort('account_mismatch');
            return verified({ids, data});
        }

        if (op === 'open') {
            await detail(id, user);
            if (await currentUser() !== user) abort('account_mismatch');
            const blank = ready(null, '');
            if (!blank) abort('not_blank');
            const selected = document.querySelector('button[data-selected="true"]');
            history.pushState({}, '', route(id));
            dispatchEvent(new PopStateEvent('popstate'));
            for (let attempt = 0; attempt < 24; attempt++) {
                await new Promise(resolve => setTimeout(resolve, 150));
                if (!at(id)) abort('route_changed');
                const {editor, phase} = controls();
                // pushState itself changes the URL even if the client ignored
                // popstate. Require an observable render of the destination.
                const rendered = editor !== blank.editor || document.querySelector(messageSelector)
                    || document.querySelector('button[data-selected="true"]') !== selected;
                if (editor && rendered && phase !== 'unknown') return verified({path: location.pathname});
            }
            abort('route_unconfirmed');
        }

        if (op === 'prepare') {
            let count = 0, prefix = null, known = null;
            if (id == null) {
                const rows = await fetchJson(listPath);
                if (!Array.isArray(rows)) abort('invalid_list');
                known = new Set(rows.map(row => {
                    if (!/^[a-f\d-]{12,80}$/i.test(row?.id)) abort('invalid_list');
                    if (row.user_id != null) checkOwner(row, user);
                    return row.id;
                }));
            } else {
                const chat = await detail(id, user);
                if (busyStatus(chat.last_run?.status)) abort('busy');
                const ids = historyIds(chat);
                count = ids.length;
                prefix = await hash(JSON.stringify(ids));
            }
            const ui = ready(id, '');
            if (!ui) abort('not_ready');
            const previous = globalThis[stateKey];
            if (previous?.started && !previous.receipt && (!previous.spent || previous.id == null || previous.id === id)) abort('submission_changed');
            const ticket = crypto.randomUUID();
            globalThis[stateKey] = {ticket, editor: ui.editor, id, count, prefix, known};
            return verified({ticket});
        }

        const saved = globalThis[stateKey];
        if (!saved || saved.ticket !== params?.ticket) abort('submission_changed');
        if (op === 'click') {
            if (saved.started || saved.id !== id) abort('submission_changed');
            saved.started = true;
            attemptState = saved;
            const {text, files: attachments} = params;
            saved.textDigest = await hash(text);
            saved.files = await Promise.all(attachments.map(async file => ({
                name: file.name, type: file.mime_type.toLowerCase(), digest: await hash(file.data_base64),
            })));
            if (await currentUser() !== user) abort('account_mismatch');
            const ui = ready(id, '');
            if (!ui || ui.editor !== saved.editor) abort('not_ready');
            const selection = attachments.length ? files.selectFiles(ui.editor, attachments) : null;
            function checkEditor(draft) {
                const current = controls();
                if (!at(id) || (id == null && document.querySelector(messageSelector)) ||
                    saved !== globalThis[stateKey] || current.phase !== 'idle' ||
                    current.editor !== ui.editor || current.editor.value !== draft) abort('composer_changed');
                return current;
            }
            checkEditor('');
            ui.editor.focus({preventScroll: true});
            checkEditor('');
            if (document.activeElement !== ui.editor || (!selection && !ready(id, ''))) abort('focus_changed');
            // Chrome's native textarea edit emits the normal input event in the
            // same JS task as the route/focus check. It cannot type into a
            // different document between two CDP commands.
            let inputSeen = false;
            const onInput = () => { inputSeen = ui.editor.value === text; };
            ui.editor.addEventListener('input', onInput, {once: true});
            try {
                document.execCommand('insertText', false, text);
            } finally {
                ui.editor.removeEventListener('input', onInput);
            }
            await Promise.resolve(); // allow the client to update its Send button
            if (!inputSeen) abort('input_unconfirmed');
            const sendReady = () => {
                const {button} = checkEditor(text);
                return files.selectionReady(ui.editor, selection) && !button.disabled &&
                    button.getAttribute('aria-disabled') !== 'true' ? button : null;
            };
            for (let i = 0; selection && !sendReady() && i < 64; i++) {
                await new Promise(resolve => setTimeout(resolve, 125));
            }
            if (await currentUser() !== user) abort('account_mismatch');
            const button = sendReady();
            if (!button) abort('input_unconfirmed');
            saved.spent = true;
            saved.editor = null;
            clicked = true;
            button.click();
            return verified({clicked: true});
        }

        if (op === 'receipt' && saved.spent) {
            if (saved.id == null && id == null && at(null)) return verified({pending: true});
            const found = location.pathname.match(/^\/c\/([a-f\d-]{12,80})$/i)?.[1];
            if (!found || !at(found) || (id != null && found !== id) ||
                (saved.id != null && found !== saved.id) || saved.known?.has(found)) abort('route_changed');
            saved.id = found;
            // Keep the proved native ID until the next prepare. The runner can
            // lose its reply between the browser read and the durable bind.
            if (saved.receipt) return verified({chat_id: found, user_message_id: saved.receipt});
            const chat = await detail(found, user);
            const ids = historyIds(chat);
            if (ids.length < saved.count || (saved.prefix !== null &&
                await hash(JSON.stringify(ids.slice(0, saved.count))) !== saved.prefix)) abort('history_changed');
            const added = ids.slice(saved.count);
            if (added.length > 60 || !added.every(validId)) abort('ambiguous_history');
            let messageId = null, missing = false;
            if (added.length) {
                const data = await batch(found, added, user);
                for (const key of added) {
                    const msg = data[key];
                    if (!Object.hasOwn(data, key) || !msg) { missing = true; continue; }
                    if (msg.id !== key || typeof msg.role !== 'string') abort('message_mismatch');
                    if (msg.role !== 'user') continue;
                    const text = typeof msg.content === 'string' ? msg.content :
                        msg.content_blocks?.filter(b => ['text', 'markdown'].includes(b.type)).map(b => b.content).join('\n') ?? '';
                    if (messageId !== null || await hash(text) !== saved.textDigest) abort('ambiguous_user');
                    const originals = await files.messageFiles(msg, true);
                    if (originals.length !== saved.files.length) {
                        abort('attachment_mismatch');
                    }
                    if (originals.length) {
                        if (await currentUser() !== user) abort('account_mismatch');
                        if (!at(found)) abort('route_changed');
                        const expectedFiles = saved.files.slice();
                        let remaining = maxBytes;
                        for (const file of originals) {
                            const {data, size, type} = await files.original(file, remaining);
                            remaining -= size;
                            const digest = await hash(data);
                            const index = expectedFiles.findIndex(f => f.name === file.name && f.digest === digest &&
                                (f.type === type || f.type === 'application/octet-stream' ||
                                    (type === 'application/octet-stream' && (!file.image || f.type.startsWith('image/')))));
                            if (index < 0) abort('attachment_mismatch');
                            expectedFiles.splice(index, 1);
                        }
                    }
                    messageId = key;
                }
            }
            if (await currentUser() !== user) abort('account_mismatch');
            if (!at(found) || saved !== globalThis[stateKey]) abort('route_changed');
            if (messageId !== null && !missing) {
                saved.receipt = messageId;
                return verified({chat_id: found, user_message_id: messageId});
            }
            return verified({chat_id: found, pending: true});
        }
        abort('invalid_operation');
    } catch (e) {
        const result = e?.status ? {origin, status: e.status} : failure(e?.error || 'unavailable');
        if (op === 'click' && !clicked) {
            if (attemptState && globalThis[stateKey] === attemptState) delete globalThis[stateKey];
            result.clicked = false;
        }
        return result;
    }
}
