async function readChatGpt(request, {list, activity, conversation, newestFirst, messageText, validId, publicMessage, readFailedBoundary, filesOf, sameAccount, fail}) {
  if (request.op === 'list') {
    const ids = new Set();
    const size = Math.min(100, request.limit);
    for (let page = 0; ids.size < request.limit && page < 10; ++page) {
      const offset = page * size;
      const {items, total} = await list(offset, size);
      for (const row of items) {
        if (validId(row?.id) && !row.is_archived && !row.is_temporary_chat) ids.add(row.id);
        if (ids.size === request.limit) break;
      }
      if (items.length < size || (Number.isInteger(total) && offset + size >= total)) break;
    }
    return [...ids];
  }
  const id = request.id;
  if (request.op === 'activity') {
    return {id, activity: await activity(id)};
  }
  if (request.op === 'recovery') {
    const result = await readFailedBoundary(id);
    if (!result) return null;
    if (!await sameAccount()) fail('account');
    return result;
  }
  if (request.op !== 'read') fail('invalid');
  const data = await conversation(id, 60, true);
  const messages = [];
  const bytes = new TextEncoder();
  const budget = 512 * 1024;
  const latestRoles = new Set();
  let used = 2;
  // Reserve the latest visible user and assistant messages, even if a large
  // older entry would otherwise consume the budget before reaching them.
  const older = [];
  let count = 0;
  for (const m of newestFirst(data)) {
    const role = m?.author?.role;
    if (!publicMessage(m)) continue;
    const raw = messageText(m);
    const text = typeof raw === 'string' ? raw.trim() : '';
    const attachments = filesOf(m).map(({id, name, mime_type, image}) => ({id, name, mime_type, ...(image && {image})}));
    if (!text && !attachments.length) continue;
    const message = {id: m.id, role, text, attachments, create_time: Number.isFinite(m.create_time) ? m.create_time : null,
      model: typeof m.metadata?.model_slug === 'string' ? m.metadata.model_slug : null};
    if (typeof m.channel === 'string') message.phase = m.channel;
    if (typeof m.status === 'string') message.completionStatus = m.status;
    if (typeof m.end_turn === 'boolean') message.endTurn = m.end_turn;
    const size = message.text.length > budget ? budget + 1 : bytes.encode(JSON.stringify(message)).length + 1;
    const item = {message, size, order: count++};
    if (!latestRoles.has(role)) {
      latestRoles.add(role);
      used += size;
      if (used > budget) fail('context_too_large');
      messages.push(item);
    } else {
      older.push(item);
    }
    if (count === 180) break;
  }
  for (const item of older) {
    if (used + item.size > budget) break;
    used += item.size;
    messages.push(item);
  }
  messages.sort((a, b) => b.order - a.order);
  if (!await sameAccount()) fail('account');
  return {id, messages: messages.map(item => item.message)};
}
