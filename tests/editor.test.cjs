const test = require('node:test');
const assert = require('node:assert/strict');
let editor = {};
try { editor = require('../static/markdown-editor.js'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }

function apply(source, change) {
  return source.slice(0, change.from) + change.text + source.slice(change.to);
}

test('Markdown editor exports source edit rules and its adapter', () => {
  assert.equal(typeof editor.format, 'function');
  assert.equal(typeof editor.mount, 'function');
});

test('Enter continues bullets, ordered and checked task lists at the caret', () => {
  for (const [source, expected] of [
    ['- item', '- item\n- '], ['  * nested', '  * nested\n  * '],
    ['9. item', '9. item\n10. '], ['3) item', '3) item\n4) '],
    ['- [x] done', '- [x] done\n- [ ] '], ['2. [X] done', '2. [X] done\n3. [ ] '],
    ['> - quoted', '> - quoted\n> - ']
  ]) assert.equal(apply(source, editor.continueList(source, source.length, source.length)), expected);
});

test('Enter exits empty lists without swallowing neighboring content', () => {
  for (const [source, expected] of [['before\n- ', 'before\n'], ['  - [ ] ', ''], ['- [ ]', ''], ['4. [x]', ''], ['> - ', '> ']]) {
    assert.equal(apply(source, editor.continueList(source, source.length, source.length)), expected);
  }
  assert.equal(editor.continueList('normal text', 11, 11), null);
  assert.equal(editor.continueList('- value', 2, 5), null);
});

test('Tab and Shift Tab indent selected source lines and preserve selection', () => {
  const source = '- one\n- two';
  const result = editor.indent(source, 0, source.length, false);
  assert.equal(apply(source, result), '  - one\n  - two');
  const shifted = apply(source, result);
  assert.equal(apply(shifted, editor.indent(shifted, result.start, result.end, true)), source);
  assert.equal(apply('  - one', editor.indent('  - one', 4, 4, true)), '- one');
});

test('headings H1 to H6 replace existing markers on every selected line', () => {
  for (let level = 1; level <= 6; level++) {
    const source = '## First\nSecond';
    assert.equal(apply(source, editor.format(source, 0, source.length, 'h' + level)), '#'.repeat(level) + ' First\n' + '#'.repeat(level) + ' Second');
  }
});

test('empty block formats select editable sample text, never the Markdown marker', () => {
  for (const command of ['h1', 'h6', 'quote', 'list', 'ordered-list', 'task']) {
    const change = editor.format('', 0, 0, command);
    assert.match(change.text.slice(change.start, change.end), /^(?:标题|列表项)$/);
  }
});

test('inline formats preserve visible Markdown and selected text', () => {
  for (const [command, expected] of [['bold', '**word**'], ['italic', '*word*'], ['strike', '~~word~~'], ['inline-code', '`word`'], ['link', '[word](https://)'], ['image', '![word](https://)'], ['video', '[word](https:// "video")']]) {
    assert.equal(apply('word', editor.format('word', 0, 4, command)), expected);
  }
});

test('block toolbar supports quote, bullets, ordered tasks, fenced code, table and divider', () => {
  for (const [command, expected] of [['quote', '> one\n> two'], ['list', '- one\n- two'], ['ordered-list', '1. one\n2. two'], ['task', '- [ ] one\n- [ ] two']]) {
    assert.equal(apply('one\ntwo', editor.format('one\ntwo', 0, 7, command)), expected);
  }
  assert.match(editor.format('', 0, 0, 'code').text, /^```\n[\s\S]*\n```\n$/);
  assert.match(editor.format('', 0, 0, 'table').text, /\|[^\n]*\n\|[\s:|-]+\|/);
  assert.equal(editor.format('', 0, 0, 'divider').text, '---\n');
});

test('native adapter emits immediate input for insertion but not mode initialization', () => {
  const textarea = new EventTarget();
  Object.assign(textarea, { value: 'hello', selectionStart: 5, selectionEnd: 5, readOnly: false, style: {}, focus() {},
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
    setRangeText(text, start, end) { this.value = this.value.slice(0, start) + text + this.value.slice(end); this.setSelectionRange(start + text.length, start + text.length); }
  });
  let inputs = 0;
  textarea.addEventListener('input', () => inputs++);
  const adapter = editor.mount({ textarea, CodeMirror: null });
  adapter.setMode('markdown');
  assert.equal(inputs, 0);
  adapter.replaceSelection(' world');
  assert.equal(adapter.getValue(), 'hello world');
  assert.equal(inputs, 1);
  adapter.readOnly(true);
  adapter.replaceSelection(' blocked');
  assert.equal(adapter.getValue(), 'hello world');
});

function mountFakeCodeMirror(value) {
  const textarea = new EventTarget();
  Object.assign(textarea, { value, selectionStart: 0, selectionEnd: 0, readOnly: false, style: {}, focus() {},
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
    setRangeText(text, start, end) { this.value = this.value.slice(0, start) + text + this.value.slice(end); this.setSelectionRange(start + text.length, start + text.length); }
  });
  let content = value, from = 0, to = 0, handlers = {}, marks = [], wrapper = { style: {}, setAttribute() {} };
  let inputCount = 0;
  textarea.addEventListener('input', () => inputCount++);
  const cm = {
    options: {},
    on(name, listener) { handlers[name] = listener; },
    getCursor(which) { return { index: which === 'to' ? to : from }; },
    indexFromPos(position) { return position.index; },
    posFromIndex(index) { return { index }; },
    setSelection(start, end) { from = start.index; to = end.index; if (handlers.cursorActivity) handlers.cursorActivity(); },
    getValue() { return content; },
    setValue(next) { content = next; if (handlers.change) handlers.change(); },
    replaceRange(text, start, end) {
      content = content.slice(0, start.index) + text + content.slice(end.index);
      marks.forEach(mark => { if (mark.index >= start.index) mark.index = Math.max(start.index, mark.index + text.length - (end.index - start.index)); });
      from = to = start.index + text.length;
      if (handlers.change) handlers.change();
    },
    setBookmark(position) {
      const mark = { index: position.index, cleared: false,
        find() { return this.cleared ? undefined : { index: this.index }; },
        clear() { this.cleared = true; }
      };
      marks.push(mark);
      return mark;
    },
    operation(callback) { callback(); },
    getWrapperElement() { return wrapper; },
    getScrollerElement() { return wrapper; },
    setOption(key, next) { this.options[key] = next; },
    refresh() {}, focus() {}, scrollIntoView() {}
  };
  const CodeMirror = { fromTextArea(_, options) { cm.options = options; return cm; } };
  const adapter = editor.mount({ textarea, CodeMirror });
  return { textarea, cm, adapter, inputs: () => inputCount };
}

test('CodeMirror changes synchronously mirror source and emit exactly one native input', () => {
  const { textarea, cm, adapter, inputs } = mountFakeCodeMirror('# Heading');
  adapter.setMode('markdown');
  assert.equal(inputs(), 0);
  adapter.setSelection(2, 9);
  adapter.replaceSelection('Next');
  assert.equal(textarea.value, '# Next');
  assert.equal(cm.getValue(), '# Next');
  assert.equal(inputs(), 1);
  assert.deepEqual(adapter.getSelection(), { start: 6, end: 6 });
  cm.setValue('typed content');
  assert.equal(textarea.value, 'typed content');
  assert.equal(inputs(), 2);
});

test('mode switching retains content and selection without synthetic input or autosave', () => {
  const { textarea, cm, adapter, inputs } = mountFakeCodeMirror('# Heading');
  adapter.setMode('markdown');
  adapter.setSelection(2, 5);
  adapter.setMode('code');
  assert.equal(textarea.value, '# Heading');
  assert.equal(textarea.style.display, '');
  assert.equal(textarea.selectionStart, 2);
  textarea.value = 'changed in code';
  textarea.setSelectionRange(3, 3);
  adapter.setMode('markdown');
  assert.equal(cm.getValue(), 'changed in code');
  assert.equal(textarea.style.display, 'none');
  assert.deepEqual(adapter.getSelection(), { start: 3, end: 3 });
  assert.equal(inputs(), 0);
});

test('read-only state reaches CodeMirror and prevents toolbar/media insertion', () => {
  const { cm, adapter, inputs } = mountFakeCodeMirror('source');
  adapter.setMode('markdown');
  adapter.readOnly(true);
  adapter.replaceSelection('bad');
  adapter.format('bold');
  assert.equal(cm.options.readOnly, true);
  assert.equal(adapter.getValue(), 'source');
  assert.equal(inputs(), 0);
});

test('upload insertion uses a moving bookmark and never replaces a later text selection', () => {
  const { cm, adapter, inputs } = mountFakeCodeMirror('start target tail');
  adapter.setMode('markdown');
  adapter.setSelection(0, 5);
  const insert = adapter.captureInsertionPoint();
  cm.replaceRange('before ', { index: 0 }, { index: 0 });
  adapter.setSelection(13, 19);
  insert('[video](url "video")');
  assert.equal(adapter.getValue(), 'before start[video](url "video") target tail');
  assert.equal(inputs(), 2);
  insert('duplicate');
  assert.equal(inputs(), 2);
});

test('upload bookmark survives native edits and switching back to Markdown', () => {
  const { textarea, adapter, inputs } = mountFakeCodeMirror('start tail');
  adapter.setMode('markdown');
  adapter.setSelection(5, 5);
  const insert = adapter.captureInsertionPoint();
  adapter.setMode('code');
  textarea.value = 'prefix start tail';
  textarea.dispatchEvent(new Event('input'));
  adapter.setMode('markdown');
  adapter.setSelection(13, 17);
  insert(' image');
  assert.equal(adapter.getValue(), 'prefix start image tail');
  assert.equal(inputs(), 2);
});

test('cancelled upload bookmarks and native selected ranges do not overwrite content', () => {
  const { adapter } = mountFakeCodeMirror('preserve');
  adapter.setMode('markdown');
  const cancelled = adapter.captureInsertionPoint();
  cancelled.clear();
  cancelled('discard');
  assert.equal(adapter.getValue(), 'preserve');
  const textarea = new EventTarget();
  Object.assign(textarea, { value: 'text tail', selectionStart: 4, selectionEnd: 4, style: {}, readOnly: false,
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
    setRangeText(text, start, end) { this.value = this.value.slice(0, start) + text + this.value.slice(end); }
  });
  const native = editor.mount({ textarea, CodeMirror: null });
  const insert = native.captureInsertionPoint();
  textarea.setSelectionRange(5, 9);
  insert(' upload');
  assert.equal(native.getValue(), 'text upload tail');
});
