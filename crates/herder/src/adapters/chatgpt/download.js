async function downloadChatGptFile(request, {conversation, fullConversation, newestFirst, publicMessage, filesOf, get, sameAccount, validName, validMime, validId, fail}) {
  const {id, messageId, attachmentId, maxBytes} = request;
  if (![id, messageId, attachmentId].every(validId)) fail('invalid');
  // The inventory target can be parked on a different chat. Bind the read to
  // the addressed provider response and its selected branch, without navigating.
  const page = location.href;
  const checkAccount = async () => {
    if (!await sameAccount()) fail('account');
    if (location.href !== page) fail('identity');
  };
  const findMessage = branch => {
    let found;
    for (const m of branch) {
      if (m?.id !== messageId) continue;
      if (found) fail('mapping');
      found = m;
    }
    return found;
  };
  let message;
  try { message = findMessage(newestFirst(await conversation(id, 60))); }
  catch (error) { if (![404, 405].includes(error.status)) throw error; }
  if (!message) {
    await checkAccount();
    const {current_node, mapping} = await fullConversation(id);
    // A once-listed message can age out. Only ancestry from the selected
    // tip authorizes its file, even when the mapping also contains siblings.
    message = findMessage(newestFirst({current_node, mapping}, Infinity));
  }
  if (!publicMessage(message)) fail('missing');
  const file = filesOf(message).find(f => f.id === attachmentId);
  if (!file) fail('missing');
  if (file.size > maxBytes) fail('too_large');
  await checkAccount();
  const base = '/backend-api/files/' + encodeURIComponent(file.id);
  const descriptor = await get(base + '/download?conversation_id=' + encodeURIComponent(id));
  if (typeof descriptor?.download_url !== 'string') fail('invalid');
  const url = new URL(descriptor.download_url, location.origin);
  const sameOrigin = url.origin === location.origin;
  const estuary = url.pathname === '/backend-api/estuary/content' &&
    url.searchParams.getAll('id').length === 1 && url.searchParams.get('id') === file.id;
  // The scoped descriptor signs an object on the content CDN. Regional
  // hosts use opaque object paths that need not repeat the provider file ID.
  const cdn = url.protocol === 'https:' && !url.port && url.hostname.endsWith('.oaiusercontent.com') &&
    url.pathname !== '/';
  const original = sameOrigin ? (estuary || (url.pathname === base + '/content' && !url.search)) : cdn;
  if (!original || url.username || url.password || url.hash) fail('invalid');
  await checkAccount();
  const response = await fetch(url.href, {credentials: sameOrigin ? 'same-origin' : 'omit',
    redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer'});
  if (response.status !== 200 || response.redirected || response.headers.has('content-range') || !response.body) {
    fail('invalid');
  }
  const reader = response.body.getReader();
  const bytes = new Uint8Array(maxBytes);
  let length = 0;
  try {
    if (Number(response.headers.get('content-length')) > maxBytes) fail('too_large');
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      if (value.byteLength > maxBytes - length) fail('too_large');
      bytes.set(value, length);
      length += value.byteLength;
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  if (file.size !== undefined && file.size !== length) fail('invalid');
  const result = new FileReader();
  const encoded = await new Promise((resolve, reject) => {
    result.onload = () => resolve(result.result.split(',')[1]);
    result.onerror = () => reject(result.error);
    result.readAsDataURL(new Blob([bytes.subarray(0, length)]));
  });
  await checkAccount();
  const mime = response.headers.get('content-type')?.split(';')[0].trim();
  const mime_type = [file.declaredMime, descriptor.mime_type, descriptor.mimeType, mime].find(validMime) ?? 'application/octet-stream';
  const name = file.declaredName ?? (validName(descriptor.file_name) ? descriptor.file_name : file.id);
  return {id, messageId, attachmentId, attachment: {name, mime_type, data_base64: encoded}};
}
