async function useChatGptComposer(request, {list, activity, conversation, newestFirst, messageText, validId, exact, surface, sameAccount, fail}) {
  const {id, text} = request;
  const witnessKey = Symbol.for('agent-herder.chatgpt.submission');
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const renderedMessage = () => document.querySelector('[data-message-author-role],[data-user-message-bubble]');
  const draft = editor => typeof editor.value === 'string' ? editor.value : editor.innerText;
  const empty = editor => !(typeof editor.value === 'string' ? editor.value : editor.textContent);
  const controls = target => {
    if (!exact(target) || (target === null && renderedMessage())) return {};
    const {editor, busy, buttons} = surface();
    const form = editor?.closest('form');
    if (!form || busy || editor.disabled || editor.readOnly || editor.getAttribute('aria-disabled') === 'true') return {};
    // The picker can live outside the form or be cleared once the upload
    // becomes a preview. The ever-present empty file picker is harmless.
    if ([...document.querySelectorAll('input[type="file"]')].some(input => input.files?.length) ||
        form.querySelector('[data-file-id],[data-testid*="file-thumbnail"],[data-testid*="file-preview"],' +
          '[data-testid*="attachment-preview"],[data-testid*="file-pill"],[data-testid*="remove-file"],' +
          '[aria-label^="Remove file" i],[aria-label^="Remove attachment" i],[aria-label^="Удалить файл" i],' +
          '[aria-label^="Удалить вложение" i]')) return {};
    const candidates = buttons.filter(b => b.form === form && (
      b.getAttribute('type')?.toLowerCase() === 'submit' || b.getAttribute('data-testid') === 'send-button' ||
      /^(Send|Send message|Send prompt|Отправить сообщение)$/i.test(b.getAttribute('aria-label') || '')
    ));
    if (candidates.length > 1) return {};
    const [button] = candidates;
    return {editor, button: button && !button.disabled && button.getAttribute('aria-disabled') !== 'true' ? button : null};
  };
  // Keep the ordered user IDs even for messages that have no visible text.
  // A changed branch must not turn a previously sent duplicate into a receipt.
  const userTail = async (target, preflight = false) => {
    const data = await conversation(target, 4);
    if (preflight && await activity(target, data) === 'busy') fail('preflight');
    const users = [];
    for (const m of newestFirst(data)) {
      if (m?.author?.role !== 'user') continue;
      if (!validId(m.id) || users.length >= 180) fail('invalid');
      users.push({id: m.id, matches: messageText(m) === text, created: m.create_time});
    }
    return users.reverse();
  };
  const inventory = async () => {
    const {items, total} = await list(0, 100);
    const rows = new Map(items.map(row => [row?.id, row]));
    if (items.length > 100 || rows.size !== items.length || [...rows.keys()].some(key => !validId(key))) fail('invalid');
    return {rows, complete: Number.isSafeInteger(total) ? total === items.length : items.length < 100};
  };
  if (request.op === 'opened') return exact(id);
  if (request.op === 'open' || request.op === 'baseline') {
    const target = request.op === 'open' ? null : id;
    // A background-created target may still be hydrating its composer.
    for (let i = 0; i < 20 && exact(target) && !surface().editor; ++i) await pause(100);
    const {editor} = controls(target);
    if (!editor || !empty(editor)) fail('preflight');
    if (request.op === 'open') {
      location.assign('/c/' + encodeURIComponent(id));
      return true;
    }
    const users = id === null ? [] : await userTail(id, true);
    const before = id === null ? await inventory() : null;
    if (controls(id).editor !== editor || !empty(editor) || (id === null && !globalThis.navigation)) fail('preflight');
    globalThis[witnessKey] = {editor, target: id, scope: request.scope,
      known: before && new Set(before.rows.keys()), complete: before?.complete, route: null};
    return users.map(user => user.id);
  }
  const witness = globalThis[witnessKey];
  const prepared = editor => editor && witness?.editor === editor && witness.target === id &&
    witness.scope === request.scope && !witness.clicked;
  if (request.op === 'fill') {
    const {editor} = controls(id);
    if (!prepared(editor) || !empty(editor)) return false;
    editor.focus();
    if (document.activeElement !== editor || controls(id).editor !== editor || !empty(editor)) return false;
    // Chromium's editing command dispatches the native input event in the
    // same JS task as the route, empty-draft and focus checks.
    let accepted = false;
    const input = () => { accepted = true; };
    editor.addEventListener('input', input);
    try { document.execCommand('insertText', false, text); }
    finally { editor.removeEventListener('input', input); }
    if (!accepted) return false;
    for (let i = 0; i < 20; ++i) {
      const ready = controls(id);
      if (ready.editor !== editor || draft(editor) !== text) return false;
      if (ready.button) {
        witness.filled = true;
        return true;
      }
      await pause(50);
    }
    return false;
  }
  // When a blank target gains a native route, it must be the site's own
  // transition in this document. A link, Back, redirect to a second chat
  // or document replacement cannot attest a first-send receipt.
  if (request.op === 'click') {
    const {editor, button} = controls(id);
    if (!prepared(editor) || !witness.filled || !button || draft(editor) !== text) return false;
    if (id === null) {
      globalThis.navigation.addEventListener('navigate', event => {
        const url = new URL(event.destination.url);
        const next = url.pathname.slice(3);
        if (event.userInitiated || event.navigationType === 'traverse' || event.sourceElement?.closest('a') ||
            url.origin !== location.origin || url.search || url.hash) witness.interrupted = true;
        if (url.pathname !== '/' || witness.route !== null) {
          if (url.pathname !== '/c/' + next || !validId(next) || (witness.route !== null && witness.route !== next)) {
            witness.interrupted = true;
          } else {
            witness.route = next;
          }
        }
      }, {signal: AbortSignal.timeout(15000)});
    }
    witness.clicked = Date.now();
    witness.editor = null;
    button.click();
    return true;
  }
  if (request.op !== 'receipt') fail('invalid');
  if (!witness?.clicked || witness.target !== id || witness.scope !== request.scope || witness.interrupted) fail('preflight');
  if (id === null && !request.observedId && exact(null)) return {id: null, messageId: null};
  const target = id ?? location.pathname.slice(3);
  const bound = () => validId(target) && exact(target) &&
    (!request.observedId || request.observedId === target) &&
    globalThis[witnessKey] === witness &&
    (id !== null || (!witness.interrupted && witness.route === target && !witness.known.has(target)));
  if (!bound()) fail('preflight');
  let users;
  try { users = await userTail(target); }
  catch (error) {
    if (id !== null || error.status !== 404 || !bound()) throw error;
    return {id: target, messageId: null};
  }
  if (!bound()) fail('preflight');
  const before = request.before;
  const anchor = before.at(-1);
  const position = anchor === undefined ? -1 : users.findIndex(m => m.id === anchor);
  if (anchor !== undefined && position === -1) fail('preflight');
  const after = users.slice(position + 1);
  if (after.length > 1 || after.some(m => before.includes(m.id) || !m.matches)) fail('preflight');
  if (id === null && after.length) {
    const now = await inventory();
    if (!bound()) fail('preflight');
    const row = now.rows.get(target);
    if (!row) return {id: target, messageId: null}; // History can arrive ahead of the new inventory entry.
    if (row.is_archived || row.is_temporary_chat) fail('preflight');
    if (witness.complete && now.complete) {
      if (now.rows.size !== witness.known.size + 1 || [...witness.known].some(key => !now.rows.has(key))) fail('preflight');
    } else {
      // An old chat outside the first inventory page can move to the front.
      // With partial coverage only native creation times can prove freshness.
      const created = typeof row.create_time === 'string' ? Date.parse(row.create_time) : row.create_time * 1000;
      if (!(created >= witness.clicked && Number.isFinite(after[0].created) &&
            after[0].created * 1000 >= witness.clicked)) fail('preflight');
    }
  }
  if (after.length && (!await sameAccount() || !bound())) fail('preflight');
  return {id: target, messageId: after[0]?.id ?? null};
}
