/* Render Markdown through an allowlist before attaching it to the document. */
(function () {
    'use strict';
    var allowed = new Set('P BR HR H1 H2 H3 H4 H5 H6 STRONG EM DEL BLOCKQUOTE UL OL LI PRE CODE A IMG TABLE THEAD TBODY TR TH TD INPUT'.split(' '));
    function safeURL(value, image) {
        var clean = value.replace(/[\u0000-\u0020\u007f]/g, '');
        if (!clean) return false;
        try {
            var protocol = new URL(clean, window.location.origin).protocol;
            return protocol === 'https:' || protocol === 'http:' || (!image && protocol === 'mailto:');
        } catch (_) { return false; }
    }
    window.renderMarkdown = function (target, source) {
        var fragment = document.createElement('template');
        // Strip raw HTML as well as sanitizing generated nodes below.
        var renderer = new marked.Renderer();
        renderer.html = function (html) { return html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
        fragment.innerHTML = window.markdownTools.renderMarkdown(source, function (body) {return marked.parse(body, { renderer: renderer, gfm: true, breaks: false });});
        function sanitize(parent) {
            Array.from(parent.children).forEach(function (element) {
                if (!allowed.has(element.tagName)) { element.replaceWith(document.createTextNode(element.textContent)); return; }
                Array.from(element.attributes).forEach(function (attribute) {
                    var name = attribute.name, tag = element.tagName;
                    var keep = (tag === 'A' && (name === 'href' || name === 'title')) ||
                        (tag === 'IMG' && (name === 'src' || name === 'alt' || name === 'title')) ||
                        (tag === 'OL' && name === 'start' && /^\d+$/.test(attribute.value)) ||
                        (tag === 'TABLE' && name === 'class' && attribute.value === 'yaml-front-matter') ||
                        (tag === 'TH' && name === 'scope' && attribute.value === 'row') ||
                        (tag === 'CODE' && name === 'class' && /^language-[\w-]+$/.test(attribute.value)) ||
                        (tag === 'INPUT' && (name === 'checked' || name === 'disabled' || (name === 'type' && attribute.value === 'checkbox')));
                    if (!keep) element.removeAttribute(name);
                });
                if (element.tagName === 'A') {
                    if (!safeURL(element.getAttribute('href') || '', false)) element.removeAttribute('href');
                    element.setAttribute('target', '_blank'); element.setAttribute('rel', 'noopener noreferrer');
                }
                if (element.tagName === 'IMG') {
                    if (!safeURL(element.getAttribute('src') || '', true)) element.removeAttribute('src');
                    element.setAttribute('loading', 'lazy'); element.setAttribute('referrerpolicy', 'no-referrer');
                }
                if (element.tagName === 'INPUT') { element.setAttribute('type', 'checkbox'); element.disabled = true; }
                sanitize(element);
            });
        }
        sanitize(fragment.content);
        target.replaceChildren(fragment.content);
    };
})();
