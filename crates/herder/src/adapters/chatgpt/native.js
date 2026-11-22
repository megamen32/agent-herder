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
  const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
    encoder.encode(value))), b => b.toString(16).padStart(2, '0')).join('');
  const nativeScope = await hash(account);
  const user = session.user?.id;
  const userioBound = nativeScope !== request.scope;
  if (userioBound && (typeof user !== 'string' || !user ||
      await hash(JSON.stringify({provider: 'chatgpt', user_id: user, account_id: account})) !== request.scope)) {
    return {origin, error: 'account'};
  }
  const scope = request.scope;
  if (location.origin !== origin) return {origin: location.origin, error: 'origin'};

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
  const identified = (id, data) => {
    if (data?.conversation_id !== id) fail('identity');
    return data;
  };
  const fullConversation = async id => {
    if (!validId(id)) fail('invalid');
    return identified(id, await get('/backend-api/conversation/' + encodeURIComponent(id)));
  };
  const conversation = async (id, turns, legacy = false) => {
    if (!validId(id)) fail('invalid');
    try {
      return identified(id, await get('/backend-api/conversations/' + encodeURIComponent(id) +
        '?num_turns=' + turns + '&include_has_versions=true'));
    } catch (error) {
      if (!legacy || !(error instanceof ReadFailure) || ![404, 405].includes(error.status)) throw error;
      return fullConversation(id);
    }
  };
  const list = async (offset, limit) => {
    const data = await get('/backend-api/conversations?offset=' + offset + '&limit=' + limit + '&order=updated');
    if (!Array.isArray(data?.items)) fail('invalid');
    return data;
  };
  // The plural endpoint supplies the current branch in display order. The
  // legacy mapping can contain siblings and private tool/analysis branches.
  function* newestFirst(data, limit = 1024) {
    if (Array.isArray(data.messages)) {
      const floor = Math.max(0, data.messages.length - limit);
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
    while (cursor && seen.size < limit) {
      if (typeof cursor !== 'string' || !Object.hasOwn(mapping, cursor) || seen.has(cursor)) fail('mapping');
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
  const assetPart = part => ['image_asset_pointer', 'image'].includes(part?.content_type);
  const messageText = (message, includeImageLabels = true) => Array.isArray(message.content?.parts)
    ? message.content.parts.filter(part => includeImageLabels || !assetPart(part)).map(partText).join('\n')
    : (message.content?.text ?? '');
  const publicMessage = m => validId(m?.id) && !m.metadata?.is_visually_hidden_from_conversation &&
    (m.author?.role === 'user' || (m.author?.role === 'assistant' &&
      (!m.channel || ['final', 'commentary'].includes(m.channel)) && (!m.recipient || m.recipient === 'all')));
  const failedBoundary = (id, data) => {
    const branch = [...newestFirst(data)].filter(publicMessage);
    const failed = branch[0];
    if (failed?.author?.role !== 'assistant' || failed.status !== 'failed') return null;
    const parent = data.mapping?.[failed.id]?.parent ?? failed.parent_id;
    const input = branch.find(m => m.author?.role === 'user');
    if (!input || input.id !== parent) return null;
    const startedAtMs = Math.trunc(failed.create_time * 1000);
    if (!Number.isFinite(failed.create_time) || !Number.isSafeInteger(startedAtMs) || startedAtMs <= 0) return null;
    return {id, turnId: failed.id, inputItemId: input.id, status: failed.status, startedAtMs};
  };
  const readFailedBoundary = async id => {
    const recent = await conversation(id, 60, true);
    const boundary = failedBoundary(id, recent);
    if (boundary || !Array.isArray(recent.messages)) return boundary;
    const head = [...newestFirst(recent)].find(publicMessage);
    if (head?.author?.role !== 'assistant' || head.status !== 'failed' || head.parent_id != null) return null;
    // Some lightweight responses omit parents. The detailed branch must
    // confirm this same head, so any newer input or branch switch still wins.
    const detailed = failedBoundary(id, await fullConversation(id));
    return detailed?.turnId === head.id ? detailed : null;
  };
  const validName = name => typeof name === 'string' && !!name.trim() && !['.', '..'].includes(name) &&
    encoder.encode(name).length <= 255 && !/[\\/\p{Cc}]/u.test(name);
  const validMime = mime => typeof mime === 'string' && mime.length <= 255 &&
    /^[a-zA-Z0-9!#$%&'+.^_`|~-]+\/[a-zA-Z0-9!#$%&'+.^_`|~-]+$/.test(mime);
  const filesOf = m => {
    const files = new Map();
    const add = (id, raw, image = false) => {
      if (!validId(id)) return;
      const previous = files.get(id);
      if (previous) {
        previous.image ||= image;
        return;
      }
      const declaredName = raw.name ?? raw.filename ?? raw.metadata?.name ?? raw.metadata?.filename;
      const name = declaredName ?? id;
      const declaredMime = raw.mimeType ?? raw.mime_type ?? raw.metadata?.mimeType ?? raw.metadata?.mime_type;
      const mime = declaredMime ?? 'application/octet-stream';
      if (!validName(name) || !validMime(mime)) return;
      files.set(id, {id, name, mime_type: mime, image, declaredName, declaredMime,
        size: Number.isSafeInteger(raw.size ?? raw.size_bytes) ? (raw.size ?? raw.size_bytes) : undefined});
    };
    if (Array.isArray(m.metadata?.attachments)) {
      for (const file of m.metadata.attachments) add(file?.id ?? file?.file_id, file);
    }
    if (Array.isArray(m.content?.parts)) {
      for (const part of m.content.parts) {
        if (!assetPart(part) || typeof part.asset_pointer !== 'string') continue;
        const match = /^(?:file-service|sediment):\/\/([a-zA-Z0-9_-]{1,128})$/.exec(part.asset_pointer);
        if (match) add(match[1], part, true);
      }
    }
    return [...files.values()];
  };
  const visible = element => !!element?.getClientRects().length && getComputedStyle(element).visibility === 'visible';
  const composerSelector = '[contenteditable="true"][role="textbox"][data-composer-markdown],#prompt-textarea[contenteditable="true"],textarea#prompt-textarea';
  const surface = () => {
    const editors = Array.from(document.querySelectorAll(composerSelector)).filter(visible);
    const editor = editors.length === 1 ? editors[0] : null;
    const buttons = Array.from(document.querySelectorAll('button')).filter(visible);
    const stops = buttons.filter(b => b.getAttribute('data-testid') === 'stop-button' ||
      /^(Stop generating|Stop response|Остановить генерацию|Остановить ответ|Остановить)$/i.test(b.getAttribute('aria-label') || ''));
    return {editor, busy: stops.length > 0, buttons, stops};
  };
  const nativeActivity = entry => {
    const status = entry?.async_status;
    if (entry?.is_generating === true || ['running', 'pending', 'in_progress'].includes(status) ||
        (Number.isFinite(status) && status !== 0)) return 'busy';
    if (entry?.is_generating === false || status === 0 || ['idle', 'completed'].includes(status)) return 'idle';
    return 'unknown';
  };
  const activity = async (id, detail, inferIdleFromEditor = true) => {
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
      if (busy || (editor && inferIdleFromEditor)) return busy ? 'busy' : 'idle';
    }
    return state === 'idle' ? state : listed;
  };
  try {
    const sameAccount = async () => {
      const observed = await loadSession();
      return observed?.account?.id === account && (!userioBound || observed.user?.id === user);
    };
    const value = await operation(request, {get, list, activity, conversation, fullConversation, newestFirst, messageText, sameAccount,
      validId, validName, validMime, publicMessage, readFailedBoundary, filesOf, fail, exact, surface, visible});
    return {origin, scope, value};
  } catch (error) {
    if (!(error instanceof ReadFailure)) throw error;
    return {origin, scope, error: error.message, status: error.status};
  }
}
