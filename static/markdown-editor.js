(function (root, factory) {
  'use strict';
  var tools = factory();
  if (typeof module === 'object' && module.exports) module.exports = tools;
  else root.NotepadMarkdownEditor = tools;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  function lineRange(source, start, end) {
    var from = source.lastIndexOf('\n', start - 1) + 1;
    if (start === 0) from = 0;
    var last = end > start && source[end - 1] === '\n' ? end - 1 : end;
    var to = source.indexOf('\n', last);
    return { from: from, to: to < 0 ? source.length : to };
  }
  function edit(from, to, text, start, end) {
    return { from: from, to: to, text: text, start: start == null ? from + text.length : start, end: end == null ? from + text.length : end };
  }
  function continueList(source, start, end) {
    if (start !== end) return null;
    var range = lineRange(source, start, end), line = source.slice(range.from, range.to);
    var match = /^([ \t]*(?:>[ \t]*)*)([-+*]|(\d+)([.)]))([ \t]+)(\[[ xX]\](?:[ \t]+|$))?/.exec(line);
    if (!match || start < range.from + match[0].length) return null;
    if (!line.slice(match[0].length).trim()) {
      var quote = match[1].includes('>') ? match[1].replace(/[ \t]+$/, ' ') : '';
      return edit(range.from, range.to, quote);
    }
    var marker = match[3] ? String(Number(match[3]) + 1) + match[4] : match[2];
    return edit(start, end, '\n' + match[1] + marker + match[5] + (match[6] ? '[ ] ' : ''));
  }
  function indent(source, start, end, unindent) {
    var range = lineRange(source, start, end), lines = source.slice(range.from, range.to).split('\n');
    var first = 0, total = 0;
    var text = lines.map(function (line, index) {
      var removed = unindent ? (/^(?: {1,2}|\t)/.exec(line) || [''])[0].length : 0;
      var delta = unindent ? -removed : 2;
      if (!index) first = delta;
      total += delta;
      return unindent ? line.slice(removed) : '  ' + line;
    }).join('\n');
    return edit(range.from, range.to, text, Math.max(range.from, start + first), Math.max(range.from, end + total));
  }
  function format(source, start, end, command, table) {
    var selected = source.slice(start, end), range, text, prefix, suffix, sample;
    var inline = {
      bold: ['**', '**', '加粗文字'], italic: ['*', '*', '斜体文字'], strike: ['~~', '~~', '删除线文字'],
      'inline-code': ['`', '`', '代码'], link: ['[', '](https://)', '链接文字'],
      image: ['![', '](https://)', '图片描述'], video: ['[', '](https:// "video")', '视频名称']
    };
    if (inline[command]) {
      prefix = inline[command][0]; suffix = inline[command][1]; sample = selected || inline[command][2];
      return edit(start, end, prefix + sample + suffix, start + prefix.length, start + prefix.length + sample.length);
    }
    if (/^h[1-6]$/.test(command) || ['quote', 'list', 'ordered-list', 'task'].includes(command)) {
      range = lineRange(source, start, end);
      text = (source.slice(range.from, range.to) || (/^h/.test(command) ? '标题' : '列表项')).split('\n').map(function (line, index) {
        if (/^h/.test(command)) return '#'.repeat(Number(command[1])) + ' ' + line.replace(/^ {0,3}#{1,6}(?:[ \t]+|$)/, '');
        if (command === 'quote') return '> ' + line.replace(/^>[ \t]?/, '');
        var content = line.replace(/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/, '');
        return (command === 'ordered-list' ? (index + 1) + '. ' : command === 'task' ? '- [ ] ' : '- ') + content;
      }).join('\n');
      var markerLength = /^h/.test(command) ? Number(command[1]) + 1 : command === 'ordered-list' ? 3 : command === 'task' ? 6 : 2;
      return edit(range.from, range.to, text, text.includes('\n') ? range.from : range.from + markerLength, range.from + text.length);
    }
    prefix = start && source[start - 1] !== '\n' ? '\n\n' : '';
    if (command === 'code') {
      var fences = (selected.match(/`+/g) || []).map(function (value) { return value.length; });
      var fence = '`'.repeat(Math.max.apply(null, [3].concat(fences.map(function (length) { return length + 1; }))));
      text = prefix + fence + '\n' + (selected || '代码') + '\n' + fence + '\n';
      return edit(start, end, text, start + prefix.length + fence.length + 1, start + prefix.length + fence.length + 1 + (selected || '代码').length);
    }
    if (command === 'table') {
      text = prefix + (table ? table(selected) : '| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |\n| 内容 | 内容 | 内容 |') + '\n';
      return edit(start, end, text);
    }
    if (command === 'divider') return edit(start, end, prefix + '---\n');
    return null;
  }

  function mount(options) {
    var textarea = options.textarea, CM = options.CodeMirror;
    var cm = null, active = false, muted = false, mode = 'text', scrollListeners = [];
    function selection() {
      if (active) return { start: cm.indexFromPos(cm.getCursor('from')), end: cm.indexFromPos(cm.getCursor('to')) };
      return { start: textarea.selectionStart, end: textarea.selectionEnd };
    }
    function setSelection(start, end) {
      if (active) cm.setSelection(cm.posFromIndex(start), cm.posFromIndex(end == null ? start : end));
      else textarea.setSelectionRange(start, end == null ? start : end);
    }
    function input() {
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
    function syncMirror() {
      if (!cm || cm.getValue() === textarea.value) return;
      var previous = cm.getValue(), next = textarea.value, start = 0, oldEnd = previous.length, newEnd = next.length;
      while (start < oldEnd && start < newEnd && previous[start] === next[start]) start++;
      while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === next[newEnd - 1]) { oldEnd--; newEnd--; }
      // A minimal edit preserves upload bookmarks while native text/code modes are active.
      muted = true;
      cm.replaceRange(next.slice(start, newEnd), cm.posFromIndex(start), cm.posFromIndex(oldEnd), '+input');
      muted = false;
    }
    function apply(change) {
      if (!change || textarea.readOnly) return;
      if (active) {
        cm.operation(function () {
          cm.replaceRange(change.text, cm.posFromIndex(change.from), cm.posFromIndex(change.to), '+input');
          setSelection(change.start, change.end);
        });
      } else {
        textarea.setRangeText(change.text, change.from, change.to, 'end');
        setSelection(change.start, change.end);
        input();
      }
    }
    function initialize() {
      cm = CM.fromTextArea(textarea, {
        mode: { name: 'gfm', highlightFormatting: true, taskLists: true, strikethrough: true, fencedCodeBlocks: true },
        lineWrapping: true, viewportMargin: 10, tabSize: 2, indentUnit: 2,
        readOnly: textarea.readOnly, inputStyle: 'contenteditable', spellcheck: false,
        extraKeys: {
          Enter: function (instance) {
            if (textarea.readOnly) return;
            var cursor = instance.getCursor(), state = CM.innerMode(instance.getMode(), instance.getStateAfter(cursor.line)).state;
            if (state.fencedEndRE || state.indentedCode) { instance.execCommand('newlineAndIndent'); return; }
            var selected = selection(), change = continueList(textarea.value, selected.start, selected.end);
            if (change) apply(change);
            else instance.execCommand('newlineAndIndentContinueMarkdownList');
          },
          Tab: function () { var selected = selection(); apply(indent(textarea.value, selected.start, selected.end, false)); },
          'Shift-Tab': function () { var selected = selection(); apply(indent(textarea.value, selected.start, selected.end, true)); },
          'Ctrl-B': function () { adapter.format('bold'); }, 'Cmd-B': function () { adapter.format('bold'); },
          'Ctrl-I': function () { adapter.format('italic'); }, 'Cmd-I': function () { adapter.format('italic'); }
        }
      });
      cm.getWrapperElement().setAttribute('aria-label', 'Markdown 正文编辑器');
      cm.on('change', function () {
        if (muted) return;
        textarea.value = cm.getValue();
        var selected = selection();
        textarea.setSelectionRange(selected.start, selected.end);
        input();
      });
      cm.on('cursorActivity', function () {
        if (!active) return;
        var selected = selection();
        textarea.setSelectionRange(selected.start, selected.end);
        textarea.dispatchEvent(new Event('select'));
      });
      cm.on('scroll', function () { scrollListeners.forEach(function (listener) { listener(cm.getScrollerElement()); }); });
    }
    var adapter = {
      getValue: function () { return textarea.value; },
      getSelection: selection,
      setSelection: setSelection,
      focus: function () { if (active) cm.focus(); else textarea.focus(); },
      replaceSelection: function (text) { var selected = selection(); apply(edit(selected.start, selected.end, text)); },
      captureInsertionPoint: function () {
        var offset = selection().end, used = false;
        syncMirror();
        var bookmark = cm ? cm.setBookmark(cm.posFromIndex(offset), { insertLeft: false }) : null;
        function clear() { used = true; if (bookmark) bookmark.clear(); }
        function insert(text) {
          if (used || textarea.readOnly) return false;
          var point = bookmark && bookmark.find();
          var index = point ? cm.indexFromPos(point) : Math.min(offset, textarea.value.length);
          clear();
          if (active) cm.replaceRange(text, cm.posFromIndex(index), cm.posFromIndex(index), '+input');
          else {
            textarea.setRangeText(text, index, index, 'preserve');
            input();
          }
          return true;
        }
        insert.clear = clear;
        return insert;
      },
      format: function (command) {
        if (textarea.readOnly || mode !== 'markdown') return;
        if (command === 'undo' || command === 'redo') {
          if (active) cm.execCommand(command);
          else { textarea.focus(); document.execCommand(command); }
          return;
        }
        var selected = selection();
        apply(format(textarea.value, selected.start, selected.end, command, options.table));
        adapter.focus();
      },
      readOnly: function (value) {
        if (value == null) return textarea.readOnly;
        textarea.readOnly = value;
        if (cm) cm.setOption('readOnly', value);
      },
      setMode: function (kind) {
        mode = kind;
        var enabled = kind === 'markdown' && !!CM;
        if (enabled === active) return;
        var selected = selection();
        if (enabled && !cm) initialize();
        active = enabled;
        if (cm) {
          cm.getWrapperElement().style.display = enabled ? '' : 'none';
          textarea.style.display = enabled ? 'none' : '';
          if (enabled) {
            syncMirror();
            cm.setOption('readOnly', textarea.readOnly);
            cm.refresh();
          }
        }
        setSelection(selected.start, selected.end);
      },
      getScrollElement: function () { return active ? cm.getScrollerElement() : textarea; },
      onScroll: function (listener) { scrollListeners.push(listener); },
      scrollToOffset: function (offset, end) {
        setSelection(offset, end);
        adapter.focus();
        if (active) { cm.scrollIntoView({ from: cm.posFromIndex(offset), to: cm.posFromIndex(end) }, 32); return true; }
        return false;
      },
      refresh: function () { if (active) cm.refresh(); }
    };
    textarea.addEventListener('input', function () {
      if (muted || !cm || cm.getValue() === textarea.value) return;
      var selected = active ? selection() : null;
      syncMirror();
      if (selected) setSelection(selected.start, selected.end);
    });
    return adapter;
  }
  return { continueList: continueList, indent: indent, format: format, mount: mount };
});
