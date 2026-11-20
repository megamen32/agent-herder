async function cancelChatGptTurn(request, {conversation, newestFirst, activity, exact, surface, visible, validId, sameAccount, fail}) {
  const {id, inputMessageId} = request;
  const result = stopped => ({id, inputMessageId, stopped});
  if (!exact(id)) return result(false);
  const checkAccount = async () => {
    if (!await sameAccount()) fail('account');
    if (!exact(id)) fail('identity');
  };
  const renderedUser = () => {
    const bubble = [...document.querySelectorAll('[data-message-author-role="user"],[data-user-message-bubble]')]
      .filter(visible).at(-1);
    if (!bubble) return null;
    const ids = new Set();
    const own = bubble.closest('[data-message-id]')?.getAttribute('data-message-id');
    if (own != null) ids.add(own);
    const group = bubble.closest('[data-chatgpt-search-message-ids]')?.getAttribute('data-chatgpt-search-message-ids');
    if (group != null) {
      if (validId(group)) ids.add(group);
      else {
        let parsed;
        try { parsed = JSON.parse(group); } catch { return null; }
        if (!Array.isArray(parsed) || parsed.length !== 1) return null;
        ids.add(parsed[0]);
      }
    }
    const [user] = ids;
    return ids.size === 1 && validId(user) ? user : null;
  };
  const nativeTurn = async () => {
    const data = await conversation(id, 4, true);
    let latestAssistant;
    let user;
    for (const m of newestFirst(data)) {
      if (m?.author?.role === 'user') {
        if (!validId(m.id) || m.metadata?.is_visually_hidden_from_conversation) fail('invalid');
        user = m.id;
        break;
      }
      if (!latestAssistant && m?.author?.role === 'assistant') latestAssistant = m;
    }
    const streaming = ['in_progress', 'pending', 'running', 'queued', 'streaming'].includes(latestAssistant?.status);
    const state = await activity(id, data, false);
    const completed = latestAssistant?.end_turn === true ||
      ['finished_successfully', 'finished_partial_completion', 'cancelled'].includes(latestAssistant?.status);
    const idle = !streaming && (state === 'idle' || (state === 'unknown' && completed && !!surface().editor));
    return {user, state, idle};
  };
  const key = Symbol.for('agent-herder.chatgpt.pending-stop');
  const initial = surface();
  const initialUser = renderedUser();
  const turn = await nativeTurn();
  await checkAccount();
  const {editor, stops} = surface();
  const pending = globalThis[key];
  if (!stops.length && turn.idle) {
    if (pending?.uncertain && pending.scope === request.scope && pending.id === id) delete globalThis[key];
    return result(false);
  }
  const user = renderedUser();
  if (!user || user !== turn.user || user !== initialUser) fail('unconfirmed');
  if (user !== inputMessageId) return result(false);
  const [button] = stops;
  const form = editor?.closest('form');
  if (turn.state !== 'busy' || stops.length !== 1 || initial.stops.length !== 1 ||
      button !== initial.stops[0] || !form || button.form !== form ||
      button.disabled || button.getAttribute('aria-disabled') === 'true') fail('unconfirmed');
  if (pending?.scope === request.scope && pending.id === id && pending.inputMessageId === inputMessageId) {
    fail('unconfirmed');
  }
  const receipt = {scope: request.scope, id, inputMessageId};
  globalThis[key] = receipt;
  // Once clicked, only observe. A stale control, lost route or a newer input
  // cannot confirm this stop, even if the new conversation looks idle.
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    button.click();
    for (let i = 0; i < 20; ++i) {
      if (!exact(id) || renderedUser() !== inputMessageId) fail('unconfirmed');
      if (!surface().busy && i % 4 === 0) {
        const after = await nativeTurn();
        await checkAccount();
        if (renderedUser() !== inputMessageId || after.user !== inputMessageId || globalThis[key] !== receipt) {
          fail('unconfirmed');
        }
        if (!surface().busy && after.idle) {
          delete globalThis[key];
          return result(true);
        }
      }
      await pause(150);
    }
    fail('unconfirmed');
  } catch (error) {
    receipt.uncertain = true;
    throw error;
  }
}
