const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function outlineHarness(useEditor) {
  function element() {
    return {
      dataset: {}, attributes: {}, children: [], style: { setProperty() {} },
      listeners: {}, value: '# First\ntext\n# Second', selectionStart: 0,
      addEventListener(name, listener) { this.listeners[name] = listener; },
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; },
      appendChild(child) { this.children.push(child); },
      replaceChildren(fragment) { this.children = fragment.children; }
    };
  }
  const elements = new Map(['document-outline', 'outline-list', 'outline-empty', 'content'].map(id => [id, element()]));
  let position = 13;
  const window = {
    matchMedia: () => ({ matches: true }), renderMarkdown() {},
    markdownTools: { outline: () => [
      { offset: 0, depth: 1, id: 'first', text: 'First' },
      { offset: 13, depth: 1, id: 'second', text: 'Second' }
    ] }
  };
  if (useEditor) window.noteEditor = { getSelection: () => ({ start: position, end: position }) };
  vm.runInNewContext(fs.readFileSync(require.resolve('../static/outline.js'), 'utf8'), {
    window, marked: {}, document: {
      body: { classList: { toggle() {} } }, getElementById: id => elements.get(id),
      createElement: element, createDocumentFragment: element
    }
  });
  window.documentOutline.update(elements.get('content').value, { querySelectorAll: () => [] }, true);
  return {
    textarea: elements.get('content'),
    links: elements.get('outline-list').children.map(item => item.children[0]),
    move(offset) { position = offset; elements.get('content').listeners.select(); }
  };
}

test('outline follows the Markdown adapter instead of the hidden textarea selection', () => {
  const h = outlineHarness(true);
  assert.equal(h.textarea.selectionStart, 0);
  assert.equal(h.links[1].attributes['aria-current'], 'location');
  h.move(0);
  assert.equal(h.links[0].attributes['aria-current'], 'location');
  assert.equal(h.links[1].attributes['aria-current'], undefined);
});

test('outline still follows native textarea selection without an editor adapter', () => {
  const h = outlineHarness(false);
  assert.equal(h.links[0].attributes['aria-current'], 'location');
  h.textarea.selectionStart = 13;
  h.move(13);
  assert.equal(h.links[1].attributes['aria-current'], 'location');
});
