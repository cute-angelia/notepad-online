(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NotepadMedia = api;
})(typeof window === 'undefined' ? this : window, function () {
  'use strict';
  var imageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'];
  var videoTypes = ['video/mp4', 'video/webm', 'video/quicktime'];
  var imageLimit = 20 * 1024 * 1024, videoLimit = 5 * 1024 * 1024 * 1024;

  function extractURLs(source, parser) {
    var urls = new Set();
    parser.walkTokens(parser.lexer(source || ''), function (token) {
      if ((token.type === 'image' || token.type === 'link') && token.href) urls.add(token.href);
    });
    return urls;
  }
  function unreferencedAssets(assets, source, parser) {
    source = source || '';
    var urls = extractURLs(source, parser);
    function decoded(value) {
      return value.replace(/&(?:amp|#0*38|#x0*26);/gi, '&').replace(/(?:%[0-9a-f]{2})+/gi, function (encoded) {
        try { return decodeURIComponent(encoded); } catch (_) { return encoded; }
      });
    }
    var plainSource = decoded(source + '\n' + Array.from(urls).join('\n'));
    // A literal URL also protects a file while its Markdown syntax is incomplete.
    return assets.filter(function (asset) {
      if (asset.retained || urls.has(asset.url) || source.indexOf(asset.url) !== -1 || plainSource.indexOf(decoded(asset.url)) !== -1) return false;
      // Server-generated filenames are unique; protect aliases without relying on host spelling.
      try {
        var filename = decoded(new URL(asset.url).pathname.split('/').pop());
        if (filename && plainSource.indexOf(filename) !== -1) return false;
      } catch (_) { return false; }
      return true;
    });
  }
  function validateFile(file, limits) {
    limits = limits || {};
    if (!file.size) throw new Error('不能上传空文件');
    if (imageTypes.indexOf(file.type) !== -1) {
      if (file.size > (limits.image || imageLimit)) throw new Error('图片不能超过 ' + Math.round((limits.image || imageLimit) / 1024 / 1024) + ' MB');
      return 'image';
    }
    if (videoTypes.indexOf(file.type) !== -1) {
      if (file.size > (limits.video || videoLimit)) throw new Error('视频不能超过 ' + ((limits.video || videoLimit) / 1024 / 1024 / 1024) + ' GB');
      return 'video';
    }
    throw new Error('不支持的文件格式，请选择 JPG、PNG、GIF、WebP、AVIF 或 MP4、WebM、MOV');
  }
  function insertion(asset) {
    var label = (asset.name || '附件').replace(/[\\\[\]]/g, '\\$&').replace(/[\r\n]/g, ' ');
    var url = asset.url.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
    return '\n' + (asset.type.indexOf('image/') === 0 ? '!' : '') + '[' + label + '](' + url + (asset.type.indexOf('video/') === 0 ? ' "video"' : '') + ')\n';
  }
  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; });
  }
  function videoHTML(href, title, text) {
    if (title !== 'video') return null;
    try { if (!/^https?:$/.test(new URL(href, 'https://notepad.invalid').protocol)) return null; } catch (_) { return null; }
    return '<video controls preload="metadata" src="' + escapeHTML(href) + '" aria-label="' + escapeHTML(text) + '">浏览器不支持视频播放</video>';
  }
  function checkAbort(signal) {
    if (signal && signal.aborted) { var error = new Error('上传已取消'); error.name = 'AbortError'; throw error; }
  }
  async function uploadFile(file, options) {
    validateFile(file, options.limits);
    var request = options.request, signal = options.signal, started, complete = false;
    try {
      checkAbort(signal);
      // Finish initialization even if cancelled, so its new upload ID can be aborted.
      started = await request('', {method:'POST', body:JSON.stringify({name:file.name, type:file.type, size:file.size}), headers:{'Content-Type':'application/json'}});
      checkAbort(signal);
      var partSize = started.partSize;
      if (!Number.isSafeInteger(partSize) || partSize < 5 * 1024 * 1024 || partSize > 64 * 1024 * 1024) throw new Error('服务返回了无效的分片大小');
      var parts = [];
      for (var start = 0, number = 1; start < file.size; start += partSize, number++) {
        checkAbort(signal);
        var end = Math.min(file.size, start + partSize), chunk = file.slice(start, end), result;
        for (var attempt = 0; attempt < 3; attempt++) {
          try {
            result = await request('/' + started.id + '/parts/' + number, {method:'PUT', body:chunk, headers:{'Content-Type':'application/octet-stream'}, signal:signal});
            break;
          } catch (error) {
            checkAbort(signal);
            if (error.name === 'AbortError' || attempt === 2 || (error.status && error.status < 500 && error.status !== 429)) throw error;
            await (options.retryDelay ? options.retryDelay(attempt) : new Promise(function (resolve) { setTimeout(resolve, 500 * (attempt + 1)); }));
          }
        }
        parts.push({number:number, etag:result.etag});
        if (options.onProgress) options.onProgress(end / file.size);
      }
      checkAbort(signal);
      // As with start, settle completion before cleaning up cancellation races.
      result = await request('/' + started.id + '/complete', {method:'POST', body:JSON.stringify({parts:parts}), headers:{'Content-Type':'application/json'}});
      checkAbort(signal);
      complete = true;
      return result;
    } catch (error) {
      if (started && !complete) {
        try { await request('/' + started.id, {method:'DELETE'}); }
        catch (_) { error.message += '；未完成上传清理失败，请稍后重试'; error.cleanupID = started.id; }
      }
      throw error;
    }
  }

  function mount(options) {
    var textarea = options.textarea, host = options.editorHost || textarea.parentNode;
    var notify = options.notify || function () {}, assets = [];
    var disabled = false, limits, deleting = new Set(), mountSource = textarea.value;
    var loaded = false, loading = null;
    var entryReviewed = !!(options.isNew && options.isNew()), reviewBusy = false, pendingReview = [], reviewSource = '';
    var panel = document.createElement('section');
    panel.className = 'media-transfers'; panel.setAttribute('aria-label', '附件上传与删除'); panel.hidden = true;
    var workspace = document.querySelector('.editor-workspace');
    (workspace || host.parentNode).appendChild(panel);
    var input = document.createElement('input');
    input.type = 'file'; input.multiple = true; input.hidden = true;
    host.appendChild(input);

    async function request(path, init) {
      var config = Object.assign({}, init || {});
      config.headers = Object.assign({'X-Notepad-Request':'1'}, config.headers);
      config.credentials = 'same-origin'; config.cache = 'no-store';
      var response = await fetch('/' + encodeURIComponent(options.getSlug()) + '/attachments' + path, config);
      var data;
      try { data = await response.json(); } catch (_) { data = {}; }
      if (!response.ok) { var error = new Error(data.error || '附件服务暂不可用'); error.status = response.status; throw error; }
      return data;
    }
    function row(name) {
      panel.hidden = false;
      var item = document.createElement('div'); item.className = 'media-transfer';
      var label = document.createElement('span'); label.className = 'media-name'; label.textContent = name;
      var state = document.createElement('span'); state.className = 'media-state'; state.setAttribute('role', 'status');
      var progress = document.createElement('progress'); progress.max = 1; progress.value = 0;
      var action = document.createElement('button'); action.type = 'button'; action.className = 'text-button';
      item.append(label, progress, state, action); panel.appendChild(item);
      return {item:item,state:state,progress:progress,action:action};
    }
    async function deleteAsset(asset, feedback) {
      if (deleting.has(asset.id)) return;
      deleting.add(asset.id);
      try {
        await request('/' + asset.id, {method:'DELETE'});
        assets = assets.filter(function (a) { return a.id !== asset.id; });
        if (feedback) feedback.item.remove();
      } catch (error) {
        var view = feedback || row(asset.name || '附件');
        view.item.dataset.state = 'error'; view.progress.hidden = true; view.state.textContent = '删除失败：' + error.message;
        view.action.textContent = '重试删除'; view.action.onclick = function () { deleteAsset(asset, view); };
        notify('附件删除失败，请在附件栏重试');
      } finally { deleting.delete(asset.id); }
    }
    function reviewOnEntry(result) {
      if (entryReviewed) return;
      entryReviewed = true;
      if (!options.isEnabled() || typeof result.source !== 'string') return;
      var dialog = document.getElementById('unused-attachments-dialog');
      if (!dialog || typeof dialog.showModal !== 'function') return;
      reviewSource = result.source;
      pendingReview = unreferencedAssets(assets, mountSource, window.marked);
      pendingReview = unreferencedAssets(pendingReview, reviewSource, window.marked);
      pendingReview = unreferencedAssets(pendingReview, textarea.value, window.marked);
      if (!pendingReview.length) return;
      var summary = document.getElementById('unused-attachments-summary');
      var list = document.getElementById('unused-attachments-list');
      var errorView = document.getElementById('unused-attachments-error');
      var keep = document.getElementById('unused-attachments-keep');
      var remove = document.getElementById('unused-attachments-delete');
      var close = document.getElementById('unused-attachments-close');
      function renderReview() {
        summary.textContent = '有 ' + pendingReview.length + ' 个附件未引用，是否保留？';
        list.replaceChildren();
        pendingReview.forEach(function (asset) {
          var item = document.createElement('li'); item.textContent = asset.name || '附件'; list.appendChild(item);
        });
      }
      async function decide(action) {
        if (reviewBusy) return;
        if (!options.isEnabled()) { errorView.textContent = '当前无法编辑，请重新进入编辑页后处理附件'; return; }
        reviewBusy = true;
        keep.disabled = remove.disabled = close.disabled = true;
        dialog.setAttribute('aria-busy', 'true');
        errorView.textContent = '';
        var targets = pendingReview.slice();
        try {
          for (var i = 0; i < targets.length; i++) {
            var asset = targets[i];
            // Recheck after each asynchronous request, not just when the dialog opened.
            if (!unreferencedAssets([asset], textarea.value, window.marked).length) {
              pendingReview = pendingReview.filter(function (a) { return a.id !== asset.id; });
              continue;
            }
            try {
              await request('/' + asset.id + '/review', {method:'POST',
                body:JSON.stringify({action:action,source:reviewSource}), headers:{'Content-Type':'application/json'}});
              if (action === 'keep') asset.retained = true;
            } catch (error) {
              if (error.status !== 404) throw error;
            }
            if (action === 'delete' || !asset.retained) assets = assets.filter(function (a) { return a.id !== asset.id; });
            pendingReview = pendingReview.filter(function (a) { return a.id !== asset.id; });
          }
          dialog.close();
        } catch (error) {
          renderReview();
          errorView.textContent = '处理失败：' + error.message;
        } finally {
          reviewBusy = false;
          keep.disabled = remove.disabled = close.disabled = false;
          dialog.setAttribute('aria-busy', 'false');
        }
      }
      keep.addEventListener('click', function () { return decide('keep'); });
      remove.addEventListener('click', function () { return decide('delete'); });
      close.addEventListener('click', function () { if (!reviewBusy) dialog.close(); });
      dialog.addEventListener('cancel', function (event) { if (reviewBusy) event.preventDefault(); });
      renderReview();
      dialog.showModal();
      keep.focus();
    }
    async function loadAssets(force) {
      if (loading) return loading;
      if ((loaded && !force) || (options.isNew && options.isNew())) return;
      loading = (async function () {
        try {
          var result = await request('', {method:'GET'});
          assets = result.attachments || []; limits = result.limits;
          loaded = true; disabled = false;
          reviewOnEntry(result);
        } catch (error) {
          if (error.status === 503) { disabled = true; return; }
          throw error;
        }
      })();
      try { return await loading; } finally { loading = null; }
    }
    var initialization = loadAssets(false);
    initialization.catch(function (error) { notify('附件列表加载失败：' + error.message); });
    var queue = Promise.resolve();
    function enqueue(files) {
      Array.from(files).forEach(function (file) {
        try { validateFile(file, {image:Number.MAX_SAFE_INTEGER,video:Number.MAX_SAFE_INTEGER}); } catch (error) { notify(error.message); return; }
        var view = row(file.name), controller = new AbortController();
        var insertAt = options.captureInsertion ? options.captureInsertion() : options.insert;
        view.state.textContent = '等待上传'; view.action.textContent = '取消';
        view.action.onclick = function () { controller.abort(); view.state.textContent = '正在取消'; };
        async function run() {
          try {
            checkAbort(controller.signal);
            await options.ready();
            await loadAssets(false);
            if (disabled) throw new Error('尚未配置 MinIO，暂不能上传');
            if (!options.isEnabled()) throw new Error('请在可编辑的 Markdown 文档中上传');
            var result = await uploadFile(file, {request:request, signal:controller.signal, limits:limits,
              onProgress:function (value) { view.progress.value = value; view.state.textContent = Math.floor(value * 100) + '%'; }});
            assets.push(result);
            insertAt(insertion(result));
            view.progress.value = 1; view.state.textContent = '上传完成';
            view.action.textContent = '关闭'; view.action.onclick = function () { view.item.remove(); };
          } catch (error) {
            if (insertAt.clear) insertAt.clear();
            view.item.dataset.state = 'error'; view.progress.hidden = true;
            view.state.textContent = error.name === 'AbortError' ? '已取消' : error.message;
            view.action.textContent = error.cleanupID ? '清理残留' : (error.name === 'AbortError' ? '关闭' : '重新上传');
            view.action.onclick = function () {
              if (error.cleanupID) { deleteAsset({id:error.cleanupID,name:file.name},view); return; }
              view.item.remove(); if (error.name !== 'AbortError') enqueue([file]);
            };
          }
        }
        queue = queue.then(run, run);
      });
      return queue;
    }
    document.querySelectorAll('[data-upload]').forEach(function (button) {
      button.addEventListener('mousedown', function (event) { event.preventDefault(); });
      button.addEventListener('click', function () {
        if (!options.isEnabled()) return;
        input.accept = button.dataset.upload === 'video' ? videoTypes.join(',') : imageTypes.join(',');
        input.click();
      });
    });
    input.addEventListener('change', function () { enqueue(input.files); input.value = ''; });
    host.addEventListener('paste', function (event) {
      if (!options.isEnabled() || !event.clipboardData || !event.clipboardData.files.length) return;
      event.preventDefault(); event.stopPropagation(); enqueue(event.clipboardData.files);
    }, true);
    host.addEventListener('dragover', function (event) {
      if (options.isEnabled() && event.dataTransfer && Array.from(event.dataTransfer.types).indexOf('Files') !== -1) event.preventDefault();
    });
    host.addEventListener('drop', function (event) {
      if (!options.isEnabled() || !event.dataTransfer || !event.dataTransfer.files.length) return;
      event.preventDefault(); event.stopPropagation(); enqueue(event.dataTransfer.files);
    }, true);
    return {upload:enqueue, ready:initialization, reload:function () { return loadAssets(true); }};
  }
  return {extractURLs:extractURLs, unreferencedAssets:unreferencedAssets, validateFile:validateFile, insertion:insertion, videoHTML:videoHTML, uploadFile:uploadFile, mount:mount};
});
