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

test('unused candidates exclude retained attachments and real references', () => {
  const assets = [{ id: 'a', url: 'https://media.example/a.jpg' }, { id: 'b', url: 'https://media.example/b.jpg', retained: true }];
  assert.equal(typeof media.unreferencedAssets, 'function');
  assert.deepEqual(media.unreferencedAssets(assets, '', marked).map(a => a.id), ['a']);
  assert.deepEqual(media.unreferencedAssets(assets, `![a](${assets[0].url})`, marked), []);
});

test('literal and escaped attachment URLs protect files even beside unrelated percent text',()=>{
  assert.equal(typeof media.unreferencedAssets,'function');
  for(const [url,source] of [
    ['https://media.example/a.jpg','`https://media.example/a.jpg`'],
    ['https://media.example/a(b).jpg','50% done\n\n![a](https://media.example/a%28b%29.jpg)'],
    ['https://media.example/a.jpg?x=1&y=2','![a](https://media.example/a.jpg?x=1&amp;y=2)'],
  ])assert.deepEqual(media.unreferencedAssets([{id:'a',url}],source,marked),[]);
});

test('equivalent hosts, ports and relative paths cannot turn a referenced file into a cleanup candidate',()=>{
  const asset={id:'random',url:'https://cdn.example/media/notes/random-file.png'};
  for(const href of ['//cdn.example/media/notes/random-file.png','https://CDN.EXAMPLE/media/notes/random-file.png',
    'https://cdn.example:443/media/notes/random-file.png','/media/notes/random-file.png','../media/notes/random-file.png',
    'https://CDN.EXAMPLE/media/notes/random-file\\.png','//cdn.example/media/notes/random\\-file.png']) {
    assert.deepEqual(media.unreferencedAssets([asset],`![image](${href})`,marked),[],href);
  }
});

test('unused attachment choices share the existing outline button style',()=>{
  const template=fs.readFileSync(require.resolve('../templates/index.html'),'utf8');
  for(const id of ['unused-attachments-keep','unused-attachments-delete']) {
    assert.match(template,new RegExp(`id="${id}" class="button button-outline"`));
  }
  const css=fs.readFileSync(require.resolve('../static/media.css'),'utf8');
  assert.doesNotMatch(css,/#unused-attachments-delete/);
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
    constructor() { this.listeners={}; this.dataset={}; this.children=[]; this.value=''; this.open=false; }
    addEventListener(type, listener) {this.listeners[type]=listener;}
    setAttribute() {}
    append(...children) {this.children.push(...children);}
    appendChild(child) {this.children.push(child);}
    replaceChildren(...children) {this.children=children;}
    showModal() {this.open=true;this.shown=(this.shown||0)+1;}
    close() {this.open=false;}
    focus() {}
    remove() {this.removed=true;}
  }
  const host=new Element(), workspace=new Element(), textarea=new Element();
  const elements=new Map();
  const element=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  textarea.value=source; textarea.parentNode=host;
  const context={module:{exports:{}},Set,URL,AbortController,Promise,Number,setTimeout,
    window:{marked},document:{createElement:()=>new Element(),getElementById:element,querySelector:()=>workspace,querySelectorAll:()=>[]},
    fetch:fetcher,
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../static/media.js'),'utf8'),context);
  const mounted=context.module.exports.mount(Object.assign({textarea,editorHost:host,getSlug:()=> 'note',ready:async()=>{},isEnabled:()=>true,insert(){}},options));
  return {mounted,textarea,workspace,element,input(){if(textarea.listeners.input)textarea.listeners.input();}};
}

test('cutting, pasting and undoing never delete attachments or prompt in the current edit session', async () => {
  const calls=[], url='https://media.example/a.jpg';
  const h=mountHarness(`![a](${url})`,async(path,init)=>{
    calls.push([path,init.method]);
    return {ok:true,json:async()=>({attachments:[{id:'a',name:'a.jpg',url}]})};
  });
  await h.mounted.ready;
  h.textarea.value=''; h.input();
  h.textarea.value=`Some text\n\n![a](${url})`; h.input();
  h.textarea.value=''; h.input();
  await h.mounted.reload();
  assert.equal(calls.some(call=>call[1]==='DELETE'),false);
  assert.equal(h.element('unused-attachments-dialog').open,false);
});

const unusedAsset={id:'a',name:'photo.png',type:'image/png',url:'https://media.example/a.png',retained:false};
function reviewHarness({source='',assets=[unusedAsset],failAction=false,isEnabled=()=>true}={}) {
  assets=assets.map(asset=>({...asset}));
  const calls=[];
  const h=mountHarness(source,async(path,init)=>{
    calls.push([path,init.method,init.body ? JSON.parse(init.body) : null]);
    if(init.method==='GET')return {ok:true,json:async()=>({attachments:assets,source})};
    if(failAction)return {ok:false,status:502,json:async()=>({error:'storage unavailable'})};
    return {ok:true,json:async()=>({status:'ok'})};
  },{isEnabled});
  return {...h,calls};
}

test('next editor entry prompts once for only unreferenced, unretained attachments',async()=>{
  const referenced={...unusedAsset,id:'used',url:'https://media.example/used.png'};
  const retained={...unusedAsset,id:'kept',retained:true};
  const h=reviewHarness({source:`![used](${referenced.url})`,assets:[unusedAsset,referenced,retained]});
  await h.mounted.ready;
  assert.equal(h.element('unused-attachments-dialog').open,true);
  assert.match(h.element('unused-attachments-summary').textContent,/1/);
  assert.deepEqual(h.element('unused-attachments-list').children.map(row=>row.textContent),['photo.png']);
  assert.equal(h.calls.length,1);
});

test('keeping unused files persists the per-file choice and closes the prompt',async()=>{
  const h=reviewHarness();
  await h.mounted.ready;
  assert.equal(typeof h.element('unused-attachments-keep').listeners.click,'function');
  await h.element('unused-attachments-keep').listeners.click();
  assert.equal(h.element('unused-attachments-dialog').open,false);
  assert.deepEqual(h.calls[1],['/note/attachments/a/review','POST',{action:'keep',source:''}]);
  const next=reviewHarness({assets:[{...unusedAsset,retained:true}]});
  await next.mounted.ready;
  assert.equal(next.element('unused-attachments-dialog').open,false);
});

test('new unretained unused files still prompt when old files were kept',async()=>{
  const h=reviewHarness({assets:[{...unusedAsset,retained:true},{...unusedAsset,id:'new',name:'new.png'}]});
  await h.mounted.ready;
  assert.equal(h.element('unused-attachments-dialog').open,true);
  assert.deepEqual(h.element('unused-attachments-list').children.map(row=>row.textContent),['new.png']);
});

test('deletion is explicit and sends the saved-source snapshot instead of deleting on input',async()=>{
  const h=reviewHarness({source:'saved text'});
  await h.mounted.ready;
  assert.equal(typeof h.element('unused-attachments-delete').listeners.click,'function');
  await h.element('unused-attachments-delete').listeners.click();
  assert.deepEqual(h.calls[1],['/note/attachments/a/review','POST',{action:'delete',source:'saved text'}]);
  assert.equal(h.element('unused-attachments-dialog').open,false);
});

test('a reference restored before deletion is never sent for deletion',async()=>{
  const h=reviewHarness(); await h.mounted.ready;
  h.textarea.value=`![back](${unusedAsset.url})`;h.input();
  assert.equal(typeof h.element('unused-attachments-delete').listeners.click,'function');
  await h.element('unused-attachments-delete').listeners.click();
  assert.equal(h.calls.length,1);
  assert.equal(h.element('unused-attachments-dialog').open,false);
});

test('failed keep or delete keeps the prompt open with a retryable error',async()=>{
  for(const action of ['keep','delete']) {
    const h=reviewHarness({failAction:true});await h.mounted.ready;
    assert.equal(typeof h.element('unused-attachments-'+action).listeners.click,'function');
    await h.element('unused-attachments-'+action).listeners.click();
    assert.equal(h.element('unused-attachments-dialog').open,true);
    assert.match(h.element('unused-attachments-error').textContent,/storage unavailable/);
    assert.equal(h.element('unused-attachments-'+action).disabled,false);
  }
});

test('dismissing the entry prompt does not record retention or reopen during reload',async()=>{
  const h=reviewHarness();await h.mounted.ready;
  assert.equal(typeof h.element('unused-attachments-close').listeners.click,'function');
  h.element('unused-attachments-close').listeners.click();
  await h.mounted.reload();
  assert.equal(h.element('unused-attachments-dialog').open,false);
  assert.equal(h.calls.length,2);
  assert.equal(h.element('unused-attachments-dialog').shown,1);
});

test('editing before attachment list response cannot turn a cut into an entry-time candidate',async()=>{
  let respond;
  const list=new Promise(resolve=>{respond=resolve;});
  const source=`![image](${unusedAsset.url})`;
  const h=mountHarness(source,async()=>({ok:true,json:()=>list}));
  h.textarea.value=''; h.input();
  respond({attachments:[unusedAsset],source});await h.mounted.ready;
  assert.equal(h.element('unused-attachments-dialog').open,false);
});

test('latest saved references and current unsaved references both protect files during entry review',async()=>{
  for(const referencedIn of ['server','editor']) {
    let respond;const list=new Promise(resolve=>{respond=resolve;});
    const h=mountHarness('',async()=>({ok:true,json:()=>list}));
    const source=`![image](${unusedAsset.url})`;
    if(referencedIn==='editor')h.textarea.value=source;
    respond({attachments:[unusedAsset],source:referencedIn==='server'?source:''});
    await h.mounted.ready;
    assert.equal(h.element('unused-attachments-dialog').open,false);
  }
});

test('disabled editor never shows an unused-attachment prompt',async()=>{
  const h=reviewHarness({isEnabled:()=>false});await h.mounted.ready;
  assert.equal(h.element('unused-attachments-dialog').open,false);
});

test('partial review failure retries only the remaining attachments',async()=>{
  const calls=[];let fail=true;
  const h=mountHarness('',async(path,init)=>{
    if(init.method==='GET')return {ok:true,json:async()=>({attachments:[{...unusedAsset},{...unusedAsset,id:'b',name:'second.png'}],source:''})};
    calls.push(path);
    if(path.includes('/b/')&&fail)return {ok:false,status:502,json:async()=>({error:'offline'})};
    return {ok:true,json:async()=>({})};
  });
  await h.mounted.ready;
  assert.equal(typeof h.element('unused-attachments-delete').listeners.click,'function');
  await h.element('unused-attachments-delete').listeners.click();
  assert.equal(h.element('unused-attachments-dialog').open,true);
  assert.deepEqual(h.element('unused-attachments-list').children.map(row=>row.textContent),['second.png']);
  fail=false;
  await h.element('unused-attachments-delete').listeners.click();
  assert.deepEqual(calls,['/note/attachments/a/review','/note/attachments/b/review','/note/attachments/b/review']);
  assert.equal(h.element('unused-attachments-dialog').open,false);
});

test('busy review ignores duplicate choices and blocks Escape until requests settle',async()=>{
  let complete;const pending=new Promise(resolve=>{complete=resolve;});let requests=0;
  const h=mountHarness('',async(path,init)=>{
    if(init.method==='GET')return {ok:true,json:async()=>({attachments:[{...unusedAsset}],source:''})};
    requests++;await pending;return {ok:true,json:async()=>({})};
  });
  await h.mounted.ready;
  assert.equal(typeof h.element('unused-attachments-keep').listeners.click,'function');
  const choice=h.element('unused-attachments-keep').listeners.click();
  await h.element('unused-attachments-delete').listeners.click();
  h.element('unused-attachments-close').listeners.click();
  let prevented=false;
  h.element('unused-attachments-dialog').listeners.cancel({preventDefault(){prevented=true;}});
  assert.equal(prevented,true);
  assert.equal(requests,1);
  assert.equal(h.element('unused-attachments-dialog').open,true);
  complete();await choice;
  assert.equal(h.element('unused-attachments-dialog').open,false);
});

test('references restored while the first decision is pending protect later files in the batch',async()=>{
  let complete;const pending=new Promise(resolve=>{complete=resolve;});const calls=[];
  const second={...unusedAsset,id:'b',url:'https://media.example/b.png'};
  const h=mountHarness('',async(path,init)=>{
    if(init.method==='GET')return {ok:true,json:async()=>({attachments:[{...unusedAsset},second],source:''})};
    calls.push(path);await pending;return {ok:true,json:async()=>({})};
  });
  await h.mounted.ready;
  assert.equal(typeof h.element('unused-attachments-delete').listeners.click,'function');
  const choice=h.element('unused-attachments-delete').listeners.click();
  h.textarea.value=`![back](${second.url})`;
  complete();await choice;
  assert.deepEqual(calls,['/note/attachments/a/review']);
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
