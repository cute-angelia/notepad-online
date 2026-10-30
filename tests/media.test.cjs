const test = require('node:test');
const assert = require('node:assert/strict');
const marked = require('../static/marked.min.js');
const media = require('../static/media.js');
const fs = require('node:fs');
const vm = require('node:vm');

test('finds real Markdown media/link references, ignores code and plain URLs', () => {
  const url = 'https://media.example/bucket/a.jpg';
  assert.deepEqual([...media.extractURLs(`![photo](${url})\n\n[clip](https://media.example/a.mp4 "video")`, marked)], [url, 'https://media.example/a.mp4']);
  assert.deepEqual([...media.extractURLs('`![photo](' + url + ')`\n\n```md\n![photo](' + url + ')\n```', marked)], []);
  assert.deepEqual([...media.extractURLs(`- [a](${url})\n\n| image |\n| --- |\n| ![a](${url}) |`, marked)], [url]);
});

test('deletes owned attachments as soon as their last editor reference is removed', () => {
  const assets = [{ id: 'a', url: 'https://media.example/a.jpg' }, { id: 'b', url: 'https://media.example/b.jpg' }];
  assert.deepEqual(media.removedAssets(assets, new Set([assets[0].url]), new Set()).map(a => a.id), ['a']);
  assert.deepEqual(media.removedAssets(assets, new Set([assets[0].url]), new Set([assets[0].url])), []);
  assert.deepEqual(media.removedAssets(assets, new Set(['https://outside.example/x']), new Set()), []);
});

test('media limits allow a 5 GiB video and reject unsupported files and oversized images', () => {
  assert.equal(media.validateFile({name: 'clip.mp4', type: 'video/mp4', size: 5 * 1024 ** 3}), 'video');
  assert.throws(() => media.validateFile({name: 'large.mp4', type: 'video/mp4', size: 5 * 1024 ** 3 + 1}), /5/);
  assert.throws(() => media.validateFile({name: 'photo.png', type: 'image/png', size: 20 * 1024 ** 2 + 1}), /20/);
  assert.throws(() => media.validateFile({name: 'x.svg', type: 'image/svg+xml', size: 20}), /格式/);
  assert.throws(() => media.validateFile({name: 'empty.jpg', type: 'image/jpeg', size: 0}), /空/);
});

test('insertion escapes Markdown labels and uses controlled video syntax', () => {
  assert.equal(media.insertion({name: 'a[b].jpg', type: 'image/jpeg', url: 'https://media.example/a.jpg'}), '\n![a\\[b\\].jpg](https://media.example/a.jpg)\n');
  assert.equal(media.insertion({name: 'clip.mp4', type: 'video/mp4', url: 'https://media.example/a.mp4'}), '\n[clip.mp4](https://media.example/a.mp4 "video")\n');
});

test('video rendering only handles explicitly marked safe video links', () => {
  assert.match(media.videoHTML('https://media.example/a.mp4', 'video', 'clip'), /<video controls preload="metadata"/);
  assert.equal(media.videoHTML('javascript:alert(1)', 'video', 'clip'), null);
  assert.equal(media.videoHTML('https://media.example/a.mp4', '', 'clip'), null);
  assert.doesNotMatch(media.videoHTML('https://media.example/a.mp4', 'video', '<img onerror=x>'), /<img/);
});

test('uploads sequential file slices, retries a failed part and completes only once', async () => {
  const calls = [], slices = [], parts = [];
  const file = {name: 'clip.mp4', type: 'video/mp4', size: 18 * 1024 ** 2, slice(start, end) { slices.push([start,end]); return {size:end-start}; }};
  let failed = false;
  const result = await media.uploadFile(file, {
    request: async (path, options) => {
      calls.push([path, options]);
      if (!path) return {id:'owned', partSize:8*1024**2};
      if (path.endsWith('/complete')) { parts.push(...JSON.parse(options.body).parts); return {id:'owned',url:'https://media.example/a.mp4'}; }
      if (path.endsWith('/parts/2') && !failed) {failed = true; const error = new Error('network'); error.status = 503; throw error;}
      return {etag:'etag-'+path.split('/').pop()};
    },
    retryDelay: async () => {},
  });
  assert.equal(result.id,'owned');
  assert.deepEqual(slices, [[0,8388608],[8388608,16777216],[16777216,18874368]]);
  assert.equal(calls.filter(c => c[0].endsWith('/parts/2')).length,2);
  assert.deepEqual(parts,[{number:1,etag:'etag-1'},{number:2,etag:'etag-2'},{number:3,etag:'etag-3'}]);
  assert.equal(calls.filter(c => c[0].endsWith('/complete')).length,1);
});

test('cancelling aborts multipart upload with a fresh cleanup request', async () => {
  const controller = new AbortController(), calls=[];
  const file = {name:'clip.mp4',type:'video/mp4',size:100,slice(){ return {size:100}; }};
  await assert.rejects(media.uploadFile(file, {
    signal:controller.signal,
    request: async (path, options) => {
      calls.push([path,options]);
      if (!path) return {id:'owned',partSize:8388608};
      if (options.method === 'DELETE') return {};
      controller.abort();
      throw Object.assign(new Error('cancelled'),{name:'AbortError'});
    },
  }), {name:'AbortError'});
  const cleanup = calls.find(c => c[1].method === 'DELETE');
  assert.equal(cleanup[0],'/owned');
  assert.equal(cleanup[1].signal,undefined);
  assert.equal(calls.some(c => c[0].endsWith('/complete')),false);
});

test('a permanent part error is not retried and aborts the upload', async () => {
  const calls = [];
  await assert.rejects(media.uploadFile({name:'x.png',type:'image/png',size:100,slice(){return {size:100};}}, {
    request:async (path, options) => {
      calls.push([path,options.method]);
      if (!path) return {id:'a',partSize:8388608};
      if (options.method === 'DELETE') return {};
      throw Object.assign(new Error('too large'),{status:413});
    },
  }), /too large/);
  assert.deepEqual(calls,[['','POST'],['/a/parts/1','PUT'],['/a','DELETE']]);
});

test('cancellation while completing deletes the completed object immediately', async () => {
  const controller = new AbortController(), calls=[];
  await assert.rejects(media.uploadFile({name:'x.png',type:'image/png',size:100,slice(){return {size:100};}}, {
    signal:controller.signal,
    request:async (path, options) => {
      calls.push([path,options.method]);
      if (!path) return {id:'a',partSize:8388608};
      if (path.endsWith('/complete')) {controller.abort(); return {id:'a'};}
      return {etag:'etag'};
    },
  }), {name:'AbortError'});
  assert.equal(calls.at(-1)[1],'DELETE');
});

test('cancellation during initialization waits for the ID then aborts it', async () => {
  const controller=new AbortController(), calls=[];
  let initialized;
  const started=new Promise(resolve=>{initialized=resolve;});
  const pending=media.uploadFile({name:'x.png',type:'image/png',size:100,slice(){throw new Error('must not read');}}, {
    signal:controller.signal,
    request:async(path,options)=>{calls.push([path,options.method]); return !path ? started : {};},
  });
  controller.abort(); initialized({id:'a',partSize:8388608});
  await assert.rejects(pending,{name:'AbortError'});
  assert.deepEqual(calls,[['','POST'],['/a','DELETE']]);
});

function mountHarness(source, fetcher, options = {}) {
  class Element {
    constructor() { this.listeners={}; this.dataset={}; this.children=[]; this.value=''; }
    addEventListener(type, listener) {this.listeners[type]=listener;}
    setAttribute() {}
    append(...children) {this.children.push(...children);}
    appendChild(child) {this.children.push(child);}
    remove() {this.removed=true;}
  }
  const host=new Element(), workspace=new Element(), textarea=new Element();
  textarea.value=source; textarea.parentNode=host;
  const context={module:{exports:{}},Set,URL,AbortController,Promise,Number,setTimeout,
    window:{marked},document:{createElement:()=>new Element(),querySelector:()=>workspace,querySelectorAll:()=>[]},
    fetch:fetcher,
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../static/media.js'),'utf8'),context);
  const mounted=context.module.exports.mount(Object.assign({textarea,editorHost:host,getSlug:()=> 'note',ready:async()=>{},isEnabled:()=>true,insert(){}},options));
  return {mounted,textarea,workspace};
}

test('editor input immediately calls DELETE without waiting for a note save', async () => {
  const calls=[], url='https://media.example/a.jpg';
  const {mounted,textarea}=mountHarness(`![a](${url})`,async(path,init)=>{
    calls.push([path,init.method]);
    return {ok:true,json:async()=>({attachments:[{id:'a',name:'a.jpg',url}]})};
  });
  await mounted.ready;
  textarea.value=''; textarea.listeners.input();
  assert.deepEqual(calls,[['/note/attachments','GET'],['/note/attachments/a','DELETE']]);
});

test('opening an empty draft does not save it or request attachments', async () => {
  let saved=0,requests=0;
  const {mounted}=mountHarness('',async()=>{requests++; return {ok:true,json:async()=>({attachments:[]})};},{isNew:()=>true,ready:async()=>{saved++;}});
  await mounted.ready;
  assert.equal(saved,0);
  assert.equal(requests,0);
});

test('a transient attachment list error can be retried without reloading the editor', async () => {
  let calls=0;
  const {mounted}=mountHarness('',async()=>{calls++; return {ok:calls>1,status:503,json:async()=>({attachments:[]})};});
  await mounted.ready;
  await mounted.reload();
  assert.equal(calls,2);
});

test('upload uses its captured insertion point instead of the later editor selection', async () => {
  let captured=0,inserted='',wrongInsert=0;
  const asset={id:'a',name:'x.png',type:'image/png',url:'https://media.example/a.png'};
  const {mounted}=mountHarness('',async(path,init)=>({ok:true,json:async()=>{
    if (init.method==='GET') return {attachments:[]};
    if (path.endsWith('/complete')) return asset;
    if (path.endsWith('/parts/1')) return {etag:'etag'};
    return {id:'a',partSize:8388608};
  }}),{captureInsertion:()=>{captured++;return text=>{inserted=text;};},insert(){wrongInsert++;}});
  await mounted.ready;
  await mounted.upload([{name:'x.png',type:'image/png',size:100,slice(){return {size:100};}}]);
  assert.equal(captured,1);
  assert.match(inserted,/!\[x.png\]/);
  assert.equal(wrongInsert,0);
});
