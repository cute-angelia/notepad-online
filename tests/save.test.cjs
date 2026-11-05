const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function editor({isNew = false, version = '1'} = {}) {
  const elements = new Map(), timers = new Map(), listeners = {}, requests = [], replies = [];
  let timerID = 0;
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: id === 'note-secret' ? 'apple' : id === 'content' ? 'original' : '',
      dataset: {}, style: {}, listeners: {}, hidden: true,
      classList: {contains() { return false; }, toggle() {}, add() {}, remove() {}},
      addEventListener(type, fn) { this.listeners[type] = fn; },
      querySelector() { return {textContent: ''}; }, querySelectorAll() { return []; },
      setAttribute() {},
    });
    return elements.get(id);
  }
  const body = {dataset: {slug: 'note', editable: 'true', new: String(isNew), kind: 'text', version, lockedUntil: '0'}};
  const context = {
    document: {body, getElementById: element, querySelectorAll: () => [], addEventListener(type, fn) { listeners[type] = fn; }},
    window: {
      localStorage: {getItem() { return null; }, setItem() {}},
      matchMedia: () => ({matches: false, addEventListener() {}}),
      documentOutline: {update() {}},
      addEventListener(type, fn) { listeners[type] = fn; },
    },
    history: {replaceState() {}}, URLSearchParams, TextEncoder, Date,
    setTimeout(fn) { const id = ++timerID; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async (url, options) => {
      requests.push({url, data: Object.fromEntries(options.body)});
      const reply = await (replies.shift() || {status: 200, data: {version: Number(body.dataset.version) + 1}});
      return {ok: reply.status < 400, status: reply.status, json: async () => reply.data};
    },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../static/script.js'), 'utf8'), context);
  return {
    element, body, requests, replies, timers,
    input(text) { element('content').value = text; element('content').listeners.input(); },
    async save() {
      listeners.keydown({ctrlKey: true, key: 's', preventDefault() {}});
      await new Promise(setImmediate);
    },
    beforeUnload() { const event = {preventDefault() { this.prevented = true; }}; listeners.beforeunload(event); return event; },
    async runTimers() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); await new Promise(setImmediate); },
    settle: () => new Promise(setImmediate),
  };
}

test('successive saves send and advance the server version', async () => {
  const p = editor({version: '7'});
  p.input('first edit');
  await p.save();
  assert.equal(p.requests[0].data.version, '7');
  assert.equal(p.body.dataset.version, '8');
  assert.equal(p.element('save-status').textContent, '已保存');
  p.input('second edit');
  await p.save();
  assert.equal(p.requests[1].data.version, '8');
  assert.equal(p.body.dataset.version, '9');
  assert.equal(p.beforeUnload().prevented, undefined);
});

test('version conflict preserves local edits and blocks automatic and manual retries', async () => {
  const p = editor();
  p.replies.push({status: 409, data: {code: 'version_conflict', error: 'conflict'}});
  p.input('local draft');
  await p.save();
  assert.equal(p.element('content').value, 'local draft');
  assert.equal(p.body.dataset.version, '1');
  assert.equal(p.element('save-status').textContent, '版本冲突，未保存');
  assert.equal(p.element('mobile-save-status').textContent, '版本冲突，未保存');
  assert.match(p.element('notice').textContent, /先复制.*再刷新/);
  assert.equal(p.element('notice').hidden, false);
  assert.equal(p.beforeUnload().prevented, true);
  p.input('more local edits');
  await p.runTimers();
  await p.save();
  assert.equal(p.element('save-status').textContent, '版本冲突，未保存');
  assert.equal(p.requests.length, 1);
  assert.equal(p.timers.size, 0);
});

test('draft creation adopts the initial version before subsequent saves', async () => {
  const p = editor({isNew: true, version: '0'});
  p.replies.push({status: 201, data: {id: 42, version: 1, edit_url: '/note/edit'}});
  p.input('draft');
  await p.save();
  assert.equal(p.requests[0].url, '/api/notes');
  assert.equal(p.requests[0].data.version, undefined);
  assert.equal(p.body.dataset.version, '1');
  p.input('next edit');
  await p.save();
  assert.equal(p.requests[1].url, '/note');
  assert.equal(p.requests[1].data.version, '1');
});

test('edits made during a save stay pending and use the acknowledged version', async () => {
  const p = editor();
  let finish;
  p.replies.push(new Promise(resolve => { finish = resolve; }));
  p.input('first');
  await p.save();
  p.input('typed during request');
  finish({status: 200, data: {version: 2}});
  await p.settle();
  assert.equal(p.element('save-status').textContent, '待保存');
  assert.equal(p.beforeUnload().prevented, true);
  await p.runTimers();
  assert.equal(p.requests[1].data.version, '2');
  assert.equal(p.requests[1].data.text, 'typed during request');
  assert.equal(p.element('save-status').textContent, '已保存');
});

test('ordinary save failure does not advance version or discard edits', async () => {
  const p = editor();
  p.replies.push({status: 500, data: {error: 'temporary failure'}});
  p.input('retry me');
  await p.save();
  assert.equal(p.body.dataset.version, '1');
  assert.equal(p.element('save-status').textContent, '保存失败');
  assert.equal(p.beforeUnload().prevented, true);
  await p.save();
  assert.equal(p.requests[1].data.version, '1');
  assert.equal(p.element('save-status').textContent, '已保存');
});
