// node --test native.test.mjs (PLAYWRIGHT_MODULE may name playwright-core/index.mjs).
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {after, before, test} from 'node:test';

const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const [native, composer, read, cancel, download] = await Promise.all(
  ['native.js', 'composer.js', 'read.js', 'cancel.js', 'download.js'].map(file => readFile(new URL(file, import.meta.url), 'utf8'))
);
const origin = 'https://chatgpt.com';
const scope = createHash('sha256').update('fixture').digest('hex');
const text = 'same prompt';
let browser;
before(async () => {
  browser = await chromium.launch({channel: 'chrome', args: [
    '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>',
    '--host-resolver-rules=MAP * ~NOTFOUND', '--disable-quic',
  ]});
});
after(() => browser?.close());

async function fixture(t, id = null) {
  const context = await browser.newContext({serviceWorkers: 'block'});
  t.after(() => context.close());
  const page = await context.newPage();
  const url = origin + (id ? '/c/' + id : '/');
  await context.route('**/*', route => route.request().url() === url
    ? route.fulfill({contentType: 'text/html', body: '<form><textarea id="prompt-textarea"></textarea>' +
        '<input type="file" hidden><button type="submit" data-testid="send-button">Send</button></form>'})
    : route.abort('blockedbyclient'));
  await page.goto(url);
  await page.evaluate(() => {
    window.account = 'fixture';
    window.chats = {old: {conversation_id: 'old', messages: [
      {id: 'old-user', author: {role: 'user'}, content: {parts: ['same prompt']}, create_time: 1},
    ]}};
    window.inventory = [{id: 'old', create_time: 1, update_time: 1}];
    window.fetch = async path => {
      const url = new URL(path, location.origin);
      if (url.pathname === '/api/auth/session') return Response.json({account: {id: account}, accessToken: 'fixture'});
      if (url.pathname === '/backend-api/conversations') return Response.json({items: inventory, total: inventory.length});
      const row = chats[url.pathname.split('/').pop()];
      if (!row) throw Error('unexpected fixture read');
      return Response.json(row);
    };
    window.inputs = window.clicks = 0;
    document.addEventListener('input', e => { if (e.target.matches('textarea')) inputs++; });
    document.querySelector('form').onsubmit = e => { e.preventDefault(); clicks++; };
  });
  const operations = {activity: read, read, recovery: read, cancel, download};
  const call = (op, args = {}) => page.evaluate(
    '(' + native + ')(' + (operations[op] || composer) + ',' +
    JSON.stringify({op, id, text, scope, maxBytes: 2 * 1024 * 1024, ...args}) + ')'
  );
  return {page, call};
}

test('pending attachments preserve an empty draft and block navigation, input and click', async t => {
  const {page, call} = await fixture(t);
  const file = page.locator('input[type=file]');
  await file.setInputFiles({name: 'draft.txt', mimeType: 'text/plain', buffer: Buffer.from('draft')});
  assert.equal((await call('open', {id: 'old'})).error, 'preflight');
  assert.equal((await call('baseline')).error, 'preflight');
  assert.equal((await call('fill')).value, false);
  assert.equal(page.url(), origin + '/');
  assert.deepEqual(await page.evaluate(() => [
    inputs, clicks, document.querySelector('textarea').value, document.querySelector('input').files[0].name, account,
  ]), [0, 0, '', 'draft.txt', 'fixture']);

  await file.setInputFiles([]);
  assert.deepEqual((await call('baseline')).value, []);
  assert.equal((await call('fill')).value, true);
  // Uploaded previews can survive after the file picker has been reset.
  await page.locator('form').evaluate(form => form.insertAdjacentHTML('beforeend',
    '<button type="button" aria-label="Remove file">draft.txt</button>'));
  assert.equal((await call('click')).value, false);
  assert.deepEqual(await page.evaluate(() => [clicks, document.querySelector('textarea').value]), [0, text]);
});

test('ambiguous send controls and a changed account preserve the draft', async t => {
  const {page, call} = await fixture(t, 'old');
  const duplicate = () => page.locator('form').evaluate(form => form.append(form.querySelector('button').cloneNode(true)));
  await duplicate();
  assert.equal((await call('baseline')).error, 'preflight');
  assert.equal((await call('fill')).value, false);
  assert.equal(await page.evaluate(() => inputs), 0);
  await page.locator('button').last().evaluate(button => button.remove());
  assert.deepEqual((await call('baseline')).value, ['old-user']);
  assert.equal((await call('fill')).value, true);
  await duplicate();
  assert.equal((await call('click')).value, false);
  await page.locator('button').last().evaluate(button => button.remove());
  await page.evaluate(() => { account = 'other'; });
  assert.equal((await call('click')).error, 'account');
  assert.deepEqual(await page.evaluate(() => [clicks, document.querySelector('textarea').value]), [0, text]);
});

test('first receipt rejects a scripted same-document navigation to an old exact duplicate', async t => {
  const {page, call} = await fixture(t);
  const before = (await call('baseline')).value;
  assert.equal((await call('fill')).value, true);
  await page.evaluate(() => { document.querySelector('form').addEventListener('submit',
    () => history.replaceState({}, '', '/c/old')); });
  assert.equal((await call('click')).value, true);
  const receipt = await call('receipt', {before});
  assert.equal(receipt.error, 'preflight');
  assert.equal(await page.evaluate(() => clicks), 1);
});

test('a newly published conversation confirms its own native user ID', async t => {
  const {page, call} = await fixture(t);
  const before = (await call('baseline')).value;
  assert.equal((await call('fill')).value, true);
  await page.evaluate(() => {
    document.querySelector('form').addEventListener('submit', () => {
      chats.fresh = {conversation_id: 'fresh', messages: [
        {id: 'new-user', author: {role: 'user'}, content: {parts: ['same prompt']}, create_time: 2},
      ]};
      inventory.push({id: 'fresh', create_time: 2, update_time: 2});
      history.replaceState({}, '', '/c/fresh');
    });
  });
  assert.equal((await call('click')).value, true);
  assert.deepEqual((await call('receipt', {before})).value, {id: 'fresh', messageId: 'new-user'});
  assert.equal(await page.evaluate(() => clicks), 1);
});

test('native async status is scoped to the requested chat and a busy signal survives an idle-looking editor', async t => {
  const {page, call} = await fixture(t, 'old');
  for (const [status, expected] of [[-1, 'busy'], [3, 'busy'], ['running', 'busy'], [0, 'idle']]) {
    await page.evaluate(status => { inventory[0].async_status = chats.old.async_status = status; }, status);
    assert.equal((await call('activity')).value.activity, expected);
    if (expected === 'busy') assert.equal((await call('baseline')).error, 'preflight');
  }
  await page.evaluate(() => { history.replaceState({}, '', '/c/other'); });
  for (const [status, expected] of [[-1, 'busy'], [0, 'idle'], ['unrecognized', 'unknown']]) {
    await page.evaluate(status => { inventory[0].async_status = chats.old.async_status = status; }, status);
    assert.equal((await call('activity')).value.activity, expected);
  }
});

test('read preserves observed message metadata including end_turn false', async t => {
  const {page, call} = await fixture(t, 'old');
  await page.evaluate(() => {
    chats.old.messages.push({id: 'a1', author: {role: 'assistant'}, channel: 'commentary',
      status: 'in_progress', end_turn: false, content: {parts: ['Working']}});
  });
  const [user, assistant] = (await call('read')).value.messages;
  assert.deepEqual([assistant.phase, assistant.completionStatus, assistant.endTurn], ['commentary', 'in_progress', false]);
  assert.ok(!Object.hasOwn(user, 'phase') && !Object.hasOwn(user, 'completionStatus') && !Object.hasOwn(user, 'endTurn'));
});

test('recovery requires explicit failure at the current branch head and its exact user parent', async t => {
  const {page, call} = await fixture(t, 'old');
  await page.evaluate(() => {
    chats.old.messages.push({id: 'failed', parent_id: 'old-user', author: {role: 'assistant'},
      status: 'failed', end_turn: false, create_time: 1, content: {parts: ['provider failure']}});
  });
  assert.deepEqual((await call('recovery')).value, {
    id: 'old', turnId: 'failed', inputItemId: 'old-user', status: 'failed', startedAtMs: 1000,
  });
  await page.evaluate(() => {
    chats.old.messages.push({id: 'new-user', author: {role: 'user'}, content: {parts: ['new input']}});
  });
  assert.equal((await call('recovery')).value, null);
  await page.evaluate(() => {
    chats.old.messages.push({id: 'complete', parent_id: 'new-user', author: {role: 'assistant'},
      status: 'finished_successfully', end_turn: true, content: {parts: ['done']}});
  });
  assert.equal((await call('recovery')).value, null);
});

test('recovery rechecks the failed input immediately before clicking', async t => {
  for (const stale of [false, true]) {
    const {page, call} = await fixture(t, 'old');
    await page.evaluate(() => {
      chats.old.messages.push({id: 'failed', parent_id: 'old-user', author: {role: 'assistant'},
        status: 'failed', create_time: 2, content: {parts: ['provider failure']}});
    });
    const recovery = {turnId: 'failed', inputItemId: 'old-user'};
    assert.deepEqual((await call('baseline', {recovery})).value, ['old-user']);
    assert.equal((await call('fill', {recovery})).value, true);
    if (stale) await page.evaluate(() => {
      chats.old.messages.push({id: 'later', author: {role: 'user'}, content: {parts: ['new input']}});
    });
    assert.equal((await call('click', {recovery})).value, !stale);
    assert.equal(await page.evaluate(() => clicks), stale ? 0 : 1);
    if (stale) assert.equal(await page.locator('textarea').inputValue(), '');
  }
});

test('attachment-only submit waits for the composer upload and proves the new native user ID and files', async t => {
  const {page, call} = await fixture(t, 'old');
  await page.evaluate(() => {
    const form = document.querySelector('form');
    const picker = form.querySelector('input');
    const send = form.querySelector('button');
    picker.multiple = true;
    picker.onchange = async () => {
      send.disabled = true;
      const files = [...picker.files];
      picker.value = '';
      window.uploads = [];
      for (const [i, file] of files.entries()) {
        const id = 'file-' + i;
        uploads.push({id, name: file.name, mimeType: file.type, size: file.size,
          bytes: [...new Uint8Array(await file.arrayBuffer())]});
        const chip = document.createElement('span');
        chip.dataset.fileId = id;
        chip.textContent = file.name;
        form.append(chip);
      }
      send.disabled = false;
    };
    form.addEventListener('submit', () => {
      chats.old.messages.push({id: 'new-user', author: {role: 'user'}, metadata: {attachments: uploads},
        content: {parts: [{content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-0'}, '']}});
    });
  });
  const args = {text: '', ticket: 'upload-1'};
  const before = (await call('baseline', args)).value;
  const attachments = [{name: 'photo.webp', mime_type: 'image/webp', data_base64: 'AP8B'},
    {name: 'данные.bin', mime_type: 'application/octet-stream', data_base64: 'MAo='}];
  assert.equal((await call('fill', {...args, attachments})).value, true);
  assert.equal((await call('click', {...args, ticket: 'different-reader'})).value, false);
  assert.equal((await call('click', args)).value, true);
  assert.deepEqual((await call('receipt', {...args, before})).value, {id: 'old', messageId: 'new-user'});
  const attached = (await call('read')).value.messages.at(-1).attachments;
  assert.deepEqual(attached, [{id: 'file-0', name: 'photo.webp', mime_type: 'image/webp', image: true},
    {id: 'file-1', name: 'данные.bin', mime_type: 'application/octet-stream'}]);
  assert.equal((await call('click', args)).value, false);
  assert.deepEqual(await page.evaluate(() => [inputs, clicks, uploads.map(f => f.bytes)]), [0, 1, [[0, 255, 1], [48, 10]]]);
  await page.evaluate(() => { chats.old.messages.at(-1).metadata.attachments.pop(); });
  assert.equal((await call('receipt', {...args, before})).error, 'preflight');
});

test('a second file selection with the same name invalidates an otherwise ready send', async t => {
  const {page, call} = await fixture(t, 'old');
  await call('baseline');
  assert.equal((await call('fill', {attachments: [{name: 'x.bin', mime_type: 'application/octet-stream', data_base64: 'AQ=='}]})).value, true);
  await page.locator('input').setInputFiles({name: 'x.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([2])});
  assert.equal((await call('click')).value, false);
  assert.equal((await call('baseline')).error, 'preflight');
  assert.equal(await page.evaluate(() => clicks), 0);
});

test('a cleared picker still uploading reserves the composer, and a manual submit cannot be repeated', async t => {
  const {page, call} = await fixture(t, 'old');
  await page.locator('input').evaluate(input => {
    input.onchange = () => { input.value = ''; document.querySelector('button').disabled = true; window.uploading = true; };
  });
  const args = {ticket: 'first', text: ''};
  await call('baseline', args);
  const filling = call('fill', {...args, attachments: [{name: 'x.txt', mime_type: 'text/plain', data_base64: 'eA=='}]});
  await page.waitForFunction(() => window.uploading);
  assert.equal((await call('baseline', {ticket: 'second'})).error, 'preflight');
  await page.locator('form').evaluate(form => {
    form.insertAdjacentHTML('beforeend', '<span data-file-id="file-x">x.txt</span>');
    form.querySelector('button').disabled = false;
  });
  assert.equal((await filling).value, true);
  await page.locator('form').evaluate(form => form.requestSubmit());
  assert.equal((await call('click', args)).value, 'unknown');
  assert.equal(await page.evaluate(() => clicks), 1);
});

async function originalFixture(t) {
  const ctx = await fixture(t, 'old');
  await ctx.page.evaluate(() => {
    const pointer = (id, metadata = {}) => ({content_type: 'image_asset_pointer',
      asset_pointer: 'sediment://' + id, metadata});
    chats.other = {conversation_id: 'other', messages: [
      {id: 'u', author: {role: 'user'}, content: {parts: [pointer('file_user')]}},
      {id: 'a', author: {role: 'assistant'}, channel: 'final',
        content: {parts: [pointer('file_assistant', {filename: 'image.webp', mime_type: 'image/webp'})]}},
      {id: 'bin', author: {role: 'user'}, metadata: {attachments: [{id: 'file_bin', name: 'data.bin', mimeType: 'application/octet-stream'}]}},
      {id: 'links', author: {role: 'assistant'}, content: {parts: ['[report](sandbox:/mnt/data/report.pdf) https://evil.invalid/image.jpg']}},
      {id: 'private', author: {role: 'assistant'}, channel: 'analysis', content: {parts: [pointer('file_hidden')]}},
    ]};
    window.signedUrl = 'https://region-1.media.oaiusercontent.com/opaque/7d09/photo?sig=fixture';
    window.requests = [];
    window.lengths = [3, 2];
    const provider = window.fetch;
    window.fetch = async (path, options = {}) => {
      const url = new URL(path, location.origin);
      if (url.pathname.endsWith('/download')) {
        requests.push({descriptor: url.pathname, chat: url.searchParams.get('conversation_id'),
          authenticated: Boolean(options.headers.authorization && options.headers['chatgpt-account-id'])});
        return Response.json({download_url: signedUrl});
      }
      if (url.href === signedUrl && options.referrerPolicy === 'no-referrer') {
        requests.push({original: url.href, credentials: options.credentials, redirect: options.redirect,
          referrer: options.referrerPolicy, headers: options.headers || {}});
        let i = 0;
        return new Response(new ReadableStream({pull(controller) {
          if (i === lengths.length) {
            if (window.switchAccount) account = 'switched';
            controller.close();
          } else controller.enqueue(new Uint8Array(lengths[i++]).fill(i));
        }}), {headers: {'content-type': 'image/jpeg'}});
      }
      return provider(path, options);
    };
  });
  const file = (messageId, attachmentId, args = {}) => ctx.call('download', {id: 'other', messageId, attachmentId, ...args});
  return {...ctx, file};
}

test('user and assistant pointer-only images resolve scoped CDN originals with honest MIME and filename', async t => {
  const {page, call, file} = await originalFixture(t);
  const {messages} = (await call('read', {id: 'other'})).value;
  assert.deepEqual(messages.map(m => [m.id, m.attachments]), [
    ['u', [{id: 'file_user', name: 'file_user', mime_type: 'application/octet-stream', image: true}]],
    ['a', [{id: 'file_assistant', name: 'image.webp', mime_type: 'image/webp', image: true}]],
    ['bin', [{id: 'file_bin', name: 'data.bin', mime_type: 'application/octet-stream'}]], ['links', []],
  ]);
  assert.equal(messages[2].text, '');
  for (const [mid, aid, name, mime] of [['u', 'file_user', 'file_user', 'image/jpeg'],
    ['a', 'file_assistant', 'image.webp', 'image/webp']]) {
    assert.deepEqual((await file(mid, aid)).value, {id: 'other', messageId: mid, attachmentId: aid,
      attachment: {name, mime_type: mime, data_base64: 'AQEBAgI='}});
  }
  assert.equal(page.url(), origin + '/c/old');
  const calls = await page.evaluate(() => requests);
  assert.deepEqual(calls[0], {descriptor: '/backend-api/files/file_user/download', chat: 'other', authenticated: true});
  assert.deepEqual(calls[1], {original: 'https://region-1.media.oaiusercontent.com/opaque/7d09/photo?sig=fixture',
    credentials: 'omit', redirect: 'error', referrer: 'no-referrer', headers: {}});
  for (const [mid, aid] of [['u', 'file_assistant'], ['links', 'report'], ['private', 'file_hidden']]) {
    assert.equal((await file(mid, aid)).error, 'missing');
  }
  assert.equal(await page.evaluate(() => requests.length), calls.length);
});

test('download rejects untrusted descriptors, oversize streams and account changes before returning bytes', async t => {
  const {page, file} = await originalFixture(t);
  for (const url of ['https://oaiusercontent.com.example.org/x', 'http://cdn.oaiusercontent.com/x',
    'https://cdn.oaiusercontent.com:444/x', 'https://user@cdn.oaiusercontent.com/x',
    origin + '/backend-api/estuary/content?id=file_other', origin + '/api/auth/session',
    origin + '/backend-api/estuary/content?id=file_user&id=other']) {
    await page.evaluate(url => { signedUrl = url; }, url);
    assert.equal((await file('u', 'file_user')).error, 'invalid');
  }
  assert.equal(await page.evaluate(() => requests.some(r => r.original)), false);
  await page.evaluate(() => { signedUrl = location.origin + '/backend-api/estuary/content?id=file_user'; });
  assert.equal((await file('u', 'file_user', {maxBytes: 4})).error, 'too_large');
  assert.equal((await file('u', 'file_user', {maxBytes: 5})).value.attachment.data_base64, 'AQEBAgI=');
  await page.evaluate(() => { window.switchAccount = true; });
  assert.equal((await file('u', 'file_user')).error, 'account');
});

test('old references use only the full selected ancestry; recent and cross-file reads stay on the fast path', async t => {
  const {page, file} = await originalFixture(t);
  await page.evaluate(() => {
    const message = id => ({id, author: {role: 'assistant'},
      metadata: {attachments: [{id: 'file-' + id, name: id + '.pdf', mimeType: 'application/pdf'}]}});
    const mapping = {root: {parent: null, message: message('archived')},
      sibling: {parent: 'root', message: message('off-branch')}};
    let parent = 'root';
    for (let i = 0; i < 1100; ++i) {
      const key = 'recent-' + i;
      mapping[key] = {parent, message: {id: key, author: {role: 'user'}, content: {parts: ['later']}}};
      parent = key;
    }
    window.full = {conversation_id: 'other', current_node: parent, mapping};
    window.fullReads = 0;
    const provider = window.fetch;
    window.fetch = (path, options) => {
      if (new URL(path, location.origin).pathname === '/backend-api/conversation/other') {
        fullReads++;
        return Response.json(full);
      }
      return provider(path, options);
    };
  });
  assert.equal((await file('u', 'file_user')).value.attachment.data_base64, 'AQEBAgI=');
  assert.equal((await file('u', 'file-archived')).error, 'missing');
  assert.equal(await page.evaluate(() => fullReads), 0);
  assert.deepEqual((await file('archived', 'file-archived')).value.attachment,
    {name: 'archived.pdf', mime_type: 'application/pdf', data_base64: 'AQEBAgI='});
  const acquired = await page.evaluate(() => requests.length);
  assert.equal((await file('off-branch', 'file-off-branch')).error, 'missing');
  assert.equal((await file('unknown', 'file-archived')).error, 'missing');
  assert.equal((await file('archived', 'file-off-branch')).error, 'missing');
  await page.evaluate(() => { full.current_node = null; });
  assert.equal((await file('archived', 'file-archived')).error, 'mapping');
  await page.evaluate(() => { full.conversation_id = 'wrong'; });
  assert.equal((await file('archived', 'file-archived')).error, 'identity');
  assert.equal(await page.evaluate(() => requests.length), acquired);
});

async function stopFixture(t) {
  const ctx = await fixture(t, 'old');
  await ctx.page.evaluate(() => {
    document.body.insertAdjacentHTML('afterbegin',
      '<article data-chatgpt-search-message-ids=\'["old-user"]\'><div data-user-message-bubble>prompt</div></article>');
    document.querySelector('form').insertAdjacentHTML('beforeend', '<button type="button" data-testid="stop-button">Stop</button>');
    const stop = document.querySelector('[data-testid="stop-button"]');
    chats.old.is_generating = true;
    chats.old.messages.push({id: 'a1', author: {role: 'assistant'}, status: 'in_progress', end_turn: false});
    window.stops = 0;
    stop.onclick = () => {
      stops++;
      if (window.ignoreStop) return;
      chats.old.is_generating = false;
      chats.old.messages.at(-1).status = 'finished_successfully';
      stop.hidden = true;
    };
  });
  return {...ctx, cancel: (inputMessageId, args = {}) => ctx.call('cancel', {inputMessageId, ...args})};
}

test('Stop confirms the selected native input, returns false for an idle or unrelated turn', async t => {
  const {page, cancel} = await stopFixture(t);
  assert.equal((await cancel('another-input')).value.stopped, false);
  assert.equal((await cancel('old-user', {id: 'another-chat'})).value.stopped, false);
  await page.locator('[data-user-message-bubble]').evaluate(el => { el.dataset.messageId = 'conflicting-input'; });
  assert.equal((await cancel('old-user')).error, 'unconfirmed');
  await page.locator('[data-user-message-bubble]').evaluate(el => { delete el.dataset.messageId; });
  await page.locator('[data-testid="stop-button"]').evaluate(el => el.after(el.cloneNode(true)));
  assert.equal((await cancel('old-user')).error, 'unconfirmed');
  await page.locator('[data-testid="stop-button"]').last().evaluate(el => el.remove());
  assert.deepEqual((await cancel('old-user')).value, {id: 'old', inputMessageId: 'old-user', stopped: true});
  assert.equal((await cancel('old-user')).value.stopped, false);
  assert.equal(await page.evaluate(() => stops), 1);
});

test('an unconfirmed Stop or account change cannot replay the click', async t => {
  const {page, cancel} = await stopFixture(t);
  await page.evaluate(() => { window.ignoreStop = true; });
  assert.equal((await cancel('old-user')).error, 'unconfirmed');
  assert.equal((await cancel('old-user')).error, 'unconfirmed');
  await page.evaluate(() => { account = 'switched'; });
  assert.equal((await cancel('old-user')).error, 'account');
  assert.equal(await page.evaluate(() => stops), 1);
});
