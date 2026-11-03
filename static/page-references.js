(function (root, factory) {
  'use strict';
  var pages = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = pages;
  else {
    root.NotepadPages = pages;
    root.marked.use({ extensions: [pages.extension()], tokenizer: pages.tokenizer(root.marked) });
  }
})(typeof window === 'undefined' ? null : window, function (window) {
  'use strict';
  var pattern = /^(!?)\[\[page:([1-9][0-9]{0,9})(?:[:|]([^\]\r\n]+))?\]\]/;
  var generations = new WeakMap();
  var pageCache = new Map();
  function validID(value) { return /^[1-9][0-9]*$/.test(String(value)) && Number(value) <= 2147483647; }
  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, function (char) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]; });
  }
  function sanitizeLabel(label) {
    if (!label) return '';
    return String(label).replace(/[\]\r\n]/g, '').trim();
  }
  function reference(id, embed, title) {
    if (!validID(id)) throw new Error('无效页面 ID');
    var label = sanitizeLabel(title);
    return (embed ? '!' : '') + '[[page:' + id + (label ? ':' + label : '') + ']]';
  }
  function pageURL(id) { return '/api/pages/' + id + '/view'; }
  function extension() {
    return {
      name: 'pageReference', level: 'inline',
      start: function (source) { var index = source.search(/!?\[\[page:/); return index < 0 ? undefined : index; },
      tokenizer: function (source) {
        var match = pattern.exec(source);
        if (!match || !validID(match[2])) return;
        return { type: 'pageReference', raw: match[0], id: match[2], embed: !!match[1], label: match[3] || '' };
      },
      renderer: function (token) {
        var label = escapeHTML(token.label || '加载中…');
        if (token.embed) return '<span class="page-embed" data-page-id="' + token.id + '">' + label + '</span>';
        return '<a class="page-reference" data-page-id="' + token.id + '"' + (token.label ? ' data-page-label="true"' : '') + ' href="' + pageURL(token.id) + '">' + label + '</a>';
      }
    };
  }
  function tokenizer(marked) {
    return { fences: function (source) {
      if (source.endsWith('\n')) return false;
      // The bundled marked requires a final newline for unfinished fenced blocks.
      var token = marked.Tokenizer.prototype.fences.call(this, source + '\n');
      if (!token) return false;
      token.raw = token.raw.slice(0, source.length);
      return token;
    } };
  }
  function parseTarget(input, origin) {
    var value = input.trim(), match = pattern.exec(value);
    if (match && match[0] === value && validID(match[2])) return { id: Number(match[2]) };
    if (/^[+-]?\d+$/.test(value)) {
      if (validID(value)) return { id: Number(value) };
      throw new Error('无效页面 ID');
    }
    if (!value || /[\[\]\\]/.test(value)) throw new Error('请输入页面地址、地址标识或 ID');
    // A bare address identifier is literal; ?, #, : and % are legal slug characters.
    if (!value.includes('/')) return { slug: checkedSlug(value) };
    var url = new URL(value, origin);
    if (url.origin !== origin || url.username || url.password) throw new Error('只能引用本站页面');
    match = /^\/api\/pages\/([1-9][0-9]*)\/view\/?$/.exec(url.pathname);
    if (match && validID(match[1])) return { id: Number(match[1]) };
    match = /^\/([^/]+)(?:\/(?:edit|md|raw))?\/?$/.exec(url.pathname);
    if (!match) throw new Error('不是有效的文档地址');
    return { slug: checkedSlug(decodeURIComponent(match[1])) };
  }
  function checkedSlug(slug) {
    if (!slug || ['api', 'static', 'favicon.ico', 'robots.txt', '.', '..'].includes(slug) || /[/\\\u0000-\u001f\u007f]/.test(slug) || Array.from(slug).length > 32 || slug.trim() !== slug) throw new Error('不是有效的文档地址');
    return slug;
  }
  async function request(path) {
    var response = await window.fetch(path, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) {
      var err = new Error(response.status === 403 ? '需要授权查看，请先打开目标页完成授权' : (response.status === 404 ? '页面不存在' : '页面加载失败，请稍后重试'));
      err.status = response.status;
      throw err;
    }
    return response.json();
  }
  function textElement(tag, text, className) {
    var node = window.document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function renderState() {
    var id = window.document.body.dataset.noteId;
    return { path: validID(id) ? [String(id)] : [], depth: 0, budget: { embeds: 0, reads: 0, requests: new Map() } };
  }
  function readPage(id) {
    var cached = pageCache.get(id), now = Date.now();
    if (cached && now - cached.time < 30000) return cached.promise;
    pageCache.delete(id);
    // In-memory only, bounded, and short-lived so normal typing doesn't refetch every link.
    if (pageCache.size >= 64) pageCache.delete(pageCache.keys().next().value);
    var promise = request('/api/pages/' + id);
    pageCache.set(id, { time: now, promise: promise });
    return promise;
  }
  async function enhance(target, state) {
    state = state || renderState();
    var generation = {}, budget = state.budget;
    var depth = state.depth == null ? Math.max(0, state.path.length - 1) : state.depth;
    generations.set(target, generation);
    if (target.getClientRects && !target.getClientRects().length) return;
    function current(node) { return generations.get(target) === generation && node.isConnected && target.contains(node); }
    await Promise.all(Array.from(target.querySelectorAll('[data-page-id]')).map(async function (node) {
      var id = node.getAttribute('data-page-id'), embed = node.classList.contains('page-embed');
      function message(text) { if (current(node)) { node.textContent = text; node.classList.add('page-unavailable'); } }
      if (!validID(id)) return;
      if (embed && (state.path.includes(id) || depth >= 3 || budget.embeds >= 20)) {
        message(state.path.includes(id) ? '循环引用已停止' : '已达到页面嵌入上限'); return;
      }
      if (embed) budget.embeds++;
      if (!budget.requests.has(id)) {
        if (budget.reads >= 32) { message('已达到页面加载上限'); return; }
        budget.reads++;
        budget.requests.set(id, readPage(id));
      }
      try {
        var page = await budget.requests.get(id);
        if (!current(node)) return;
        if (!embed) {
          node.textContent = page.title;
          return;
        }
        var header = textElement('a', page.title, 'page-embed-title');
        header.href = pageURL(id);
        var content = textElement('span', '', 'page-embed-content markdown-body');
        node.replaceChildren(header, content);
        if (page.document_type === 'markdown') {
          window.renderMarkdown(content, page.text, { path: state.path.concat(id), depth: depth + 1, budget: budget });
        } else {
          var pre = textElement('pre', page.document_type === 'code' ? '' : page.text);
          if (page.document_type === 'code') pre.appendChild(textElement('code', page.text));
          content.appendChild(pre);
        }
      } catch (err) {
        if (!current(node)) return;
        var status = err && err.status;
        if (status === 403) {
          node.textContent = '需要授权查看';
          node.classList.add('page-unavailable', 'page-unauthorized');
          if (!embed) {
            node.href = pageURL(id);
          }
        } else {
          node.textContent = '页面不存在';
          node.classList.add('page-unavailable', 'page-missing');
          if (!embed) {
            if (node.removeAttribute) node.removeAttribute('href');
            node.href = '';
          }
        }
      }
    }));
  }
  function mount(options) {
    var document = window.document, dialog = document.getElementById('page-reference-dialog');
    var input = document.getElementById('page-reference-target'), form = document.getElementById('page-reference-form');
    var mode = document.getElementById('page-reference-mode'), errorView = document.getElementById('page-reference-error');
    var submit = document.getElementById('page-reference-submit'), insertion = null, session = 0;
    var copy = document.getElementById('copy-page-reference'), backlinks = document.getElementById('page-backlinks');
    function cancel() { session++; if (insertion) insertion.clear(); insertion = null; }
    function open(kind) {
      if (!dialog || !options.isEnabled()) return;
      cancel();
      insertion = options.captureInsertion();
      mode.value = kind === 'embed' ? 'embed' : 'link';
      input.value = ''; errorView.textContent = ''; submit.disabled = input.disabled = mode.disabled = false;
      dialog.showModal(); input.focus();
    }
    if (dialog) {
      document.getElementById('close-page-reference').addEventListener('click', function () { dialog.close(); });
      dialog.addEventListener('close', cancel);
      dialog.addEventListener('cancel', cancel);
      var refBtn = document.getElementById('page-reference-button');
      if (refBtn) {
        refBtn.addEventListener('mousedown', function (event) { event.preventDefault(); });
        refBtn.addEventListener('click', function () { open('link'); });
      }
      form.addEventListener('submit', async function (event) {
        event.preventDefault();
        if (submit.disabled) return;
        var version = session;
        var embed = mode.value === 'embed';
        submit.disabled = input.disabled = mode.disabled = true; errorView.textContent = '';
        try {
          var target = parseTarget(input.value, window.location.origin);
          var page = await request('/api/pages/resolve?' + new URLSearchParams(target));
          if (session !== version || !dialog.open || !options.isEnabled()) return;
          if (!insertion(reference(page.id, embed, page.title) + (embed ? '\n' : ''))) throw new Error('当前无法插入引用');
          dialog.close();
          if (window.noteEditor) window.noteEditor.focus();
        } catch (error) { if (session === version) errorView.textContent = error.message; }
        finally { if (session === version) submit.disabled = input.disabled = mode.disabled = false; }
      });
    }
    if (copy) copy.addEventListener('click', async function () {
      copy.disabled = true;
      try {
        if (!options.getID()) await options.ready();
        var title = '';
        if (options.getTitle) {
          try { title = options.getTitle() || ''; } catch (_) { }
        }
        if (!title && typeof window !== 'undefined' && window.document) {
          var titleEl = window.document.getElementById('note-title');
          if (titleEl && titleEl.value && titleEl.value.trim()) {
            title = titleEl.value.trim();
          } else if (window.document.body && window.document.body.dataset && window.document.body.dataset.title) {
            title = window.document.body.dataset.title.trim();
          } else {
            var artTitle = window.document.querySelector('.article-title');
            if (artTitle) {
              var clone = artTitle.cloneNode(true);
              var editIcon = clone.querySelector('.edit-icon');
              if (editIcon) editIcon.remove();
              title = clone.textContent.trim();
            }
          }
        }
        var value = reference(options.getID(), false, title);
        if (await options.copy(value)) options.notify('页面引用已复制');
        else options.notify('复制失败，页面 ID：' + options.getID());
      } catch (error) { options.notify(error.message); }
      finally { copy.disabled = false; }
    });
    var backlinkVersion = 0;
    async function refresh() {
      if (!backlinks || !options.getID()) return;
      var version = ++backlinkVersion;
      backlinks.hidden = false;
      var list = document.getElementById('page-backlinks-list'), status = document.getElementById('page-backlinks-status');
      try {
        var result = await request('/api/pages/' + options.getID() + '/backlinks');
        if (version !== backlinkVersion) return;
        list.replaceChildren();
        result.backlinks.forEach(function (page) {
          var item = textElement('li', ''), link = textElement('a', page.title);
          link.href = pageURL(page.id); item.appendChild(link); list.appendChild(item);
        });
        status.textContent = result.backlinks.length ? result.backlinks.length + ' 个页面引用了此页' : '暂无页面引用';
      } catch (_) { if (version === backlinkVersion) status.textContent = '引用列表暂不可用'; }
    }
    refresh();
    return { open: open, refresh: refresh };
  }
  return { extension: extension, tokenizer: tokenizer, parseTarget: parseTarget, reference: reference, enhance: enhance, mount: mount };
});
