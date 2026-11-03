const test = require('node:test');
const assert = require('node:assert/strict');
let slash = {};
try { slash = require('../static/slash-commands.js'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }

test('slash commands export the menu and independently testable rules', () => {
  for (const name of ['mount', 'detectTrigger', 'filterCommands', 'applyCommand', 'positionMenu']) assert.equal(typeof slash[name], 'function');
});

test('a single slash at a line start captures only the current query', () => {
  for (const source of ['/', '/h2', 'text\n/task', 'text\n   /标题']) {
    const trigger = slash.detectTrigger(source, source.length, source.length);
    assert.equal(source.slice(trigger.from, trigger.to), '/' + trigger.query);
    assert.equal(trigger.source, source);
  }
  assert.deepEqual(slash.detectTrigger('/h2 trailing', 3, 3), { from: 0, to: 3, query: 'h2', source: '/h2 trailing' });
});

test('slash detection rejects paths, URLs, selections and code blocks', () => {
  for (const source of ['//', '/usr/local', 'https://', 'word /h1', '    /h1', '\t/h1', '/two words', '```js\n/h1', '~~~\n/table', '````js\n```\n/h1']) {
    assert.equal(slash.detectTrigger(source, source.length, source.length), null, source);
  }
  assert.equal(slash.detectTrigger('/h1', 0, 3), null);
  assert.equal(slash.detectTrigger('/h1', 3, 3, true), null);
  assert.equal(slash.detectTrigger('/h1/path', 3, 3), null);
  assert.equal(slash.detectTrigger('/h1\\path', 3, 3), null);
  for (const source of ['```js\nx\n```\n/h1', '~~~\nx\n~~~~\n/task']) assert.ok(slash.detectTrigger(source, source.length, source.length));
});

test('slash detection follows nested fenced and indented code containers', () => {
  const sources = [
    '- ```\n  /h1\n  ```', '- ~~~\n  /h1\n  ~~~',
    '1. ```js\n   /h1\n   ```', '- ```\n  /h1',
    '> ```\n> /h1\n> ```', '> - ```\n>   /h1\n>   ```',
    '- outer\n  - ```\n    /h1\n    ```',
    '- item\n\n      /h1', '> item\n>\n>     /h1',
    '`multiline\n/h1\ncode`'
  ];
  for (const source of sources) {
    const caret = source.indexOf('/h1') + 3;
    assert.equal(slash.detectTrigger(source, caret, caret), null, source);
  }
  for (const source of ['- ```\n  code\n  ```\n  /h1', '- ~~~\n  code\n  ~~~\n\n/h1', '> ```\n> code\n> ```\n/h1', '- ordinary\n  /h1']) {
    assert.ok(slash.detectTrigger(source, source.length, source.length), source);
  }
});

test('commands support English IDs, Chinese labels and no-match searches', () => {
  const all = slash.filterCommands('');
  assert.equal(all.length, 14);
  assert.deepEqual(slash.filterCommands('h2').map(command => command.id), ['h2']);
  assert.deepEqual(slash.filterCommands('上传图片').map(command => command.id), ['upload-image']);
  assert.ok(slash.filterCommands('PAGE').some(command => command.id === 'page-link'));
  assert.deepEqual(slash.filterCommands('no-such-command'), []);
});

function adapter(source) {
  let value = source, start = source.length, end = start;
  const calls = [];
  return {
    calls, getValue: () => value, getSelection: () => ({ start, end }),
    setSelection(from, to) { start = from; end = to == null ? from : to; },
    replaceSelection(text) { value = value.slice(0, start) + text + value.slice(end); end = start += text.length; calls.push(['replace', text]); },
    format(command) { calls.push(['format', command, value]); },
    focus() { calls.push(['focus']); },
    getCursorRect() { return { left: 950, top: 680, bottom: 700 }; }
  };
}

test('choosing removes only /query then formats at its former position', () => {
  const editor = adapter('before\n  /h2 after');
  editor.setSelection(12, 12);
  const state = slash.detectTrigger(editor.getValue(), 12, 12);
  assert.equal(slash.applyCommand({ editor }, state, 'h2'), true);
  assert.equal(editor.getValue(), 'before\n   after');
  assert.deepEqual(editor.calls.find(call => call[0] === 'format'), ['format', 'h2', 'before\n   after']);
});

test('pages and uploads run only after deletion so insertion bookmarks exclude the query', () => {
  for (const [command, type, expected] of [['page-link', 'openPage', 'link'], ['page-embed', 'openPage', 'embed'], ['upload-image', 'upload', 'image'], ['upload-video', 'upload', 'video']]) {
    const editor = adapter('/' + command), calls = [];
    const options = { editor, [type](mode) { calls.push([mode, editor.getValue(), editor.getSelection().start]); } };
    assert.equal(slash.applyCommand(options, slash.detectTrigger(editor.getValue(), editor.getValue().length, editor.getValue().length), command), true);
    assert.deepEqual(calls, [[expected, '', 0]]);
    assert.equal(editor.calls.some(call => call[0] === 'format'), false);
  }
});

test('stale menus, disabled edits and missing callbacks never remove source', () => {
  for (const reason of ['value', 'cursor', 'disabled', 'command', 'callback']) {
    const editor = adapter('/h1'), state = slash.detectTrigger('/h1', 3, 3), options = { editor };
    let command = 'h1';
    if (reason === 'value') { editor.setSelection(0, 0); editor.replaceSelection('new\n'); }
    if (reason === 'cursor') editor.setSelection(0, 0);
    if (reason === 'disabled') options.isEnabled = () => false;
    if (reason === 'command') command = 'unknown';
    if (reason === 'callback') command = 'page-link';
    const before = editor.getValue();
    assert.equal(slash.applyCommand(options, state, command), false, reason);
    assert.equal(editor.getValue(), before);
  }
});

test('positioning stays within mobile keyboards and narrow viewports', () => {
  for (const viewport of [{ left: 0, top: 0, width: 1024, height: 720 }, { left: 0, top: 90, width: 320, height: 260 }]) {
    const pos = slash.positionMenu({ left: 1000, top: 680, bottom: 700 }, viewport, 360);
    assert.ok(pos.left >= viewport.left + 8);
    assert.ok(pos.left + pos.width <= viewport.left + viewport.width - 8);
    assert.ok(pos.top >= viewport.top + 8);
    assert.ok(pos.top + pos.maxHeight <= viewport.top + viewport.height - 8);
  }
  const short = slash.positionMenu({ left: 20, top: 680, bottom: 700 }, { left: 0, top: 0, width: 1024, height: 720 }, 40);
  assert.equal(short.top, 634);
});

function harness(value = '/h2') {
  class Element {
    constructor() { this.listeners = {}; this.attributes = {}; this.children = []; this.style = {}; this.hidden = false; }
    addEventListener(name, listener, capture) { (this.listeners[name] ||= []).push({ listener, capture }); }
    removeEventListener(name, listener) { this.listeners[name] = (this.listeners[name] || []).filter(item => item.listener !== listener); }
    emit(name, extra = {}) { const event = { target: this, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra }; for (const item of this.listeners[name] || []) item.listener(event); return event; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    removeAttribute(name) { delete this.attributes[name]; }
    appendChild(child) { this.children.push(child); return child; }
    replaceChildren() { this.children = []; }
    contains(target) { return this === target || this.children.some(child => child.contains(target)); }
    querySelector() { return this.input || null; }
    getBoundingClientRect() { return { left: 10, top: 10, bottom: 30, height: 360 }; }
    scrollIntoView() {}
    remove() { this.removed = true; }
  }
  const document = new Element(), window = new Element();
  document.body = new Element(); document.createElement = () => new Element(); document.defaultView = window;
  window.innerWidth = 1024; window.innerHeight = 720;
  const textarea = new Element(), host = new Element(), input = new Element(), editor = adapter(value);
  textarea.ownerDocument = document; host.input = input;
  let enabled = true;
  const menu = slash.mount({ textarea, host, editor, isEnabled: () => enabled });
  return { document, window, textarea, host, input, editor, menu, disable() { enabled = false; } };
}

test('mounted menu supports captured keyboard selection and accessible editor state', () => {
  const h = harness();
  h.menu.refresh();
  assert.equal(h.menu.isOpen(), true);
  assert.equal(h.input.attributes['aria-expanded'], 'true');
  assert.ok(h.input.attributes['aria-activedescendant']);
  assert.equal(h.host.listeners.keydown[0].capture, true);
  const enter = h.host.emit('keydown', { key: 'Enter' });
  assert.equal(enter.prevented, true);
  assert.equal(h.editor.getValue(), '');
  assert.ok(h.editor.calls.some(call => call[0] === 'format' && call[1] === 'h2'));
  assert.equal(h.menu.isOpen(), false);
});

test('Escape and outside dismissal retain text and do not reopen on cursor notifications', () => {
  for (const type of ['escape', 'outside']) {
    const h = harness(); h.menu.refresh();
    if (type === 'escape') h.host.emit('keydown', { key: 'Escape' });
    else h.document.emit('pointerdown');
    h.textarea.emit('select');
    assert.equal(h.menu.isOpen(), false);
    assert.equal(h.editor.getValue(), '/h2');
  }
});

test('composition suppresses menu and command execution until it ends', () => {
  const h = harness(); h.menu.refresh();
  h.host.emit('compositionstart');
  h.textarea.emit('input');
  assert.equal(h.menu.isOpen(), false);
  assert.equal(h.menu.choose('h2'), false);
  h.host.emit('compositionend');
  h.textarea.emit('input');
  assert.equal(h.menu.isOpen(), true);
});

test('keyboard navigation wraps, Tab chooses and no matches do not swallow Enter', () => {
  const h = harness('/'); h.menu.refresh();
  h.host.emit('keydown', { key: 'ArrowUp' });
  const selected = h.input.attributes['aria-activedescendant'];
  h.host.emit('keydown', { key: 'ArrowDown' });
  assert.notEqual(h.input.attributes['aria-activedescendant'], selected);
  h.host.emit('keydown', { key: 'Tab' });
  assert.ok(h.editor.calls.some(call => call[0] === 'format' && call[1] === 'h1'));
  const empty = harness('/no-such-command'); empty.menu.refresh();
  assert.equal(empty.host.emit('keydown', { key: 'Enter' }).prevented, undefined);
  assert.equal(empty.editor.getValue(), '/no-such-command');
});

test('mounted menu rechecks enabled state and removes listeners when destroyed', () => {
  const h = harness(); h.menu.refresh(); h.disable();
  assert.equal(h.menu.choose('h2'), false);
  assert.equal(h.editor.getValue(), '/h2');
  h.menu.destroy();
  assert.equal(h.input.attributes['aria-controls'], undefined);
  assert.equal(h.host.listeners.keydown.length, 0);
});

test('cursor notifications after keyboard navigation preserve the displayed options', () => {
  const h = harness('/'); h.menu.refresh();
  h.host.emit('keydown', { key: 'ArrowUp' });
  const menu = h.document.body.children[0], list = menu.children[1], selected = list.children[13];
  h.host.emit('keyup', { key: 'ArrowUp' });
  assert.equal(list.children[13], selected);
});

test('pointer clicks select without blurring and preserve slash text on stale state', () => {
  const h = harness(); h.menu.refresh();
  const menu = h.document.body.children[0], list = menu.children[1];
  assert.equal(menu.emit('mousedown').prevented, true);
  list.children[0].emit('click');
  assert.equal(h.editor.getValue(), '');
  assert.equal(h.menu.isOpen(), false);
  const stale = harness(); stale.menu.refresh(); stale.editor.setSelection(0, 0);
  stale.document.body.children[0].children[1].children[0].emit('click');
  assert.equal(stale.editor.getValue(), '/h2');
});

test('slash deletion input events and late keyup never reopen the menu', () => {
  const h = harness(); h.menu.refresh();
  const replace = h.editor.replaceSelection;
  h.editor.replaceSelection = function (text) { replace.call(this, text); h.textarea.emit('input'); };
  h.host.emit('keydown', { key: 'Enter' });
  h.host.emit('keyup', { key: 'Enter' });
  assert.equal(h.menu.isOpen(), false);
  assert.equal(h.editor.getValue(), '');
});
