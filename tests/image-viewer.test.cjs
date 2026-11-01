const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness() {
    const elements = new Map();
    const document = { body: { classList: {
        values: new Set(),
        add(value) { this.values.add(value); },
        remove(value) { this.values.delete(value); },
        contains(value) { return this.values.has(value); },
    } } };
    class Element {
        constructor() {
            this.attributes = new Map();
            this.listeners = {};
            this.style = {};
            this.hidden = false;
            this.disabled = false;
            this.isConnected = true;
            this.naturalWidth = 1600;
            this.naturalHeight = 1000;
            this.clientWidth = 848;
            this.clientHeight = 648;
            this.scrollLeft = this.scrollTop = 0;
        }
        setAttribute(name, value) { this.attributes.set(name, String(value)); }
        getAttribute(name) { return this.attributes.get(name) ?? null; }
        removeAttribute(name) { this.attributes.delete(name); }
        addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
        dispatch(type, values = {}) {
            const event = { target: this, button: 0, preventDefault() { this.prevented = true; }, ...values };
            for (const fn of this.listeners[type] || []) fn(event);
            return event;
        }
        closest(selector) { return selector === 'a' ? this.link || null : null; }
        focus(options) { document.activeElement = this; this.focusOptions = options; }
        showModal() { this.open = true; this.shown = (this.shown || 0) + 1; }
        close() { this.open = false; this.dispatch('close'); }
        get scrollWidth() { return Math.max(this.clientWidth, parseFloat(this.style.width) || 0); }
        get scrollHeight() { return Math.max(this.clientHeight, parseFloat(this.style.height) || 0); }
    }
    document.getElementById = id => {
        if (!elements.has(id)) elements.set(id, new Element());
        return elements.get(id);
    };
    const window = { location: { origin: 'http://localhost' }, listeners: {},
        addEventListener(type, fn) { this.listeners[type] = fn; } };
    const path = require('node:path').join(__dirname, '../static/image-viewer.js');
    if (fs.existsSync(path)) vm.runInNewContext(fs.readFileSync(path, 'utf8'), { window, document, URL });
    const image = new Element();
    image.setAttribute('src', '/photo.png');
    image.setAttribute('alt', 'Photo');
    const target = { querySelectorAll: () => [image] };
    return { window, document, image, target, element: document.getElementById };
}

function enhanced() {
    const h = harness();
    assert.equal(typeof h.window.NotepadImages?.enhance, 'function', 'shared image enhancement is available');
    h.window.NotepadImages.enhance(h.target);
    return h;
}

function opened() {
    const h = enhanced();
    h.image.dispatch('click');
    h.element('image-viewer-image').dispatch('load');
    return h;
}

test('plain images open the shared viewer with safe original source and accessible controls', () => {
    const h = enhanced();
    assert.equal(h.image.getAttribute('role'), 'button');
    assert.equal(h.image.getAttribute('tabindex'), '0');
    assert.equal(h.image.getAttribute('aria-haspopup'), 'dialog');
    const event = h.image.dispatch('click');
    assert.equal(event.prevented, true);
    assert.equal(h.element('image-viewer').open, true);
    assert.equal(h.element('image-viewer-image').getAttribute('src'), '/photo.png');
    assert.equal(h.element('image-viewer-image').getAttribute('alt'), 'Photo');
    assert.equal(h.element('image-viewer-caption').textContent, 'Photo');
    assert.equal(h.document.body.classList.contains('image-viewer-open'), true);
});

test('Enter and Space open images without scrolling; other keys and modified clicks do not', () => {
    for (const key of ['Enter', ' ']) {
        const h = enhanced();
        assert.equal(h.image.dispatch('keydown', { key }).prevented, true);
        assert.equal(h.element('image-viewer').open, true);
    }
    const h = enhanced();
    h.image.dispatch('keydown', { key: 'ArrowDown' });
    h.image.dispatch('click', { ctrlKey: true });
    h.image.dispatch('click', { metaKey: true });
    h.image.dispatch('click', { button: 1 });
    assert.ok(!h.element('image-viewer').open);
});

test('linked, missing-source and unsafe-source images are not interactive', () => {
    for (const source of [null, '', 'javascript:alert(1)', 'data:image/svg+xml,unsafe']) {
        const h = harness();
        if (source === null) h.image.removeAttribute('src');
        else h.image.setAttribute('src', source);
        assert.equal(typeof h.window.NotepadImages?.enhance, 'function');
        h.window.NotepadImages.enhance(h.target);
        assert.equal(h.image.getAttribute('role'), null);
    }
    const h = harness();
    h.image.link = {};
    h.window.NotepadImages.enhance(h.target);
    assert.equal(h.image.getAttribute('role'), null);
    assert.equal(h.image.listeners.click, undefined);
});

test('loaded images fit without upscaling, zoom proportionally and reset to fit', () => {
    const h = opened();
    const image = h.element('image-viewer-image');
    assert.equal(image.style.width, '800px');
    assert.equal(image.style.height, '500px');
    assert.equal(h.element('image-viewer-zoom').textContent, '50%');
    h.element('image-viewer-in').dispatch('click');
    assert.equal(image.style.width, '1000px');
    assert.equal(image.style.height, '625px');
    h.element('image-viewer-out').dispatch('click');
    assert.equal(image.style.width, '800px');
    image.dispatch('click');
    assert.equal(image.style.width, '1600px');
    h.element('image-viewer-fit').dispatch('click');
    assert.equal(image.style.width, '800px');
    image.naturalWidth = 80; image.naturalHeight = 40;
    image.dispatch('load');
    assert.equal(image.style.width, '80px');
    assert.equal(image.style.height, '40px');
});

test('closing by button, Escape or empty space clears source and restores focus', () => {
    for (const action of ['button', 'escape', 'backdrop', 'canvas', 'status']) {
        const h = opened();
        if (action === 'button') h.element('image-viewer-close').dispatch('click');
        if (action === 'escape') h.element('image-viewer').dispatch('cancel');
        if (action === 'backdrop') h.element('image-viewer').dispatch('click');
        if (action === 'canvas') h.element('image-viewer-stage').dispatch('click', { target: h.element('image-viewer-canvas') });
        if (action === 'status') h.element('image-viewer-stage').dispatch('click', { target: h.element('image-viewer-status') });
        assert.equal(h.element('image-viewer').open, false, action);
        assert.equal(h.element('image-viewer-image').getAttribute('src'), null);
        assert.equal(h.document.body.classList.contains('image-viewer-open'), false);
        assert.equal(h.document.activeElement, h.image);
        assert.equal(h.image.focusOptions.preventScroll, true);
    }
});

test('loading and failures remain readable and disable zoom until a successful load', () => {
    const h = enhanced();
    h.image.dispatch('click');
    assert.equal(h.element('image-viewer-in').disabled, true);
    assert.equal(h.element('image-viewer-canvas').hidden, true);
    assert.match(h.element('image-viewer-status').textContent, /加载/);
    h.element('image-viewer-image').dispatch('error');
    assert.match(h.element('image-viewer-status').textContent, /失败/);
    assert.equal(h.element('image-viewer-in').disabled, true);
    h.element('image-viewer-image').dispatch('load');
    assert.equal(h.element('image-viewer-status').hidden, true);
    assert.equal(h.element('image-viewer-canvas').hidden, false);
    assert.equal(h.element('image-viewer-in').disabled, false);
});

test('repeated enhancement does not duplicate listeners and reopening starts fitted', () => {
    const h = opened();
    h.element('image-viewer-in').dispatch('click');
    h.element('image-viewer-close').dispatch('click');
    h.window.NotepadImages.enhance(h.target);
    h.image.dispatch('click');
    h.element('image-viewer-image').dispatch('load');
    assert.equal(h.element('image-viewer').shown, 2);
    assert.equal(h.element('image-viewer-image').style.width, '800px');
});

test('viewport resizing refits the image when in fit mode', () => {
    const h = opened();
    h.element('image-viewer-stage').clientWidth = 448;
    h.window.listeners.resize();
    assert.equal(h.element('image-viewer-image').style.width, '400px');
    assert.equal(h.element('image-viewer-image').style.height, '250px');
});

test('shared renderer enhances only after sanitization and template loads viewer for readers too', () => {
    const render = fs.readFileSync(require.resolve('../static/render.js'), 'utf8');
    const enhanceAt = render.indexOf('window.NotepadImages.enhance(target)');
    assert.ok(enhanceAt > render.indexOf('target.replaceChildren(fragment.content)'), 'enhance sanitized DOM after insertion');
    const html = fs.readFileSync(require.resolve('../templates/index.html'), 'utf8');
    const viewerAt = html.indexOf('src="/static/image-viewer.js');
    assert.ok(viewerAt > 0 && viewerAt < html.indexOf('{{if .editable}}\n  <script'), 'viewer is not editor-only');
    assert.match(html, /<dialog id="image-viewer"[^>]*aria-label="图片预览"/);
    assert.match(html, /id="image-viewer-image"[^>]*referrerpolicy="no-referrer"/);
    assert.match(html, /id="image-viewer-stage"[^>]*tabindex="0"[^>]*role="region"[^>]*aria-label="图片滚动区域"/);
    const css = fs.readFileSync(require.resolve('../static/style.css'), 'utf8');
    const images = css.match(/\.markdown-body img\s*\{([^}]+)\}/)[1];
    assert.match(images, /max-width:\s*min\(100%,\s*640px\)/);
    assert.match(images, /max-height:\s*min\(420px,\s*60vh\)/);
    assert.match(images, /width:\s*auto/);
    assert.match(images, /height:\s*auto/);
});
