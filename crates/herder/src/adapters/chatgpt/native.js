// This function and its operation run inside the selected page. Only the
// projection returned by the operation crosses the CDP boundary.
async function chatGptNative(operation, request) {
  const origin = location.origin;
  if (origin !== 'https://chatgpt.com') return {origin, error: 'origin'};
  const options = {credentials: 'same-origin', cache: 'no-store', redirect: 'error'};
  const loadSession = async () => {
    const response = await fetch('/api/auth/session', options);
    return response.ok ? response.json() : null;
  };
  const session = await loadSession().catch(() => null);
  const account = session?.account?.id;
  if (typeof account !== 'string' || !account || !session.accessToken) {
    return {origin, error: 'account'};
  }
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(account));
  const scope = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  if (location.origin !== origin) return {origin: location.origin, error: 'origin'};
  if (scope !== request.scope) return {origin, scope, error: 'account'};

  class ReadFailure extends Error {
    constructor(reason, status) { super(reason); this.status = status; }
  }
  const fail = reason => { throw new ReadFailure(reason); };
  const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
  const exact = id => location.origin === origin && !location.search && !location.hash &&
    location.pathname === (id === null ? '/' : '/c/' + id);
  const get = async path => {
    if (location.origin !== origin) fail('origin');
    const response = await fetch(path, {...options, headers: {
      authorization: 'Bearer ' + session.accessToken, 'chatgpt-account-id': account,
    }});
    if (!response.ok) throw new ReadFailure('provider', response.status);
    const data = await response.json();
    if (location.origin !== origin) fail('origin');
    return data;
  };
  const conversation = async (id, turns, legacy = false) => {
    if (!validId(id)) fail('invalid');
    const encoded = encodeURIComponent(id);
    let data;
    try {
      data = await get('/backend-api/conversations/' + encoded +
        '?num_turns=' + turns + '&include_has_versions=true');
    } catch (error) {
      if (!legacy || !(error instanceof ReadFailure) || ![404, 405].includes(error.status)) throw error;
      data = await get('/backend-api/conversation/' + encoded);
    }
    if (data?.conversation_id !== id) fail('identity');
    return data;
  };
  const list = async (offset, limit) => {
    const data = await get('/backend-api/conversations?offset=' + offset + '&limit=' + limit + '&order=updated');
    if (!Array.isArray(data?.items)) fail('invalid');
    return data;
  };
  // The plural endpoint supplies the current branch in display order. The
  // legacy mapping can contain siblings and private tool/analysis branches.
  function* newestFirst(data) {
    if (Array.isArray(data.messages)) {
      const floor = Math.max(0, data.messages.length - 1024);
      for (let i = data.messages.length - 1; i >= floor; --i) yield data.messages[i];
      return;
    }
    const mapping = data.mapping;
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) fail('mapping');
    let cursor = data.current_node;
    if (!cursor) {
      const nodes = Object.keys(mapping);
      if (!nodes.length) return;
      const parents = new Set(nodes.map(key => mapping[key]?.parent));
      const tips = nodes.filter(key => !parents.has(key));
      if (tips.length !== 1) fail('mapping');
      cursor = tips[0];
    }
    const seen = new Set();
    while (cursor && seen.size < 1024) {
      if (!Object.hasOwn(mapping, cursor) || seen.has(cursor)) fail('mapping');
      seen.add(cursor);
      const node = mapping[cursor];
      yield node.message;
      cursor = node.parent;
    }
  }
  const partText = part => {
    if (typeof part === 'string') return part;
    if (typeof part?.text === 'string') return part.text;
    if (typeof part?.content === 'string') return part.content;
    return ['image', 'image_asset_pointer'].includes(part?.content_type) ? '[Изображение]' : '';
  };
  const messageText = message => Array.isArray(message.content?.parts)
    ? message.content.parts.map(partText).join('\n') : (message.content?.text ?? '');
  const visible = element => !!element?.getClientRects().length && getComputedStyle(element).visibility === 'visible';
  const composerSelector = '[contenteditable="true"][role="textbox"][data-composer-markdown],#prompt-textarea[contenteditable="true"],textarea#prompt-textarea';
  const surface = () => {
    const editors = Array.from(document.querySelectorAll(composerSelector)).filter(visible);
    const editor = editors.length === 1 ? editors[0] : null;
    const buttons = Array.from(document.querySelectorAll('button')).filter(visible);
    const busy = buttons.some(b => b.getAttribute('data-testid') === 'stop-button' ||
      /^(Stop generating|Stop response|Остановить генерацию|Остановить ответ|Остановить)$/i.test(b.getAttribute('aria-label') || ''));
    return {editor, busy, buttons};
  };
  const nativeActivity = entry => {
    const status = entry?.async_status;
    if (entry?.is_generating === true || ['running', 'pending', 'in_progress'].includes(status) ||
        (Number.isFinite(status) && status !== 0)) return 'busy';
    if (entry?.is_generating === false || status === 0 || ['idle', 'completed'].includes(status)) return 'idle';
    return 'unknown';
  };
  const activity = async (id, detail) => {
    if (nativeActivity(detail) === 'busy') return 'busy';
    const rows = (await list(0, 100)).items.filter(row => row?.id === id);
    if (rows.length > 1) fail('invalid');
    const listed = nativeActivity(rows[0]);
    if (listed === 'busy') return 'busy';
    if (!detail && (!rows.length || exact(id))) detail = await conversation(id, 1);
    const state = nativeActivity(detail);
    if (state === 'busy') return 'busy';
    if (exact(id) && document.readyState !== 'loading') {
      const {busy, editor} = surface();
      if (busy || editor) return busy ? 'busy' : 'idle';
    }
    return state === 'idle' ? state : listed;
  };
  try {
    const sameAccount = async () => (await loadSession())?.account?.id === account;
    const value = await operation(request, {list, activity, conversation, newestFirst, messageText, sameAccount,
      validId, fail, exact, surface});
    return {origin, scope, value};
  } catch (error) {
    if (!(error instanceof ReadFailure)) throw error;
    return {origin, scope, error: error.message, status: error.status};
  }
}
