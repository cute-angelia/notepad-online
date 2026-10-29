(function () {
  'use strict';
  var body = document.body, slug = body.dataset.slug || body.dataset.tag, tag = slug, editable = body.dataset.editable === 'true';
  var isNew = body.dataset.new === 'true', kind = body.dataset.kind;
  var doc = document.getElementById('document'), status = document.getElementById('save-status');
  var textarea = document.getElementById('content'), title = document.getElementById('note-title');
  var secret = document.getElementById('note-secret'), preview = document.getElementById('preview-pane');
  var previewButton = document.getElementById('preview-button'), toolbar = document.getElementById('markdown-toolbar');
  var shareButton = document.getElementById('share-button'), notice = document.getElementById('notice');
  var unlockDialog = document.getElementById('unlock-dialog'), codeGutter = document.getElementById('code-gutter');
  var lockedUntil = Number(body.dataset.lockedUntil), blocked = lockedUntil * 1000 > Date.now();
  var secretStorageKey = 'notepad:secret:' + tag;
  function rememberSecret(value) {
    try { window.localStorage.setItem(secretStorageKey, value); } catch (_) { /* Saving still works when browser storage is unavailable. */ }
  }
  var cachedSecret = '';
  if (!editable && !isNew) {
    cachedSecret = new URLSearchParams(window.location.search).get('view_pwd') || new URLSearchParams(window.location.search).get('pwd') || '';
    if (cachedSecret) rememberSecret(cachedSecret);
    else {
      try { cachedSecret = window.localStorage.getItem(secretStorageKey) || ''; } catch (_) { /* Manual verification remains available. */ }
    }
  }
  if (editable && !isNew) {
    try {
      var stored = window.localStorage.getItem(secretStorageKey);
      if (stored) {
        secret.value = stored;
      }
    } catch (_) { /* Use the editable field when storage is unavailable. */ }
  }
  var viewSecret = document.getElementById('note-view-secret');
  var viewSecretWrap = document.getElementById('view-secret-wrap');
  var randomViewSecretBtn = document.getElementById('random-view-secret');
  var lastSaved, savedSecret = secret ? secret.value : '', savedViewSecret = viewSecret ? viewSecret.value : '';
  var inFlight = null, timer, previewOpen = false;
  var mobile = window.matchMedia('(max-width: 760px)');
  var isPrivate = body.dataset.isPrivate === 'true';
  var lockToggle = document.getElementById('lock-toggle');
  var triggerUnlockBtn = document.getElementById('trigger-unlock-btn');

  function updateLockToggleUI() {
    if (!lockToggle) return;
    lockToggle.dataset.locked = String(isPrivate);
    lockToggle.dataset.private = String(isPrivate);
    lockToggle.setAttribute('aria-label', isPrivate ? '非公开' : '公开');
    lockToggle.title = isPrivate ? '当前非公开（查看需查看码），点击切换为公开' : '当前公开（任何人可查看），点击切换为非公开';
    var lockedIcon = lockToggle.querySelector('.lock-icon-locked');
    var unlockedIcon = lockToggle.querySelector('.lock-icon-unlocked');
    if (lockedIcon) {
      lockedIcon.hidden = !isPrivate;
      lockedIcon.style.display = isPrivate ? 'block' : 'none';
    }
    if (unlockedIcon) {
      unlockedIcon.hidden = isPrivate;
      unlockedIcon.style.display = isPrivate ? 'none' : 'block';
    }
    if (viewSecretWrap) viewSecretWrap.hidden = !isPrivate;
  }

  async function api(path, data) {
    var response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'X-Notepad-Request': '1' }, body: new URLSearchParams(data) });
    var result;
    try { result = await response.json(); } catch (_) { result = { error: '服务暂不可用，请稍后重试' }; }
    if (!response.ok) {
      var error = new Error(result.error || '保存失败');
      error.status = response.status; error.details = result; throw error;
    }
    return result;
  }
  function setStatus(text, state) {
    if (!state) {
      if (text === '已保存') state = 'saved';
      else if (text === '保存中' || text === '尚未保存') state = 'saving';
    }
    if (status) { status.textContent = text; status.dataset.state = state || ''; }
    var mobileStatus = document.getElementById('mobile-save-status');
    if (mobileStatus) { mobileStatus.textContent = text; mobileStatus.dataset.state = state || ''; }
  }
  function showToast(text) {
    var toast = document.getElementById('notepad-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'notepad-toast';
      toast.className = 'notepad-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.classList.add('is-visible');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () {
      toast.classList.remove('is-visible');
    }, 1800);
  }
  async function copyText(text, fallbackInput) {
    if (!text) return false;
    var ok = false;
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch (_) { }
    }
    if (!ok && fallbackInput) {
      try {
        fallbackInput.focus();
        fallbackInput.select();
        ok = document.execCommand('copy');
      } catch (_) { }
    }
    if (!ok) {
      try {
        var temp = document.createElement('textarea');
        temp.value = text;
        temp.style.position = 'fixed';
        temp.style.opacity = '0';
        document.body.appendChild(temp);
        temp.select();
        ok = document.execCommand('copy');
        document.body.removeChild(temp);
      } catch (_) { }
    }
    return ok;
  }
  function showNotice(text, tone) { notice.textContent = text; notice.dataset.tone = tone || 'error'; notice.hidden = false; }
  function lock(until) {
    blocked = true; lockedUntil = until || lockedUntil;
    var time = lockedUntil ? new Date(lockedUntil * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '明天';
    showNotice('本文档今天已锁定，所有人均无法编辑。预计 ' + time + '（北京时间）恢复。', 'info');
    if (textarea) textarea.readOnly = true;
    if (title) title.disabled = true;
    if (secret) secret.disabled = true;
    document.querySelectorAll('.type-switch button, .markdown-toolbar button, #random-secret, #random-view-secret').forEach(function (button) { button.disabled = true; });
    clearTimeout(timer); setStatus('今日已锁定', 'error');
    var remaining = lockedUntil * 1000 - Date.now();
    if (remaining > 0) setTimeout(function () {
      blocked = false;
      if (editable) {
        textarea.readOnly = false; title.disabled = false; secret.disabled = false; if (viewSecret) viewSecret.disabled = false;
        document.querySelectorAll('.type-switch button, .markdown-toolbar button, #random-secret, #random-view-secret').forEach(function (button) { button.disabled = false; });
        setStatus(changed() ? '保存中' : '已保存');
      }
      showNotice('锁定时间已结束，可以继续编辑。', 'info');
    }, remaining + 100);

  }
  var activeScrollPane = null, scrollReleaseTimer = null;
  function syncScroll(source, target) {
    if (!previewOpen || !preview || preview.hidden) return;
    var sourceMax = source.scrollHeight - source.clientHeight;
    var targetMax = target.scrollHeight - target.clientHeight;
    if (sourceMax <= 0 || targetMax <= 0) return;
    var ratio = Math.max(0, Math.min(1, source.scrollTop / sourceMax));
    target.scrollTop = ratio * targetMax;
  }
  function updateCodeEditor() {
    if (!codeGutter || !textarea) return;
    var lines = textarea.value.split('\n');
    var count = lines.length;
    if (textarea._lastLineCount !== count) {
      textarea._lastLineCount = count;
      var digits = String(count).length;
      var width = Math.max(44, digits * 8 + 20);
      codeGutter.style.width = width + 'px';
      var nums = [];
      for (var i = 1; i <= count; i++) {
        nums.push(i);
      }
      codeGutter.textContent = nums.join('\n');
    }
    codeGutter.scrollTop = textarea.scrollTop;
  }
  function updateDocument() {
    if (!editable) return;
    doc.dataset.kind = kind;
    window.documentOutline.update(textarea.value, document.getElementById('preview-content'), kind === 'markdown');
    title.style.height = 'auto'; title.style.height = title.scrollHeight + 'px';
    document.querySelectorAll('.type-switch button').forEach(function (button) { button.setAttribute('aria-pressed', String(button.dataset.kind === kind)); });
    toolbar.hidden = kind !== 'markdown'; previewButton.hidden = kind !== 'markdown';
    var show = previewOpen && kind === 'markdown' && !mobile.matches;
    doc.classList.toggle('is-preview', show); preview.hidden = !show;
    previewButton.setAttribute('aria-pressed', String(show));
    previewButton.querySelector('span').textContent = show ? '收起预览' : '实时预览';
    if (show) {
      requestAnimationFrame(function () {
        syncScroll(textarea, preview);
      });
    }
    if (kind === 'code') {
      updateCodeEditor();
    }
    document.getElementById('word-count').textContent = Array.from(textarea.value).length.toLocaleString() + ' 字';
    document.title = (title.value.trim() || '未命名文档') + ' · 记事本';
  }
  function snapshot() { return { title: title.value, text: textarea.value, document_type: kind, is_private: isPrivate ? 1 : 0, view_secret: viewSecret ? viewSecret.value : '' }; }
  function changed() { return isNew || (secret && secret.value !== savedSecret) || (viewSecret && viewSecret.value !== savedViewSecret) || JSON.stringify(snapshot()) !== lastSaved; }
  function schedule() {
    if (blocked) return;
    setStatus('保存中'); clearTimeout(timer);
    timer = setTimeout(function () { save().catch(function () { }); }, 800);
  }
  async function save() {
    clearTimeout(timer);
    if (inFlight) { await inFlight; if (changed()) return save(); return; }
    if (blocked) throw new Error('本文档今天已锁定，无法保存');
    if (!changed()) return;
    var data = snapshot(), capturedKey = secret.value, keyChanged = isNew || capturedKey !== savedSecret;
    if (Array.from(data.text).length > 100000) { setStatus('正文超出长度限制', 'error'); throw new Error('正文不能超过 100,000 个字符'); }
    if (keyChanged && (Array.from(capturedKey.trim()).length < 4 || new TextEncoder().encode(capturedKey).length > 72)) {
      setStatus('秘钥格式有误', 'error'); throw new Error('秘钥至少 4 个字符，最多 72 字节');
    }
    var creating = isNew;
    data.is_private = isPrivate ? '1' : '0';
    if (viewSecret) data.view_secret = viewSecret.value;
    if (keyChanged) data.secret = capturedKey;
    if (creating) { data.slug = slug; data.tag = slug; }
    setStatus('保存中', 'saving');
    inFlight = (async function () {
      try {
        var result = await api(creating ? '/api/notes' : '/' + encodeURIComponent(tag), data);
        lastSaved = JSON.stringify(snapshot());
        if (creating) {
          isNew = false;
          body.dataset.new = 'false';
          history.replaceState(null, '', result.edit_url);
          var viewLink = document.getElementById('view-link');
          if (viewLink) viewLink.href = result.view_url || ('/' + encodeURIComponent(slug));
        }
        savedSecret = capturedKey;
        if (viewSecret) savedViewSecret = viewSecret.value;
        if (capturedKey) rememberSecret(capturedKey);
        setStatus('已保存');
        if (!blocked) notice.hidden = true;
      } catch (error) {
        setStatus('保存失败', 'error'); showNotice(error.message + '。正文仍保留在当前页面。');
        if (error.status === 423) lock(error.details.locked_until);
        if (error.status === 403) { showNotice('浏览器授权已失效。请保留当前正文，在新窗口用秘钥重新授权后重试。'); }
        throw error;
      }
    })();
    try { await inFlight; } finally { inFlight = null; }
    if (changed() && !blocked) schedule();
  }

  async function share() {
    shareButton.disabled = true;
    try {
      if (editable && !blocked) { await save(); while (changed()) await save(); }
      else if (editable && changed()) throw new Error('当前有未保存的修改，分享前请先保存');
      var shareUrl = new URL('/' + encodeURIComponent(tag), window.location.origin);
      if (isPrivate && viewSecret && viewSecret.value) {
        shareUrl.searchParams.set('view_pwd', viewSecret.value);
      }
      var url = shareUrl.href;
      var copied = await copyText(url);
      if (copied) {
        shareButton.querySelector('span').textContent = '链接已复制';
        showToast(isPrivate ? '已复制免密分享链接' : '分享链接已复制');
      } else {
        var input = document.getElementById('share-url');
        input.value = url;
        document.getElementById('share-dialog').showModal();
        input.select();
      }
      setTimeout(function () { shareButton.querySelector('span').textContent = '复制链接'; }, 2000);
    } catch (error) { showNotice(error.message); } finally { shareButton.disabled = false; }
  }
  if (shareButton) shareButton.addEventListener('click', share);
  var closeShareBtn = document.getElementById('close-share');
  if (closeShareBtn) {
    closeShareBtn.addEventListener('click', async function () {
      var input = document.getElementById('share-url');
      var url = (input && input.value) ? input.value : new URL('/' + encodeURIComponent(tag), window.location.origin).href;
      await copyText(url, input);
      showToast('分享链接已复制');
      closeShareBtn.textContent = '已复制';
      setTimeout(function () {
        document.getElementById('share-dialog').close();
        closeShareBtn.textContent = '复制';
      }, 500);
    });
  }
  var closeShareX = document.getElementById('close-share-x');
  if (closeShareX) {
    closeShareX.addEventListener('click', function () {
      document.getElementById('share-dialog').close();
    });
  }

  var unlockMode = body.dataset.requestEdit === 'true' ? 'edit' : (body.dataset.privateLocked === 'true' ? 'view' : 'edit');

  function openUnlock(mode) {
    if (mode) unlockMode = mode;
    if (blocked) { lock(lockedUntil); return; }
    if (unlockDialog.open) unlockDialog.close();
    var unlockSecret = document.getElementById('unlock-secret');
    if (!unlockSecret.value) unlockSecret.value = cachedSecret;
    var desc = unlockDialog.querySelector ? unlockDialog.querySelector('.dialog-description') : null;
    var eyebrow = unlockDialog.querySelector ? unlockDialog.querySelector('.dialog-eyebrow') : null;
    var submitBtn = document.getElementById('unlock-submit');
    if (unlockMode === 'edit') {
      if (eyebrow) eyebrow.textContent = '继续创作';
      if (desc) desc.textContent = '需要输入秘钥才能编辑';
      if (submitBtn) submitBtn.textContent = '进入编辑';
    } else {
      if (eyebrow) eyebrow.textContent = '非公开文档';
      if (desc) desc.textContent = '此文档为非公开文档，需要输入查看码才能查看';
      if (submitBtn) submitBtn.textContent = '进入查看';
    }
    unlockDialog.showModal(); unlockSecret.focus();
  }
  function requestUnlock(mode) {
    if (mode) unlockMode = mode;
    if (blocked) { lock(lockedUntil); return; }
    if (cachedSecret) return verifyUnlock(cachedSecret, unlockMode);
    openUnlock(unlockMode);
  }
  var editLink = document.getElementById('edit-link');
  if (editLink) editLink.addEventListener('click', function (event) {
    unlockMode = 'edit';
    if (blocked || cachedSecret || body.dataset.requestEdit === 'true' || unlockDialog.open) { event.preventDefault(); return requestUnlock('edit'); }
  });
  var closeUnlock = document.getElementById('close-unlock');
  if (closeUnlock && closeUnlock.addEventListener) {
    closeUnlock.addEventListener('click', function () {
      if (body.dataset.privateLocked === 'true') return;
      unlockDialog.close();
    });
  }
  if (unlockDialog && unlockDialog.addEventListener) {
    unlockDialog.addEventListener('cancel', function (event) {
      if (body.dataset.privateLocked === 'true' || unlockMode === 'view') {
        event.preventDefault();
      }
    });
  }
  var unlocking = false;
  async function verifyUnlock(enteredSecret, mode) {
    if (mode) unlockMode = mode;
    if (unlocking) return;
    if (blocked) { lock(lockedUntil); return; }
    unlocking = true;
    var button = document.getElementById('unlock-submit'), errorLabel = document.getElementById('unlock-error');
    button.disabled = true; errorLabel.textContent = '';
    try {
      var result = await api('/' + encodeURIComponent(tag) + '/unlock', { secret: enteredSecret });
      rememberSecret(enteredSecret);
      if (unlockMode === 'edit') {
        if (result.role === 'viewer') {
          openUnlock('edit');
          errorLabel.textContent = '此为查看码，仅可浏览，无法编辑。如需编辑请输入编辑秘钥。';
          return;
        }
        window.location.assign(result.edit_url);
      } else {
        window.location.reload();
      }
    }
    catch (error) {
      if (error.status === 403 && cachedSecret === enteredSecret) {
        cachedSecret = '';
        try {
          if (window.localStorage.getItem(secretStorageKey) === enteredSecret) window.localStorage.removeItem(secretStorageKey);
        } catch (_) { /* Manual verification remains available. */ }
      }
      if (error.status === 423) { unlockDialog.close(); lock(error.details.locked_until); }
      else {
        openUnlock(unlockMode);
        errorLabel.textContent = error.message + (error.details && typeof error.details.remaining === 'number' ? '，今天还可尝试 ' + error.details.remaining + ' 次。' : '');
      }
    } finally { button.disabled = false; unlocking = false; }
  }
  document.getElementById('unlock-form').addEventListener('submit', function (event) {
    event.preventDefault();
    return verifyUnlock(document.getElementById('unlock-secret').value, unlockMode);
  });

  if (editable) {
    lastSaved = isNew ? null : JSON.stringify(snapshot());
    if (lockToggle) {
      lockToggle.addEventListener('click', async function () {
        if (blocked) return;
        isPrivate = !isPrivate;
        if (isPrivate && viewSecret && !viewSecret.value) {
          try {
            var res = await fetch('/api/secret', { credentials: 'same-origin', cache: 'no-store' });
            if (res.ok) {
              viewSecret.value = (await res.json()).secret;
            }
          } catch (_) { }
        }
        updateLockToggleUI();
        showToast(isPrivate ? '已设为非公开文档' : '已设为公开文档');
        schedule();
      });
    }
    if (viewSecret) {
      viewSecret.addEventListener('click', async function () {
        if (!viewSecret.value) return;
        await copyText(viewSecret.value, viewSecret);
        showToast('查看码已复制');
      });
      viewSecret.addEventListener('input', function () {
        schedule();
      });
    }
    if (randomViewSecretBtn) {
      randomViewSecretBtn.addEventListener('click', async function () {
        var button = this; button.disabled = true;
        button.classList.add('is-spinning');
        setTimeout(function () { button.classList.remove('is-spinning'); }, 450);
        try {
          var response = await fetch('/api/secret', { credentials: 'same-origin', cache: 'no-store' });
          if (!response.ok) throw new Error('生成查看码失败');
          viewSecret.value = (await response.json()).secret;
          schedule();
        } catch (error) { showNotice(error.message); } finally { button.disabled = blocked; }
      });
    }
    textarea.addEventListener('input', function () { updateDocument(); schedule(); });
    title.addEventListener('input', function () { updateDocument(); schedule(); });
    secret.addEventListener('input', function () { secret.title = '点击复制，直接输入可修改'; schedule(); });
    document.querySelectorAll('.type-switch button').forEach(function (button) { button.addEventListener('click', function () { if (blocked) return; kind = button.dataset.kind; updateDocument(); schedule(); }); });
    previewButton.addEventListener('click', function () { previewOpen = !previewOpen; updateDocument(); });
    mobile.addEventListener('change', updateDocument);

    var setHover = function (pane) { activeScrollPane = pane; clearTimeout(scrollReleaseTimer); };
    var clearHover = function () { scrollReleaseTimer = setTimeout(function () { activeScrollPane = null; }, 300); };
    textarea.addEventListener('mouseenter', function () { setHover('source'); });
    textarea.addEventListener('mouseleave', clearHover);
    textarea.addEventListener('touchstart', function () { setHover('source'); }, { passive: true });
    textarea.addEventListener('touchend', clearHover);
    preview.addEventListener('mouseenter', function () { setHover('preview'); });
    preview.addEventListener('mouseleave', clearHover);
    preview.addEventListener('touchstart', function () { setHover('preview'); }, { passive: true });
    preview.addEventListener('touchend', clearHover);

    textarea.addEventListener('scroll', function () {
      if (kind === 'code' && codeGutter) {
        codeGutter.scrollTop = textarea.scrollTop;
      }
      if (activeScrollPane === 'preview') return;
      syncScroll(textarea, preview);
    }, { passive: true });

    preview.addEventListener('scroll', function () {
      if (activeScrollPane === 'source') return;
      syncScroll(preview, textarea);
    }, { passive: true });
    secret.addEventListener('click', async function () {
      if (!secret.value) return;
      await copyText(secret.value, secret);
      showToast('秘钥已复制');
    });
    var randomSecretBtn = document.getElementById('random-secret');
    if (randomSecretBtn) {
      randomSecretBtn.addEventListener('click', async function () {
        var button = this; button.disabled = true;
        button.classList.add('is-spinning');
        setTimeout(function () { button.classList.remove('is-spinning'); }, 450);
        try {
          var response = await fetch('/api/secret', { credentials: 'same-origin', cache: 'no-store' });
          if (!response.ok) throw new Error('生成秘钥失败');
          secret.value = (await response.json()).secret;
          schedule();
        } catch (error) { showNotice(error.message); } finally { button.disabled = blocked; }
      });
    }
    document.querySelectorAll('[data-format]').forEach(function (button) {
      button.addEventListener('mousedown', function (event) { event.preventDefault(); });
      button.addEventListener('click', function () {
        if (blocked) return;
        var start = textarea.selectionStart, end = textarea.selectionEnd, selected = textarea.value.slice(start, end), replacement, offset = 0;
        switch (button.dataset.format) {
          case 'bold': replacement = '**' + (selected || '加粗文字') + '**'; offset = 2; break;
          case 'heading': start = start === 0 ? 0 : textarea.value.lastIndexOf('\n', start - 1) + 1; replacement = '### ' + textarea.value.slice(start, end).replace(/^ {0,3}#{1,6}[ \t]+/, ''); offset = 4; break;
          case 'list': start = start === 0 ? 0 : textarea.value.lastIndexOf('\n', start - 1) + 1; replacement = (textarea.value.slice(start, end) || '列表项').split('\n').map(function (line) { return '- ' + line; }).join('\n'); offset = 2; break;
          case 'link': replacement = '[' + (selected || '链接文字') + '](https://)'; offset = 1; break;
          case 'table': replacement = (start && textarea.value[start - 1] !== '\n' ? '\n\n' : '') + window.markdownTools.table(selected) + '\n'; offset = replacement.indexOf('| ') + 2; break;
          case 'code': replacement = (start && textarea.value[start - 1] !== '\n' ? '\n' : '') + '```\n' + (selected || '代码') + '\n```\n'; offset = replacement.indexOf('```') + 4; break;
        }
        textarea.setRangeText(replacement, start, end, 'end'); textarea.focus();
        if (button.dataset.format === 'table' && !selected) textarea.setSelectionRange(start + offset, start + offset + 3);
        else if (!selected) textarea.setSelectionRange(start + offset, start + replacement.length - (button.dataset.format === 'bold' ? 2 : 0));
        updateDocument(); schedule();
      });
    });
    textarea.addEventListener('keydown', function (e) {
      if (kind !== 'code' || blocked) return;
      if (e.key === 'Tab') {
        e.preventDefault();
        var start = this.selectionStart, end = this.selectionEnd, val = this.value;
        if (e.shiftKey) {
          var lineStart = val.lastIndexOf('\n', start - 1) + 1;
          var lineEnd = val.indexOf('\n', end);
          if (lineEnd === -1) lineEnd = val.length;
          var slice = val.slice(lineStart, lineEnd);
          var lines = slice.split('\n');
          var unindented = lines.map(function (line) {
            if (line.indexOf('    ') === 0) return line.slice(4);
            if (line.indexOf('\t') === 0) return line.slice(1);
            return line.replace(/^ {1,4}/, '');
          }).join('\n');
          var diff = slice.length - unindented.length;
          this.setRangeText(unindented, lineStart, lineEnd, 'preserve');
          this.setSelectionRange(Math.max(lineStart, start - (slice.indexOf(' ') === 0 ? 4 : 0)), Math.max(lineStart, end - diff));
        } else {
          if (start !== end && val.slice(start, end).indexOf('\n') !== -1) {
            var lineStart = val.lastIndexOf('\n', start - 1) + 1;
            var lineEnd = val.indexOf('\n', end);
            if (lineEnd === -1) lineEnd = val.length;
            var lines = val.slice(lineStart, lineEnd).split('\n');
            var indented = lines.map(function (line) { return '    ' + line; }).join('\n');
            this.setRangeText(indented, lineStart, lineEnd, 'preserve');
            this.setSelectionRange(start + 4, end + (lines.length * 4));
          } else {
            this.setRangeText('    ', start, end, 'end');
          }
        }
        updateDocument();
        schedule();
      } else if (e.key === 'Enter') {
        var start = this.selectionStart, val = this.value;
        var lineStart = val.lastIndexOf('\n', start - 1) + 1;
        var lineText = val.slice(lineStart, start);
        var match = lineText.match(/^([ \t]+)/);
        if (match) {
          e.preventDefault();
          var indent = match[1];
          this.setRangeText('\n' + indent, start, start, 'end');
          updateDocument();
          schedule();
        }
      }
    });
    window.addEventListener('beforeunload', function (event) { if (changed() && (!isNew || title.value || textarea.value)) { event.preventDefault(); event.returnValue = ''; } });
    document.addEventListener('keydown', function (event) { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save().catch(function () { }); } });
    updateDocument();
  } else if (body.dataset.privateLocked !== 'true') {
    doc.dataset.kind = kind;
    var rawElem = document.getElementById('raw-content');
    var rawText = rawElem ? rawElem.value : '';
    if (window.documentOutline && window.documentOutline.update) {
      window.documentOutline.update(rawText, document.getElementById('read-content'), kind === 'markdown');
    }
    if (kind === 'markdown') {
      document.querySelectorAll('#read-content pre > code').forEach(function (code) {
        var pre = code.parentElement, wrapper = document.createElement('div');
        wrapper.className = 'read-code-block';
        pre.replaceWith(wrapper);
        wrapper.appendChild(pre);
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'read-code-copy';
        button.setAttribute('aria-label', '复制代码');
        button.title = '复制代码';
        button.innerHTML = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="7" y="7" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M4 13V5a1.5 1.5 0 0 1 1.5-1.5H12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
        button.addEventListener('click', async function () {
          var ok = await copyText(code.textContent);
          showToast(ok ? '代码已复制' : '复制失败');
        });
        wrapper.appendChild(button);
      });
    }
    if (kind === 'code') {
      initCodeViewer(rawText);
    }
    var readerCopyContent = document.getElementById('reader-copy-content');
    if (readerCopyContent) {
      readerCopyContent.addEventListener('click', async function () {
        var ok = await copyText(rawText);
        if (ok) {
          showToast('内容已复制');
          var span = readerCopyContent.querySelector('span');
          if (span) {
            span.textContent = '内容已复制';
            setTimeout(function () { span.textContent = '复制内容'; }, 2000);
          }
        }
      });
    }
    var readerCopyLink = document.getElementById('reader-copy-link');
    if (readerCopyLink) {
      readerCopyLink.addEventListener('click', async function () {
        var url = new URL('/' + encodeURIComponent(tag), window.location.origin).href;
        var ok = await copyText(url);
        if (ok) {
          showToast('分享链接已复制');
          var span = readerCopyLink.querySelector('span');
          if (span) {
            span.textContent = '链接已复制';
            setTimeout(function () { span.textContent = '复制链接'; }, 2000);
          }
        } else {
          var input = document.getElementById('share-url');
          var shareDlg = document.getElementById('share-dialog');
          if (input && shareDlg) {
            input.value = url;
            shareDlg.showModal();
            input.select();
          }
        }
      });
    }
    fitArticleTitle();
    window.addEventListener('resize', fitArticleTitle);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(fitArticleTitle);
    }
  }
  function fitArticleTitle() {
    var titleElem = document.querySelector('.article-title');
    if (!titleElem) return;
    var max = 44, min = 16;
    titleElem.style.fontSize = max + 'px';
    titleElem.style.whiteSpace = 'nowrap';
    var available = titleElem.clientWidth;
    var needed = titleElem.scrollWidth;
    if (needed > available && available > 0) {
      var ideal = Math.floor(max * (available / needed));
      var finalSize = Math.max(min, Math.min(max, ideal));
      titleElem.style.fontSize = finalSize + 'px';
      while (finalSize > min && titleElem.scrollWidth > titleElem.clientWidth) {
        finalSize--;
        titleElem.style.fontSize = finalSize + 'px';
      }
      if (finalSize === min && titleElem.scrollWidth > titleElem.clientWidth) {
        titleElem.style.whiteSpace = 'normal';
      }
    }
  }
  function initCodeViewer(text) {
    var readGutter = document.getElementById('read-code-gutter');
    var linesCount = document.getElementById('code-lines-count');
    var copyBtn = document.getElementById('code-copy-button');
    var codeElem = document.getElementById('read-code-content');
    var lines = (text || '').split('\n');
    var count = lines.length;
    if (linesCount) {
      linesCount.textContent = '共 ' + count.toLocaleString() + ' 行';
    }
    if (readGutter) {
      var digits = String(count).length;
      readGutter.style.width = Math.max(44, digits * 8 + 20) + 'px';
      var nums = [];
      for (var i = 1; i <= count; i++) {
        nums.push(i);
      }
      readGutter.textContent = nums.join('\n');
    }
    if (codeElem && window.hljs && typeof window.hljs.highlightAuto === 'function' && text) {
      try {
        var res = window.hljs.highlightAuto(text);
        if (res && res.value) {
          codeElem.innerHTML = res.value;
          if (codeElem.classList) codeElem.classList.add('hljs');
        }
      } catch (_) {
        /* Preserve original unhighlighted content on parsing failure */
      }
    }
    if (copyBtn) {
      copyBtn.addEventListener('click', async function () {
        var ok = await copyText(text);
        if (ok) {
          showToast('代码已复制');
          var span = copyBtn.querySelector('span');
          if (span) {
            var original = span.textContent;
            span.textContent = '已复制 ✓';
            setTimeout(function () { span.textContent = original; }, 2000);
          }
        }
      });
    }
  }
  if (triggerUnlockBtn) {
    triggerUnlockBtn.addEventListener('click', function () {
      openUnlock('view');
    });
  }
  if (blocked) { if (unlockDialog.open) unlockDialog.close(); lock(lockedUntil); }
  else if (body.dataset.requestEdit === 'true') requestUnlock('edit');
  else if (body.dataset.privateLocked === 'true') requestUnlock('view');
})();
