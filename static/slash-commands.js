(function (root, factory) {
  'use strict';
  var tools = factory(typeof module === 'object' && module.exports ? require('./marked.min.js') : root.marked);
  if (typeof module === 'object' && module.exports) module.exports = tools;
  else root.NotepadSlashCommands = tools;
})(typeof window !== 'undefined' ? window : this, function (marked) {
  'use strict';

  var commands = [
    { id: 'h1', label: '一级标题', hint: 'H1', keywords: 'heading title 标题' },
    { id: 'h2', label: '二级标题', hint: 'H2', keywords: 'heading title 标题' },
    { id: 'h3', label: '三级标题', hint: 'H3', keywords: 'heading title 标题' },
    { id: 'task', label: '待办清单', hint: '[ ]', keywords: 'todo checkbox 任务' },
    { id: 'list', label: '无序列表', hint: '-', keywords: 'bullet' },
    { id: 'ordered-list', label: '有序列表', hint: '1.', keywords: 'number 数字' },
    { id: 'quote', label: '引用', hint: '>', keywords: 'blockquote' },
    { id: 'code', label: '代码块', hint: '</>', keywords: 'fence' },
    { id: 'table', label: '表格', hint: '| |', keywords: 'grid' },
    { id: 'divider', label: '分割线', hint: '---', keywords: 'horizontal rule' },
    { id: 'page-link', label: '页面链接', hint: '[[ ]]', keywords: 'note 文档 笔记' },
    { id: 'page-embed', label: '嵌入页面', hint: '![[ ]]', keywords: 'note 文档 笔记' },
    { id: 'upload-image', label: '上传图片', hint: 'IMG', keywords: 'photo picture image' },
    { id: 'upload-video', label: '上传视频', hint: 'VID', keywords: 'movie video' }
  ];
  var nextId = 0;

  function detectTrigger(source, start, end, composing) {
    if (composing || start !== end || start < 0 || start > source.length) return null;
    var lineStart = start ? source.lastIndexOf('\n', start - 1) + 1 : 0;
    var match = /^ {0,3}\/([^\s/\\]*)$/.exec(source.slice(lineStart, start));
    if (!match) return null;
    if (/^[^\s]*[/\\]/.test(source.slice(start))) return null;
    // A plain-word marker preserves block syntax and avoids projecting nested token offsets.
    var marker = 'NotepadSlashCursor', code = false;
    while (source.includes(marker)) marker += 'X';
    var tokens = marked.lexer(source.slice(0, start) + marker + source.slice(start) + '\n');
    function checkCode(token) {
      if ((token.type === 'code' || token.type === 'codespan') && token.raw.includes(marker)) code = true;
    }
    marked.walkTokens(tokens, function (token) {
      checkCode(token);
      // The bundled lexer trims list-item endings; restore one for open fenced blocks.
      if ((token.type === 'list_item' || token.type === 'blockquote') && token.text.includes(marker)) {
        marked.walkTokens(marked.lexer(token.text + '\n'), checkCode);
      }
    });
    if (code) return null;
    return { from: start - match[1].length - 1, to: start, query: match[1], source: source };
  }

  function filterCommands(query) {
    query = String(query || '').trim().toLowerCase();
    return commands.filter(function (command) {
      return (command.id + ' ' + command.label + ' ' + command.keywords).toLowerCase().includes(query);
    });
  }

  function applyCommand(options, trigger, id) {
    if (!trigger || (options.isEnabled && !options.isEnabled())) return false;
    var editor = options.editor, selected = editor.getSelection(), source = editor.getValue();
    var current = detectTrigger(source, selected.start, selected.end);
    var command = commands.find(function (item) { return item.id === id; });
    if (!command || source !== trigger.source || !current || current.from !== trigger.from || current.to !== trigger.to || current.query !== trigger.query) return false;
    var callback = id.indexOf('page-') === 0 ? options.openPage : id.indexOf('upload-') === 0 ? options.upload : null;
    if ((id.indexOf('page-') === 0 || id.indexOf('upload-') === 0) && !callback) return false;
    editor.setSelection(trigger.from, trigger.to);
    editor.replaceSelection('');
    editor.focus();
    if (id.indexOf('page-') === 0) callback(id === 'page-link' ? 'link' : 'embed');
    else if (id.indexOf('upload-') === 0) callback(id === 'upload-image' ? 'image' : 'video');
    else editor.format(id);
    return true;
  }

  function positionMenu(rect, viewport, height) {
    var margin = 8, gap = 6;
    var minX = viewport.left + margin, maxX = viewport.left + viewport.width - margin;
    var minY = viewport.top + margin, maxY = viewport.top + viewport.height - margin;
    var width = Math.min(320, Math.max(0, maxX - minX));
    var anchorTop = Math.max(minY, Math.min(maxY, rect.top));
    var anchorBottom = Math.max(minY, Math.min(maxY, rect.bottom));
    var below = Math.max(0, maxY - anchorBottom - gap), above = Math.max(0, anchorTop - minY - gap);
    var upward = below < Math.min(height, 360) && above > below;
    var maxHeight = Math.min(height, 360, upward ? above : below);
    return {
      left: Math.max(minX, Math.min(maxX - width, rect.left)), width: width,
      top: Math.max(minY, Math.min(maxY - maxHeight, upward ? anchorTop - gap - maxHeight : anchorBottom + gap)),
      maxHeight: maxHeight
    };
  }

  function mount(options) {
    var textarea = options.textarea, host = options.host || textarea, editor = options.editor;
    var doc = textarea.ownerDocument, win = doc.defaultView;
    var menu = doc.createElement('div'), title = doc.createElement('div'), list = doc.createElement('div');
    var id = 'slash-commands-' + (++nextId), activeInput = null;
    var trigger = null, matches = [], selectedIndex = 0, composing = false, applying = false, destroyed = false, dismissed = null;
    var cleanups = [];
    menu.className = 'slash-commands'; menu.hidden = true;
    title.className = 'slash-commands-title'; title.textContent = '插入内容';
    list.className = 'slash-commands-list'; list.id = id;
    list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', '插入内容');
    menu.appendChild(title); menu.appendChild(list); doc.body.appendChild(menu);

    function listen(target, name, listener, capture) {
      target.addEventListener(name, listener, capture);
      cleanups.push(function () { target.removeEventListener(name, listener, capture); });
    }
    function accessibleInput() {
      var next = host.querySelector('[contenteditable="true"]') || textarea;
      if (activeInput && next !== activeInput) {
        ['aria-controls', 'aria-expanded', 'aria-activedescendant', 'aria-autocomplete'].forEach(function (name) { activeInput.removeAttribute(name); });
      }
      activeInput = next;
      activeInput.setAttribute('aria-controls', id);
      activeInput.setAttribute('aria-autocomplete', 'list');
      activeInput.setAttribute('aria-expanded', menu.hidden ? 'false' : 'true');
      if (!menu.hidden && matches.length) activeInput.setAttribute('aria-activedescendant', id + '-' + selectedIndex);
      else activeInput.removeAttribute('aria-activedescendant');
    }
    function close() {
      menu.hidden = true; trigger = null;
      accessibleInput();
    }
    function currentTrigger() {
      if (composing || (options.isEnabled && !options.isEnabled())) return null;
      var selection = editor.getSelection();
      return detectTrigger(editor.getValue(), selection.start, selection.end);
    }
    function same(a, b) { return a && b && a.source === b.source && a.from === b.from && a.to === b.to; }
    function dismiss() {
      dismissed = trigger || currentTrigger();
      close();
    }
    function reposition() {
      if (menu.hidden) return;
      var viewport = win.visualViewport;
      var bounds = { left: viewport ? viewport.offsetLeft : 0, top: viewport ? viewport.offsetTop : 0,
        width: viewport ? viewport.width : win.innerWidth, height: viewport ? viewport.height : win.innerHeight };
      var rect = editor.getCursorRect ? editor.getCursorRect() : textarea.getBoundingClientRect();
      if (!rect) { close(); return; }
      var pos = positionMenu(rect, bounds, menu.scrollHeight || menu.getBoundingClientRect().height || 360);
      menu.style.left = pos.left + 'px'; menu.style.top = pos.top + 'px';
      menu.style.width = pos.width + 'px'; menu.style.maxHeight = pos.maxHeight + 'px';
    }
    function render() {
      list.replaceChildren();
      matches.forEach(function (command, index) {
        var row = doc.createElement('div'), icon = doc.createElement('span'), label = doc.createElement('span');
        row.className = 'slash-commands-option'; row.id = id + '-' + index;
        row.setAttribute('role', 'option'); row.setAttribute('aria-selected', index === selectedIndex ? 'true' : 'false');
        icon.className = 'slash-commands-icon'; icon.textContent = command.hint;
        label.textContent = command.label; row.appendChild(icon); row.appendChild(label);
        row.addEventListener('click', function () { choose(command.id); });
        list.appendChild(row);
      });
      if (!matches.length) {
        var empty = doc.createElement('div');
        empty.className = 'slash-commands-empty'; empty.textContent = '没有匹配的指令';
        empty.setAttribute('role', 'status'); list.appendChild(empty);
      }
      accessibleInput(); reposition();
    }
    function refresh() {
      if (destroyed || applying) return;
      var next = currentTrigger();
      if (!next || same(next, dismissed)) { if (!next) dismissed = null; close(); return; }
      if (!menu.hidden && same(trigger, next)) { accessibleInput(); reposition(); return; }
      if (!same(trigger, next)) selectedIndex = 0;
      trigger = next; matches = filterCommands(next.query); menu.hidden = false;
      render();
    }
    function choose(command) {
      if (destroyed || composing || !trigger || menu.hidden || !matches.some(function (item) { return item.id === command; })) return false;
      var previous = trigger, result;
      applying = true;
      close();
      try { result = applyCommand(options, previous, command); }
      finally { applying = false; }
      dismissed = currentTrigger();
      return result;
    }
    function keydown(event) {
      if (composing || event.isComposing || event.keyCode === 229 || menu.hidden) return;
      if (!same(trigger, currentTrigger())) { close(); return; }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); return; }
      if (!matches.length || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); event.stopPropagation();
        selectedIndex = (selectedIndex + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
        render();
        var row = list.children[selectedIndex];
        if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
      } else if (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) {
        event.preventDefault(); event.stopPropagation(); choose(matches[selectedIndex].id);
      }
    }
    listen(textarea, 'input', refresh);
    listen(textarea, 'select', refresh);
    listen(host, 'keyup', refresh);
    listen(host, 'pointerup', refresh);
    listen(host, 'keydown', keydown, true);
    listen(host, 'compositionstart', function () { composing = true; close(); }, true);
    listen(host, 'compositionend', function () { composing = false; refresh(); }, true);
    // Preserve the editor selection for pointer/touch clicks without blocking menu scrolling.
    listen(menu, 'mousedown', function (event) { event.preventDefault(); });
    listen(doc, 'pointerdown', function (event) {
      if (!menu.hidden && !menu.contains(event.target) && !host.contains(event.target)) dismiss();
    }, true);
    listen(doc, 'focusin', function (event) {
      if (!menu.hidden && !menu.contains(event.target) && !host.contains(event.target)) dismiss();
    });
    listen(win, 'resize', reposition);
    listen(doc, 'scroll', reposition, true);
    if (win.visualViewport) {
      listen(win.visualViewport, 'resize', reposition);
      listen(win.visualViewport, 'scroll', reposition);
    }
    accessibleInput();
    return {
      refresh: refresh, dismiss: dismiss, choose: choose,
      isOpen: function () { return !menu.hidden; },
      destroy: function () {
        if (destroyed) return;
        destroyed = true; close();
        cleanups.forEach(function (cleanup) { cleanup(); }); menu.remove();
        ['aria-controls', 'aria-expanded', 'aria-activedescendant', 'aria-autocomplete'].forEach(function (name) { activeInput.removeAttribute(name); });
      }
    };
  }

  return { mount: mount, detectTrigger: detectTrigger, filterCommands: filterCommands, applyCommand: applyCommand, positionMenu: positionMenu };
});
