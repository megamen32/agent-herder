async function useChatGptComposer(request, {list, activity, conversation, newestFirst, messageText, filesOf, validId, exact, surface, sameAccount, fail}) {
  const {id, text} = request;
  const witnessKey = Symbol.for('agent-herder.chatgpt.submission');
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const renderedMessage = () => document.querySelector('[data-message-author-role],[data-user-message-bubble]');
  const draft = editor => typeof editor.value === 'string' ? editor.value : editor.innerText;
  const empty = editor => !(typeof editor.value === 'string' ? editor.value : editor.textContent);
  const inputs = () => [...document.querySelectorAll('input[type="file"]')];
  const remove = '[data-testid*="remove-file"],[aria-label^="Remove file" i],[aria-label^="Remove attachment" i],' +
    '[aria-label^="Remove image" i],[aria-label^="Удалить файл" i],[aria-label^="Удалить вложение" i],[aria-label^="Удалить изображение" i]';
  const preview = '[data-file-id],[data-attachment-id],[data-testid*="file-thumbnail"],[data-testid*="file-preview"],' +
    '[data-testid*="attachment-preview"],[data-testid*="file-pill"],[data-testid*="attachment-chip"],' + remove;
  const clean = form => !inputs().some(input => input.files.length) && !form.querySelector(preview);
  const prepareFiles = (form, attachments) => {
    const accepts = (input, file) => !input.accept.trim() || input.accept.split(',').some(pattern => {
      const token = pattern.trim().toLowerCase();
      if (token.startsWith('.')) return file.name.toLowerCase().endsWith(token);
      if (token === '*/*') return true;
      if (token.endsWith('/*')) return file.mime_type.toLowerCase().startsWith(token.slice(0, -1));
      return token === file.mime_type.toLowerCase();
    });
    const candidates = inputs().filter(input => (input.form === form ||
      (!input.form && ['upload-files', 'upload-photos'].includes(input.id))) &&
      !input.disabled && (input.multiple || attachments.length === 1) && attachments.every(f => accepts(input, f)));
    const generic = candidates.filter(input => input.id === 'upload-files');
    const pickers = generic.length ? generic : candidates;
    if (pickers.length !== 1) return null;
    const transfer = new DataTransfer();
    for (const {name, mime_type, data_base64} of attachments) {
      const bytes = Uint8Array.from(atob(data_base64), char => char.charCodeAt(0));
      transfer.items.add(new File([bytes], name, {type: mime_type}));
    }
    return {input: pickers[0], files: [...transfer.files], transfer};
  };
  const stageFiles = (form, batch, listeners) => {
    const {input, transfer} = batch;
    input.files = transfer.files;
    const change = new Event('change', {bubbles: true});
    // A second file selection or removal invalidates this transaction even
    // if its replacement happens to have the same filename.
    const options = {capture: true, signal: listeners.signal};
    document.addEventListener('change', event => {
      if (event !== change && event.target.matches?.('input[type="file"]')) batch.changed = true;
    }, options);
    form.addEventListener('click', event => {
      if (event.target.closest?.(remove)) batch.changed = true;
    }, options);
    input.dispatchEvent(new Event('input', {bubbles: true}));
    input.dispatchEvent(change);
  };
  const chipHasName = (chip, form, name) => {
    let box = chip;
    // Some versions expose only the remove control. Its single-file wrapper
    // contains the filename in a title, an image alt or a line of text.
    const labelled = node => [node, ...node.querySelectorAll('[title],[alt],[data-file-name],[data-filename]')].some(el =>
      ['title', 'alt', 'data-file-name', 'data-filename'].some(key => el.getAttribute(key) === name));
    while (box && box !== form) {
      if (labelled(box) || (box.innerText || '').split('\n').some(line => line.trim() === name)) return true;
      if (!chip.matches(remove) || !box.parentElement || box.parentElement.querySelectorAll(remove).length !== 1 ||
          box.parentElement.querySelector('textarea,[contenteditable="true"]')) break;
      box = box.parentElement;
    }
    return false;
  };
  const staged = (form, batch) => {
    if (!batch) return clean(form) ? [] : null;
    if (batch.changed) return null;
    const populated = inputs().filter(input => input.files.length);
    const selected = populated.length === 1 && populated[0] === batch.input &&
      batch.files.length === batch.input.files.length && batch.files.every((f, i) => f === batch.input.files[i]);
    if (populated.length && !selected) return null;
    const chips = [...form.querySelectorAll(preview)].filter(el => !el.parentElement?.closest(preview));
    if (chips.length && chips.length !== batch.files.length) return null;
    if (!chips.length && !selected) return null;
    const expected = [];
    for (const file of batch.files) {
      let id;
      if (chips.length) {
        const i = chips.findIndex(chip => chipHasName(chip, form, file.name));
        if (i < 0) return null;
        const [chip] = chips.splice(i, 1);
        if (chip.matches('[aria-busy="true"]') || chip.querySelector('[role="progressbar"],[aria-busy="true"]')) return null;
        const tagged = chip.matches('[data-file-id],[data-attachment-id]') ? chip :
          chip.querySelector('[data-file-id],[data-attachment-id]');
        id = tagged?.getAttribute('data-file-id') ?? tagged?.getAttribute('data-attachment-id');
      }
      expected.push({id: validId(id) ? id : null, name: file.name, mime_type: file.type, size: file.size});
    }
    return expected;
  };
  const controls = target => {
    if (!exact(target) || (target === null && renderedMessage())) return {};
    const {editor, busy, buttons} = surface();
    const form = editor?.closest('form');
    if (!form || busy || editor.disabled || editor.readOnly || editor.getAttribute('aria-disabled') === 'true') return {};
    const candidates = buttons.filter(b => b.form === form && (
      b.getAttribute('type')?.toLowerCase() === 'submit' || b.getAttribute('data-testid') === 'send-button' ||
      /^(Send|Send message|Send prompt|Отправить сообщение)$/i.test(b.getAttribute('aria-label') || '')
    ));
    if (candidates.length > 1) return {};
    const [button] = candidates;
    return {editor, form, button: button && !button.disabled && button.getAttribute('aria-disabled') !== 'true' ? button : null};
  };
  // Keep the ordered user IDs even for messages that have no visible text.
  // A changed branch must not turn a previously sent duplicate into a receipt.
  const userTail = async (target, expected = null) => {
    const data = await conversation(target, 4);
    if (!expected && await activity(target, data) === 'busy') fail('preflight');
    const users = [];
    for (const m of newestFirst(data)) {
      if (m?.author?.role !== 'user') continue;
      if (!validId(m.id) || users.length >= 180) fail('invalid');
      const files = filesOf(m);
      const matches = expected && expected.length === files.length && expected.every(wanted => {
        const i = files.findIndex(f => (wanted.id ? f.id === wanted.id :
          f.name === wanted.name && f.mime_type.toLowerCase() === wanted.mime_type) &&
          (f.size === undefined || f.size === wanted.size));
        if (i < 0) return false;
        files.splice(i, 1);
        return true;
      });
      users.push({id: m.id, matches: matches && messageText(m, false) === text, created: m.create_time});
    }
    return users.reverse();
  };
  const inventory = async () => {
    const {items, total} = await list(0, 100);
    const rows = new Map(items.map(row => [row?.id, row]));
    if (items.length > 100 || rows.size !== items.length || [...rows.keys()].some(key => !validId(key))) fail('invalid');
    return {rows, complete: Number.isSafeInteger(total) ? total === items.length : items.length < 100};
  };
  const unsettled = (target, editor) => {
    const previous = globalThis[witnessKey];
    if (previous?.scope !== request.scope || (previous.target !== target && previous.route !== target)) return false;
    // A picker can already be cleared while its first preview is still
    // uploading. Keep that reservation until submit or explicit file removal.
    return previous.outsideSend || (previous.clicked && !previous.confirmed) ||
      (previous.editor === editor && previous.batch && !previous.batch.changed);
  };
  if (request.op === 'opened') return exact(id);
  if (request.op === 'open' || request.op === 'baseline') {
    const target = request.op === 'open' ? null : id;
    // A background-created target may still be hydrating its composer.
    for (let i = 0; i < 20 && exact(target) && !surface().editor; ++i) await pause(100);
    const {editor, form} = controls(target);
    if (!editor || !empty(editor) || !clean(form) || unsettled(target, editor)) fail('preflight');
    if (request.op === 'open') {
      location.assign('/c/' + encodeURIComponent(id));
      return true;
    }
    const users = id === null ? [] : await userTail(id);
    const before = id === null ? await inventory() : null;
    if (controls(id).editor !== editor || !empty(editor) || !clean(form) || unsettled(id, editor) ||
        (id === null && !globalThis.navigation)) fail('preflight');
    globalThis[witnessKey]?.listeners?.abort();
    globalThis[witnessKey] = {ticket: request.ticket, editor, target: id, scope: request.scope,
      known: before && new Set(before.rows.keys()), complete: before?.complete, route: null};
    return users.map(user => user.id);
  }
  const witness = globalThis[witnessKey];
  const prepared = editor => editor && globalThis[witnessKey] === witness && witness?.editor === editor && witness.target === id &&
    witness.scope === request.scope && witness.ticket === request.ticket && !witness.clicked;
  if (request.op === 'fill') {
    const {editor, form} = controls(id);
    if (!prepared(editor) || witness.started || !empty(editor) || !clean(form)) return false;
    const attachments = request.attachments ?? [];
    const batch = attachments.length ? prepareFiles(form, attachments) : null;
    if (attachments.length && !batch) return false;
    witness.started = true;
    editor.focus();
    if (document.activeElement !== editor || controls(id).editor !== editor || !empty(editor) || !clean(form)) return false;
    const listeners = witness.listeners = new AbortController();
    const options = {capture: true, signal: listeners.signal};
    form.addEventListener('submit', () => { witness.outsideSend = true; }, options);
    form.addEventListener('click', event => {
      const button = event.target.closest?.('button');
      if (button && controls(id).button === button) witness.outsideSend = true;
    }, options);
    // Chromium's editing command dispatches the native input event in the
    // same JS task as the route, empty-draft and focus checks.
    if (text) {
      let accepted = false;
      const input = () => { accepted = true; };
      editor.addEventListener('input', input);
      try { document.execCommand('insertText', false, text); }
      finally { editor.removeEventListener('input', input); }
      if (witness.outsideSend) return 'unknown';
      if (!accepted) return false;
    }
    if (batch) {
      if (controls(id).form !== form || !clean(form) || draft(editor) !== text) return false;
      witness.batch = batch;
      stageFiles(form, batch, listeners);
    }
    for (let i = 0; i < (batch ? 100 : 20); ++i) {
      const ready = controls(id);
      if (witness.outsideSend) return 'unknown';
      if (ready.editor !== editor || !prepared(editor) || draft(editor) !== text || batch?.changed) return false;
      const expected = staged(form, batch);
      if (ready.button && expected) {
        witness.expected = expected;
        return true;
      }
      await pause(batch ? 100 : 50);
    }
    return false;
  }
  // When a blank target gains a native route, it must be the site's own
  // transition in this document. A link, Back, redirect to a second chat
  // or document replacement cannot attest a first-send receipt.
  if (request.op === 'click') {
    if (witness?.ticket === request.ticket && witness?.outsideSend) return 'unknown';
    const {editor, button, form} = controls(id);
    if (!prepared(editor) || !witness.expected || !button || draft(editor) !== text) return false;
    const expected = staged(form, witness.batch);
    if (!expected || expected.some((f, i) => witness.expected[i].id && witness.expected[i].id !== f.id)) return false;
    witness.expected = expected;
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
    witness.listeners.abort();
    delete witness.batch;
    button.click();
    return true;
  }
  if (request.op !== 'receipt') fail('invalid');
  if (!witness?.clicked || witness.target !== id || witness.scope !== request.scope ||
      witness.ticket !== request.ticket || witness.interrupted) fail('preflight');
  if (id === null && !request.observedId && exact(null)) return {id: null, messageId: null};
  const target = id ?? location.pathname.slice(3);
  const bound = () => validId(target) && exact(target) &&
    (!request.observedId || request.observedId === target) &&
    globalThis[witnessKey] === witness &&
    (id !== null || (!witness.interrupted && witness.route === target && !witness.known.has(target)));
  if (!bound()) fail('preflight');
  let users;
  try { users = await userTail(target, witness.expected); }
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
  if (after.length) {
    if (!await sameAccount() || !bound()) fail('preflight');
    witness.confirmed = true;
  }
  return {id: target, messageId: after[0]?.id ?? null};
}
