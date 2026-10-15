(function () {
    'use strict';
    var body = document.body, tag = body.dataset.tag, editable = body.dataset.editable === 'true';
    var isNew = body.dataset.new === 'true', kind = body.dataset.kind;
    var doc = document.getElementById('document'), status = document.getElementById('save-status');
    var textarea = document.getElementById('content'), title = document.getElementById('note-title');
    var secret = document.getElementById('note-secret'), preview = document.getElementById('preview-pane');
    var previewButton = document.getElementById('preview-button'), toolbar = document.getElementById('markdown-toolbar');
    var shareButton = document.getElementById('share-button'), notice = document.getElementById('notice');
    var unlockDialog = document.getElementById('unlock-dialog');
    var lockedUntil = Number(body.dataset.lockedUntil), blocked = lockedUntil * 1000 > Date.now();
    var secretStorageKey = 'notepad:secret:' + tag;
    function rememberSecret(value) {
        try { window.localStorage.setItem(secretStorageKey, value); } catch (_) { /* Saving still works when browser storage is unavailable. */ }
    }
    if (editable && !isNew) {
        try { secret.value = window.localStorage.getItem(secretStorageKey) || ''; } catch (_) { /* Use the editable field when storage is unavailable. */ }
    }
    var lastSaved, savedSecret = secret ? secret.value : '', inFlight = null, timer, previewOpen = false;
    var mobile = window.matchMedia('(max-width: 760px)');

    async function api(path, data) {
        var response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: {'X-Notepad-Request': '1'}, body: new URLSearchParams(data) });
        var result;
        try { result = await response.json(); } catch (_) { result = {error: '服务暂不可用，请稍后重试'}; }
        if (!response.ok) {
            var error = new Error(result.error || '保存失败');
            error.status = response.status; error.details = result; throw error;
        }
        return result;
    }
    function setStatus(text, state) { if (status) {status.textContent = text; status.dataset.state = state || '';} var mobileStatus = document.getElementById('mobile-save-status'); if (mobileStatus) {mobileStatus.textContent = text; mobileStatus.dataset.state = state || '';} }
    function showNotice(text, tone) { notice.textContent = text; notice.dataset.tone = tone || 'error'; notice.hidden = false; }
    function lock(until) {
        blocked = true; lockedUntil = until || lockedUntil;
        var time = lockedUntil ? new Date(lockedUntil * 1000).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false}) : '明天';
        showNotice('本文档今天已锁定，所有人均无法编辑。预计 ' + time + '（北京时间）恢复。', 'info');
        if (textarea) textarea.readOnly = true;
        if (title) title.disabled = true;
        if (secret) secret.disabled = true;
        document.querySelectorAll('.type-switch button, .markdown-toolbar button, #random-secret').forEach(function (button) {button.disabled = true;});
        clearTimeout(timer); setStatus('今日已锁定', 'error');
        var remaining = lockedUntil * 1000 - Date.now();
        if (remaining > 0) setTimeout(function () {
            blocked = false;
            if (editable) {
                textarea.readOnly = false; title.disabled = false; secret.disabled = false;
                document.querySelectorAll('.type-switch button, .markdown-toolbar button, #random-secret').forEach(function (button) {button.disabled = false;});
                setStatus(changed() ? '尚未保存' : '已保存');
            }
            showNotice('锁定时间已结束，可以继续编辑。', 'info');
        }, remaining + 100);

    }
    function updateDocument() {
        if (!editable) return;
        doc.dataset.kind = kind;
        window.documentOutline.update(textarea.value, document.getElementById('preview-content'), kind === 'markdown');
        title.style.height = 'auto'; title.style.height = title.scrollHeight + 'px';
        document.querySelectorAll('.type-switch button').forEach(function (button) {button.setAttribute('aria-pressed', String(button.dataset.kind === kind));});
        toolbar.hidden = kind !== 'markdown'; previewButton.hidden = kind !== 'markdown';
        var show = previewOpen && kind === 'markdown' && !mobile.matches;
        doc.classList.toggle('is-preview', show); preview.hidden = !show;
        previewButton.setAttribute('aria-pressed', String(show));
        previewButton.querySelector('span').textContent = show ? '收起预览' : '实时预览';
        textarea.style.height = 'auto'; textarea.style.height = Math.max(textarea.scrollHeight, 360) + 'px';
        document.getElementById('word-count').textContent = Array.from(textarea.value).length.toLocaleString() + ' 字';
        document.title = (title.value.trim() || '未命名文档') + ' · 记事本';
    }
    function snapshot() { return {title: title.value, text: textarea.value, document_type: kind}; }
    function changed() {return isNew || secret.value !== savedSecret || JSON.stringify(snapshot()) !== lastSaved;}
    function schedule() {
        if (blocked) return;
        setStatus('尚未保存'); clearTimeout(timer);
        timer = setTimeout(function () {save().catch(function () {});}, 800);
    }
    async function save() {
        clearTimeout(timer);
        if (inFlight) {await inFlight; if (changed()) return save(); return;}
        if (blocked) throw new Error('本文档今天已锁定，无法保存');
        if (!changed()) return;
        var data = snapshot(), capturedKey = secret.value, keyChanged = isNew || capturedKey !== savedSecret;
        if (Array.from(data.text).length > 100000) {setStatus('正文超出长度限制', 'error'); throw new Error('正文不能超过 100,000 个字符');}
        if (keyChanged && (Array.from(capturedKey.trim()).length < 4 || new TextEncoder().encode(capturedKey).length > 72)) {
            setStatus('秘钥格式有误', 'error'); throw new Error('秘钥至少 4 个字符，最多 72 字节');
        }
        var creating = isNew;
        if (keyChanged) data.secret = capturedKey;
        if (creating) data.tag = tag;
        setStatus('保存中', 'saving');
        inFlight = (async function () {
            try {
                var result = await api(creating ? '/api/notes' : '/' + encodeURIComponent(tag), data);
                lastSaved = JSON.stringify({title: data.title, text: data.text, document_type: data.document_type});
                if (creating) {isNew = false; body.dataset.new = 'false'; history.replaceState(null, '', result.edit_url);}
                savedSecret = capturedKey;
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
        try {await inFlight;} finally {inFlight = null;}
        if (changed() && !blocked) schedule();
    }

    async function share() {
        shareButton.disabled = true;
        try {
            if (editable && !blocked) {await save(); while (changed()) await save();}
            else if (editable && changed()) throw new Error('当前有未保存的修改，分享前请先保存或解锁');
            var url = new URL('/' + encodeURIComponent(tag), window.location.origin).href;
            try {await navigator.clipboard.writeText(url); shareButton.querySelector('span').textContent = '链接已复制';}
            catch (_) { var input = document.getElementById('share-url'); input.value = url; document.getElementById('share-dialog').showModal(); input.select(); }
            setTimeout(function () {shareButton.querySelector('span').textContent = '复制链接';}, 2000);
        } catch (error) {showNotice(error.message);} finally {shareButton.disabled = false;}
    }
    if (shareButton) shareButton.addEventListener('click', share);
    document.getElementById('close-share').addEventListener('click', function () {document.getElementById('share-dialog').close();});

    function openUnlock() {
        if (blocked) {lock(lockedUntil);return;}
        if (unlockDialog.open) unlockDialog.close();
        var unlockSecret = document.getElementById('unlock-secret');
        if (!unlockSecret.value) {
            try { unlockSecret.value = window.localStorage.getItem(secretStorageKey) || ''; } catch (_) { /* Manual verification remains available. */ }
        }
        unlockDialog.showModal(); unlockSecret.focus();
    }
    var editLink = document.getElementById('edit-link');
    if (editLink) editLink.addEventListener('click', function (event) {
        if (body.dataset.requestEdit === 'true') {event.preventDefault();openUnlock();}
    });
    document.getElementById('close-unlock').addEventListener('click', function () {unlockDialog.close();});
    document.getElementById('unlock-form').addEventListener('submit', async function (event) {
        event.preventDefault();
        var button = document.getElementById('unlock-submit'), errorLabel = document.getElementById('unlock-error');
        button.disabled = true; errorLabel.textContent = '';
        try {var enteredSecret = document.getElementById('unlock-secret').value; var result = await api('/' + encodeURIComponent(tag) + '/unlock', {secret: enteredSecret}); rememberSecret(enteredSecret); window.location.assign(result.edit_url);}
        catch (error) {
            if (error.status === 423) {unlockDialog.close();lock(error.details.locked_until);}
            else {errorLabel.textContent = error.message + (error.details && typeof error.details.remaining === 'number' ? '，今天还可尝试 ' + error.details.remaining + ' 次。' : '');}
        } finally {button.disabled = false;}
    });

    if (editable) {
        lastSaved = isNew ? null : JSON.stringify(snapshot());
        textarea.addEventListener('input', function () {updateDocument();schedule();});
        title.addEventListener('input', function () {updateDocument();schedule();});
        secret.addEventListener('input', function () {secret.title = '点击复制，直接输入可修改'; schedule();});
        document.querySelectorAll('.type-switch button').forEach(function (button) {button.addEventListener('click', function () {if (blocked) return;kind = button.dataset.kind;updateDocument();schedule();});});
        previewButton.addEventListener('click', function () {previewOpen = !previewOpen;updateDocument();});
        mobile.addEventListener('change', updateDocument);
        secret.addEventListener('click', async function () {
            if (!secret.value) return;
            try {
                await navigator.clipboard.writeText(secret.value);
                secret.title = '秘钥已复制';
            } catch (_) {
                secret.select();
            }
        });
        document.getElementById('random-secret').addEventListener('click', async function () {
            var button = this; button.disabled = true;
            try {
                var response = await fetch('/api/secret', {credentials: 'same-origin', cache: 'no-store'});
                if (!response.ok) throw new Error('生成秘钥失败');
                secret.value = (await response.json()).secret;
                schedule();
            } catch (error) {showNotice(error.message);} finally {button.disabled = blocked;}
        });
        document.querySelectorAll('[data-format]').forEach(function (button) {
            button.addEventListener('mousedown', function (event) {event.preventDefault();});
            button.addEventListener('click', function () {
                if (blocked) return;
                var start = textarea.selectionStart, end = textarea.selectionEnd, selected = textarea.value.slice(start, end), replacement, offset = 0;
                switch (button.dataset.format) {
                    case 'bold': replacement = '**' + (selected || '加粗文字') + '**'; offset = 2; break;
                    case 'heading': start = start === 0 ? 0 : textarea.value.lastIndexOf('\n', start - 1) + 1; replacement = '### ' + textarea.value.slice(start, end).replace(/^ {0,3}#{1,6}[ \t]+/, ''); offset = 4; break;
                    case 'list': start = start === 0 ? 0 : textarea.value.lastIndexOf('\n', start - 1) + 1; replacement = (textarea.value.slice(start, end) || '列表项').split('\n').map(function (line) {return '- ' + line;}).join('\n'); offset = 2; break;
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
        window.addEventListener('beforeunload', function (event) {if (changed() && (!isNew || title.value || textarea.value)) {event.preventDefault();event.returnValue = '';}});
        document.addEventListener('keydown', function (event) {if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {event.preventDefault();save().catch(function () {});}});
        updateDocument();
    } else {
        doc.dataset.kind = kind;
        window.documentOutline.update(document.getElementById('raw-content').value, document.getElementById('read-content'), kind === 'markdown');
    }
    if (blocked) {if (unlockDialog.open) unlockDialog.close();lock(lockedUntil);}
    else if (body.dataset.requestEdit === 'true') openUnlock();
})();
