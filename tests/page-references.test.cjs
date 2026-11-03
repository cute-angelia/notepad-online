const test = require('node:test');
const assert = require('node:assert/strict');
const marked = require('../static/marked.min.js');
const fs = require('node:fs');
const vm = require('node:vm');
let pages = {};
try { pages = require('../static/page-references.js'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }

test('page reference module exports Markdown and stable target helpers', () => {
  assert.equal(typeof pages.extension, 'function');
  assert.equal(typeof pages.parseTarget, 'function');
  assert.equal(typeof pages.mount, 'function');
});

test('references accept stable IDs and same-origin note URLs, not titles or external URLs', () => {
  for (const [input, expected] of [
    ['123', { id: 123 }], ['[[page:123]]', { id: 123 }], ['![[page:123|Title]]', { id: 123 }],
    ['[[page:123:Title]]', { id: 123 }], ['![[page:123:Title]]', { id: 123 }],
    ['/api/pages/123/view', { id: 123 }], ['https://notes.example/abc/edit?pwd=secret', { slug: 'abc' }],
    ['中文页', { slug: '中文页' }], ['/a%26b', { slug: 'a&b' }],
    ['a?b', { slug: 'a?b' }], ['a#b', { slug: 'a#b' }], ['a:b', { slug: 'a:b' }], ['%', { slug: '%' }]
  ]) assert.deepEqual(pages.parseTarget(input, 'https://notes.example'), expected);
  for (const input of ['0', '01', '-1', '2147483648', 'https://other.example/abc', '//other.example/abc', '/abc/extra', '/api/secret', '/%ZZ']) {
    assert.throws(() => pages.parseTarget(input, 'https://notes.example'), undefined, input);
  }
});

test('marked page extension emits escaped stable link/embed placeholders but leaves code alone', () => {
  marked.use({ extensions: [pages.extension()], tokenizer: pages.tokenizer(marked) });
  const html = marked.parse('[[page:12]] ![[page:34|<img onerror=x>]] [[page:56:Title]]');
  assert.match(html, /href="\/api\/pages\/12\/view"/);
  assert.match(html, />加载中…<\/a>/);
  assert.doesNotMatch(html, /页面 #/);
  assert.match(html, /class="page-embed" data-page-id="34"/);
  assert.match(html, /href="\/api\/pages\/56\/view"/);
  assert.match(html, />Title<\/a>/);
  assert.ok(!html.includes('<img'));
  assert.match(html, /&lt;img onerror=x&gt;/);
  for (const source of ['`[[page:12]]`', '```\n![[page:12]]\n```', '\\[[page:12]]', '[[page:0]]', '[[page:2147483648]]']) {
    assert.doesNotMatch(marked.parse(source), /data-page-id/);
  }
});

test('unfinished code fences at EOF do not turn example references into live page reads', () => {
  for (const source of ['```md\n[[page:12]]', '- ```\n  [[page:12]]', '> ```\n> ![[page:12]]']) {
    const html = marked.parse(source);
    assert.match(html, /<pre><code/);
    assert.doesNotMatch(html, /data-page-id/);
  }
});

test('reference formatter supports optional title and stable link/embed syntax', () => {
  assert.equal(pages.reference(12, false), '[[page:12]]');
  assert.equal(pages.reference(12, false, 'Title'), '[[page:12:Title]]');
  assert.equal(pages.reference(12, true), '![[page:12]]');
  assert.equal(pages.reference(12, true, 'Title'), '![[page:12:Title]]');
  assert.equal(pages.reference(12, false, '  [Trim] \n'), '[[page:12:[Trim]]');
  assert.throws(() => pages.reference(0, false));
});

function hydrateHarness(fetcher) {
  let now = 1000;
  class Element {
    constructor(tag = 'span', id, embed = false) {
      this.tagName = tag.toUpperCase(); this.children = []; this.textContent = ''; this.isConnected = true;
      this.attributes = new Map(id ? [['data-page-id', String(id)]] : []);
      this.classes = new Set(embed ? ['page-embed'] : []);
      this.classList = { contains: value => this.classes.has(value), add: value => this.classes.add(value) };
    }
    getAttribute(key) { return this.attributes.get(key) || null; }
    hasAttribute(key) { return this.attributes.has(key); }
    removeAttribute(key) { this.attributes.delete(key); }
    appendChild(node) { this.children.push(node); }
    replaceChildren(...children) { this.children = children; }
    contains(node) { return this.children.includes(node); }
    querySelectorAll() { return this.children; }
  }
  const renders = [], requests = [];
  const window = {
    marked: { use() {} }, document: { body: { dataset: { noteId: '1' } }, createElement: tag => new Element(tag) },
    fetch: async (url, options) => { requests.push([url, options]); return fetcher(url); },
    renderMarkdown(...args) { renders.push(args); }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../static/page-references.js'), 'utf8'), { window, WeakMap, Map, URL, URLSearchParams, Date: { now: () => now } });
  const root = new Element('div');
  return { pages: window.NotepadPages, root, Element, requests, renders, advance(ms) { now += ms; } };
}

function response(page) { return { ok: true, json: async () => page }; }

test('hydration deduplicates reads, uses live titles and renders embedded code as literal text', async () => {
  const h = hydrateHarness(() => response({ id: 12, title: '<renamed>', text: '<script>unsafe</script>', document_type: 'code' }));
  const link = new h.Element('a', 12), embed = new h.Element('span', 12, true);
  h.root.children = [link, embed];
  await h.pages.enhance(h.root);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0][1].cache, 'no-store');
  assert.equal(link.textContent, '<renamed>');
  assert.equal(embed.children[0].textContent, '<renamed>');
  assert.equal(embed.children[1].children[0].children[0].textContent, '<script>unsafe</script>');
  assert.equal(h.renders.length, 0);
});

test('missing or unauthorized pages never expose their metadata', async () => {
  const h = hydrateHarness(url => {
    if (url.includes('12')) return { ok: false, status: 404 };
    return { ok: false, status: 403 };
  });
  const link = new h.Element('a', 12), embed = new h.Element('span', 13, true);
  h.root.children = [link, embed];
  await h.pages.enhance(h.root);
  assert.equal(link.textContent, '页面不存在');
  assert.equal(embed.textContent, '需要授权查看');
  assert.equal(embed.children.length, 0);
});

test('embedded cycles and depth/count/read limits stop before fetching more pages', async () => {
  const h = hydrateHarness(url => response({ title: 'Page', text: '', document_type: 'text' }));
  const cycle = new h.Element('span', 1, true);
  h.root.children = [cycle, ...Array.from({ length: 21 }, (_, i) => new h.Element('span', i + 2, true))];
  await h.pages.enhance(h.root);
  assert.match(cycle.textContent, /循环/);
  assert.equal(h.requests.length, 20);
  assert.match(h.root.children[21].textContent, /上限/);
  const deep = new h.Element('span', 50, true); h.root.children = [deep];
  await h.pages.enhance(h.root, { path: ['1', '2', '3', '4'], budget: { embeds: 0, reads: 0, requests: new Map() } });
  assert.equal(h.requests.length, 20);
  h.root.children = Array.from({ length: 40 }, (_, i) => new h.Element('a', i + 100));
  await h.pages.enhance(h.root);
  assert.equal(h.requests.length, 52);
});

test('late responses from a previous render cannot overwrite new content', async () => {
  const pending = [];
  const h = hydrateHarness(() => new Promise(resolve => pending.push(resolve)));
  const old = new h.Element('a', 12); h.root.children = [old];
  const first = h.pages.enhance(h.root);
  const current = new h.Element('a', 13); h.root.children = [current];
  const second = h.pages.enhance(h.root);
  pending[1](response({ title: 'Current' })); await second;
  pending[0](response({ title: 'Old' })); await first;
  assert.equal(old.textContent, '');
  assert.equal(current.textContent, 'Current');
});

test('typing rerenders reuse bounded page reads, then recheck permissions after a short TTL', async () => {
  let allowed = true;
  const h = hydrateHarness(() => allowed ? response({ title: 'Readable' }) : { ok: false, status: 403 });
  for (let i = 0; i < 100; i++) {
    h.root.children = [new h.Element('a', 12)];
    await h.pages.enhance(h.root);
  }
  assert.equal(h.requests.length, 1);
  allowed = false; h.advance(31000);
  await h.pages.enhance(h.root);
  assert.equal(h.requests.length, 2);
  assert.match(h.root.children[0].textContent, /需要授权查看/);
});

test('hidden preview hydration does not issue requests or consume rate limits', async () => {
  const h = hydrateHarness(() => response({ title: 'Page' }));
  h.root.getClientRects = () => [];
  h.root.children = [new h.Element('a', 12)];
  await h.pages.enhance(h.root);
  assert.equal(h.requests.length, 0);
});

test('mount copy-page-reference copies reference with title', async () => {
  let copiedText = '';
  const listeners = {};
  const copyBtn = {
    disabled: false,
    addEventListener(event, fn) { listeners[event] = fn; }
  };
  const elements = {
    'copy-page-reference': copyBtn
  };
  const window = {
    marked: { use() {} },
    document: {
      getElementById(id) { return elements[id] || null; },
      querySelector() { return null; },
      body: { dataset: { noteId: '138', title: '我的股票随想' } }
    },
    fetch: async () => ({ ok: true, json: async () => ({ backlinks: [] }) })
  };
  const vmContext = {
    window,
    WeakMap, Map, URL, URLSearchParams, Date,
    setTimeout: (fn) => fn()
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../static/page-references.js'), 'utf8'), vmContext);
  const pagesMod = vmContext.window.NotepadPages;

  // Case 1: getTitle provided
  pagesMod.mount({
    getID: () => 138,
    getTitle: () => '我的股票随想',
    ready: async () => {},
    copy: async (text) => { copiedText = text; return true; },
    notify: () => {},
    isEnabled: () => true
  });
  await listeners.click();
  assert.equal(copiedText, '[[page:138:我的股票随想]]');

  // Case 2: getTitle returns empty, but body.dataset.title exists
  copiedText = '';
  pagesMod.mount({
    getID: () => 138,
    ready: async () => {},
    copy: async (text) => { copiedText = text; return true; },
    notify: () => {},
    isEnabled: () => true
  });
  await listeners.click();
  assert.equal(copiedText, '[[page:138:我的股票随想]]');
});
