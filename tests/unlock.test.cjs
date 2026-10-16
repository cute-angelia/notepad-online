const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function page({query = '', cached, requestEdit = false, locked = false, storageUnavailable = false, status = 200} = {}) {
    const elements = new Map();
    function element(id) {
        if (!elements.has(id)) elements.set(id, {
            value: '', dataset: {}, open: false, textContent: '', listeners: {},
            addEventListener(type, fn) { this.listeners[type] = fn; },
            showModal() { this.open = true; this.shown = (this.shown || 0) + 1; },
            close() { this.open = false; }, focus() {},
        });
        return elements.get(id);
    }
    const storage = new Map(cached ? [['notepad:secret:sample', cached]] : []);
    const requests = [], destinations = [];
    const body = {dataset: {slug: 'sample', editable: 'false', new: 'false', kind: 'text', requestEdit: String(requestEdit), lockedUntil: locked ? String(Date.now() / 1000 + 3600) : '0'}};
    const context = {
        document: {body, getElementById: element, querySelector: () => null, querySelectorAll: () => []},
        window: {
            location: {search: query, assign: url => destinations.push(url)},
            localStorage: {
                getItem(key) { if (storageUnavailable) throw Error('blocked'); return storage.get(key) || null; },
                setItem(key, value) { if (storageUnavailable) throw Error('blocked'); storage.set(key, value); },
                removeItem(key) { if (storageUnavailable) throw Error('blocked'); storage.delete(key); },
            },
            matchMedia: () => ({matches: false}), documentOutline: {update() {}}, addEventListener() {},
        },
        URLSearchParams, URL, Date, setTimeout: () => 1, clearTimeout() {},
        fetch: async (url, options) => {
            requests.push({url, secret: options.body.get('secret')});
            return {ok: status === 200, status, json: async () => status === 200 ? {edit_url: '/sample/edit'} : {error: '秘钥不正确', remaining: 8, locked_until: Date.now() / 1000 + 3600}};
        },
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../static/script.js'), 'utf8'), context);
    return {element, storage, requests, destinations, respond: value => { status = value; }, click: () => element('edit-link').listeners.click({preventDefault() {}}), settle: () => new Promise(setImmediate)};
}

test('pwd is cached on reading and verified only when Edit is clicked, without a dialog', async () => {
    const p = page({query: '?pwd=23%2622%2B%E5%AF%86', cached: 'old'});
    assert.equal(p.storage.get('notepad:secret:sample'), '23&22+密');
    assert.equal(p.requests.length, 0);
    await p.click();
    assert.deepEqual(p.requests, [{url: '/sample/unlock', secret: '23&22+密'}]);
    assert.deepEqual(p.destinations, ['/sample/edit']);
    assert.equal(p.element('unlock-dialog').shown, undefined);
});

test('direct editing reuses a cached secret', async () => {
    const p = page({cached: '2322', requestEdit: true});
    await p.settle();
    assert.deepEqual(p.destinations, ['/sample/edit']);
    assert.equal(p.element('unlock-dialog').shown, undefined);
});

test('wrong cached secret falls back to manual entry and is not retried on another click', async () => {
    const p = page({query: '?pwd=wrong', status: 403});
    await p.click();
    assert.equal(p.element('unlock-dialog').open, true);
    assert.match(p.element('unlock-error').textContent, /8/);
    assert.equal(p.storage.has('notepad:secret:sample'), false);
    await p.click();
    assert.equal(p.requests.length, 1);
    p.respond(200);
    p.element('unlock-secret').value = 'correct';
    await p.element('unlock-form').listeners.submit({preventDefault() {}});
    assert.equal(p.requests[1].secret, 'correct');
    assert.equal(p.storage.get('notepad:secret:sample'), 'correct');
    assert.deepEqual(p.destinations, ['/sample/edit']);
});

test('direct edit URL verifies pwd in preference to the old cached secret', async () => {
    const p = page({query: '?pwd=2322', cached: 'old', requestEdit: true});
    await p.settle();
    assert.equal(p.requests[0].secret, '2322');
    assert.deepEqual(p.destinations, ['/sample/edit']);
    assert.equal(p.element('unlock-dialog').shown, undefined);
});

test('no cached secret still prompts on the edit route', () => {
    const p = page({query: '?pwd=', requestEdit: true});
    assert.equal(p.requests.length, 0);
    assert.equal(p.element('unlock-dialog').open, true);
});

test('URL secret works when localStorage is blocked', async () => {
    const p = page({query: '?pwd=2322', storageUnavailable: true, requestEdit: true});
    await p.settle();
    assert.deepEqual(p.destinations, ['/sample/edit']);
});

test('locked documents never attempt cached verification', async () => {
    const p = page({query: '?pwd=2322', locked: true, requestEdit: true});
    await p.click();
    assert.equal(p.requests.length, 0);
    assert.equal(p.element('unlock-dialog').open, false);
});

test('server lock response shows the lock notice without opening a dialog', async () => {
    const p = page({query: '?pwd=2322', status: 423, requestEdit: true});
    await p.settle();
    assert.equal(p.element('unlock-dialog').open, false);
    assert.match(p.element('notice').textContent, /锁定/);
});

test('rapid clicks only submit one verification', async () => {
    const p = page({query: '?pwd=2322'});
    await Promise.all([p.click(), p.click()]);
    assert.equal(p.requests.length, 1);
});
