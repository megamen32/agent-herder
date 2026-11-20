// node --test native.test.mjs (PLAYWRIGHT_MODULE may name playwright-core/index.mjs).
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {after, before, test} from 'node:test';

const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const [native, composer, read] = await Promise.all(
  ['native.js', 'composer.js', 'read.js'].map(file => readFile(new URL(file, import.meta.url), 'utf8'))
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
  const call = (op, args = {}) => page.evaluate(
    '(' + native + ')(' + (['activity', 'read'].includes(op) ? read : composer) + ',' +
    JSON.stringify({op, id, text, scope, ...args}) + ')'
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
