const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function createCodePage({ kind = 'code', rawText = '', withHljs = true } = {}) {
    const elements = new Map();
    function element(id) {
        if (!elements.has(id)) {
            elements.set(id, {
                id,
                value: id === 'raw-content' ? rawText : '',
                textContent: '',
                innerHTML: '',
                className: '',
                dataset: {},
                classList: {
                    classes: new Set(),
                    add(c) { this.classes.add(c); },
                    remove(c) { this.classes.delete(c); },
                    contains(c) { return this.classes.has(c); },
                },
                style: {},
                listeners: {},
                querySelector: () => ({ textContent: '' }),
                addEventListener(type, fn) { this.listeners[type] = fn; },
            });
        }
        return elements.get(id);
    }

    const hljs = withHljs ? require('../static/highlight.min.js') : undefined;
    let copiedValue = null;

    const body = {
        appendChild() {},
        dataset: {
            slug: 'code-sample',
            editable: 'false',
            new: 'false',
            kind: kind,
            requestEdit: 'false',
            lockedUntil: '0',
        },
    };

    const navigator = {
        clipboard: {
            writeText: async (val) => { copiedValue = val; return true; },
        },
    };

    const context = {
        document: {
            body,
            getElementById: element,
            createElement: () => ({
                classList: { add() {}, remove() {} },
                style: {},
            }),
            querySelector: () => null,
            querySelectorAll: () => [],
        },
        window: {
            isSecureContext: true,
            location: { search: '', origin: 'http://localhost:8080' },
            localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
            matchMedia: () => ({ matches: false }),
            documentOutline: { update() {} },
            addEventListener() {},
            hljs: hljs,
            navigator,
        },
        navigator,
        URLSearchParams,
        URL,
        Date,
        setTimeout: (fn) => fn(),
        clearTimeout() {},
        fetch: async () => ({ ok: true, json: async () => ({}) }),
    };

    // Pre-populate raw content element
    element('raw-content');

    vm.runInNewContext(fs.readFileSync(require.resolve('../static/script.js'), 'utf8'), context);
    return { element, getCopiedValue: () => copiedValue };
}

test('code viewer automatically highlights Go code and escapes HTML', () => {
    const rawGo = 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("<div>hello</div>")\n}';
    const { element } = createCodePage({ rawText: rawGo });

    const codeContent = element('read-code-content');
    const gutter = element('read-code-gutter');
    const linesCount = element('code-lines-count');

    assert.equal(linesCount.textContent, '共 7 行');
    assert.equal(gutter.textContent, '1\n2\n3\n4\n5\n6\n7');
    assert.ok(codeContent.classList.contains('hljs'), 'code element should have hljs class');
    assert.match(codeContent.innerHTML, /class="hljs-keyword"/, 'should highlight keywords');
    assert.match(codeContent.innerHTML, /&lt;div&gt;hello&lt;\/div&gt;/, 'should safely escape HTML entities');
});

test('code viewer falls back gracefully when window.hljs is absent', () => {
    const rawPy = 'def hello():\n    return 42';
    const { element } = createCodePage({ rawText: rawPy, withHljs: false });

    const codeContent = element('read-code-content');
    const linesCount = element('code-lines-count');

    assert.equal(linesCount.textContent, '共 2 行');
    assert.equal(codeContent.innerHTML, '', 'innerHTML should remain unhighlighted without crashing');
});

test('code viewer copy button copies original raw text, not highlighted HTML', async () => {
    const rawCode = 'const greeting = "Hello World";';
    const { element, getCopiedValue } = createCodePage({ rawText: rawCode });

    const copyBtn = element('code-copy-button');
    assert.ok(typeof copyBtn.listeners.click === 'function', 'copy button should have click listener');
    await copyBtn.listeners.click();

    assert.equal(getCopiedValue(), rawCode, 'should copy exact raw code without syntax spans');
});
