/* Enhance sanitized Markdown images without changing the source document. */
(function () {
    'use strict';
    var enhanced = new WeakSet();
    var dialog, stage, canvas, image, caption, status, zoom, zoomIn, zoomOut, fitButton, closeButton;
    var opener, scale = 1, fitScale = 1;

    function fit() {
        return Math.min(1, Math.max(1, stage.clientWidth - 48) / image.naturalWidth,
            Math.max(1, stage.clientHeight - 48) / image.naturalHeight);
    }

    function resize(nextScale, keepCenter) {
        var x = (stage.scrollLeft + stage.clientWidth / 2) / canvas.scrollWidth;
        var y = (stage.scrollTop + stage.clientHeight / 2) / canvas.scrollHeight;
        scale = Math.max(Math.min(fitScale, 0.1), Math.min(4, nextScale));
        var width = image.naturalWidth * scale, height = image.naturalHeight * scale;
        image.style.width = width + 'px';
        image.style.height = height + 'px';
        canvas.style.width = (width + 48) + 'px';
        canvas.style.height = (height + 48) + 'px';
        zoom.textContent = Math.round(scale * 100) + '%';
        zoomOut.disabled = scale <= Math.min(fitScale, 0.1);
        zoomIn.disabled = scale >= 4;
        if (keepCenter) {
            stage.scrollLeft = x * canvas.scrollWidth - stage.clientWidth / 2;
            stage.scrollTop = y * canvas.scrollHeight - stage.clientHeight / 2;
        } else {
            stage.scrollLeft = stage.scrollTop = 0;
        }
    }

    function initialize() {
        if (dialog) return;
        function element(name) { return document.getElementById('image-viewer' + (name ? '-' + name : '')); }
        dialog = element(''); stage = element('stage'); canvas = element('canvas'); image = element('image');
        caption = element('caption'); status = element('status'); zoom = element('zoom');
        zoomIn = element('in'); zoomOut = element('out'); fitButton = element('fit'); closeButton = element('close');
        closeButton.addEventListener('click', function () { dialog.close(); });
        dialog.addEventListener('cancel', function (event) { event.preventDefault(); dialog.close(); });
        dialog.addEventListener('click', function (event) { if (event.target === dialog) dialog.close(); });
        stage.addEventListener('click', function (event) {
            if (event.target === stage || event.target === canvas || event.target === status) dialog.close();
        });
        dialog.addEventListener('close', function () {
            image.removeAttribute('src');
            canvas.hidden = true;
            document.body.classList.remove('image-viewer-open');
            if (opener && opener.isConnected) opener.focus({ preventScroll: true });
            opener = null;
        });
        image.addEventListener('load', function () {
            if (!dialog.open || !image.naturalWidth || !image.naturalHeight) return;
            status.hidden = true; canvas.hidden = false; fitButton.disabled = false;
            fitScale = fit();
            resize(fitScale, false);
        });
        image.addEventListener('error', function () {
            if (!dialog.open) return;
            canvas.hidden = true; status.hidden = false;
            status.textContent = '图片加载失败，请关闭后重试。';
            zoomIn.disabled = zoomOut.disabled = fitButton.disabled = true;
        });
        zoomIn.addEventListener('click', function () { resize(scale * 1.25, true); });
        zoomOut.addEventListener('click', function () { resize(scale / 1.25, true); });
        fitButton.addEventListener('click', function () { resize(fitScale, false); });
        image.addEventListener('click', function () {
            resize(Math.abs(scale - fitScale) < 0.000001 ? (fitScale < 1 ? 1 : 2) : fitScale, true);
        });
        window.addEventListener('resize', function () {
            if (!dialog.open || canvas.hidden) return;
            var wasFit = Math.abs(scale - fitScale) < 0.000001;
            fitScale = fit();
            resize(wasFit ? fitScale : scale, !wasFit);
        });
    }

    function open(source) {
        initialize();
        if (dialog.open) return;
        opener = source;
        caption.textContent = source.getAttribute('alt') || '图片预览';
        image.setAttribute('alt', source.getAttribute('alt') || '');
        canvas.hidden = true; status.hidden = false;
        status.textContent = '正在加载图片…';
        zoom.textContent = '-';
        zoomIn.disabled = zoomOut.disabled = fitButton.disabled = true;
        document.body.classList.add('image-viewer-open');
        dialog.showModal();
        closeButton.focus({ preventScroll: true });
        image.setAttribute('src', source.getAttribute('src'));
    }

    window.NotepadImages = {
        enhance: function (target) {
            var viewer = document.getElementById('image-viewer');
            if (!viewer || typeof viewer.showModal !== 'function') return;
            target.querySelectorAll('img').forEach(function (source) {
                if (enhanced.has(source) || source.closest('a')) return;
                var src = source.getAttribute('src');
                if (!src) return;
                try {
                    if (!/^https?:$/.test(new URL(src, window.location.origin).protocol)) return;
                } catch (_) { return; }
                enhanced.add(source);
                source.setAttribute('tabindex', '0');
                source.setAttribute('role', 'button');
                source.setAttribute('aria-haspopup', 'dialog');
                source.setAttribute('aria-label', (source.getAttribute('alt') || '图片') + '，查看大图');
                source.addEventListener('click', function (event) {
                    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                    event.preventDefault(); open(source);
                });
                source.addEventListener('keydown', function (event) {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault(); open(source);
                });
            });
        }
    };
})();
