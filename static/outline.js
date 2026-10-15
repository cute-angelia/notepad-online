(function () {
    'use strict';
    var sidebar = document.getElementById('document-outline');
    var list = document.getElementById('outline-list'), empty = document.getElementById('outline-empty');
    var textarea = document.getElementById('content');
    var entries = [], links = [], lastSource = null, lastTarget = null, observer;
    var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    function activate(index) {
        links.forEach(function (link, current) {
            if (current === index) link.setAttribute('aria-current', 'location');
            else link.removeAttribute('aria-current');
        });
    }
    function followSelection() {
        if (!textarea || !entries.length) return;
        var current = 0;
        entries.forEach(function (entry, index) {if (entry.offset <= textarea.selectionStart) current = index;});
        activate(current);
    }
    function scrollToSource(entry) {
        var offset = entry.offset, end = textarea.value.indexOf('\n', offset);
        textarea.focus({preventScroll: true});
        textarea.setSelectionRange(offset, end < 0 ? textarea.value.length : end);
        // A mirror accounts for wrapping; a line count would drift on long lines.
        var mirror = document.createElement('div'), style = window.getComputedStyle(textarea);
        Object.assign(mirror.style, {
            position: 'absolute', visibility: 'hidden', pointerEvents: 'none', left: '0', top: '0',
            width: textarea.getBoundingClientRect().width + 'px', boxSizing: 'border-box',
            whiteSpace: 'pre-wrap', overflowWrap: 'break-word', fontFamily: style.fontFamily,
            fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight,
            letterSpacing: style.letterSpacing, tabSize: style.tabSize, padding: style.padding
        });
        mirror.appendChild(document.createTextNode(textarea.value.slice(0, offset)));
        var marker = document.createElement('span'); marker.textContent = '\u200b'; mirror.appendChild(marker);
        document.body.appendChild(mirror);
        var mirrorTop = marker.offsetTop;
        mirror.remove();
        textarea.scrollTo({top: Math.max(0, mirrorTop - 32), behavior: reducedMotion.matches ? 'auto' : 'smooth'});
        var rect = textarea.getBoundingClientRect();
        if (rect.top < 0 || rect.bottom > window.innerHeight) {
            textarea.scrollIntoView({block: 'nearest', behavior: reducedMotion.matches ? 'auto' : 'smooth'});
        }
    }
    list.addEventListener('click', function (event) {
        var link = event.target.closest('a[data-outline-index]');
        if (!link) return;
        event.preventDefault();
        var index = Number(link.dataset.outlineIndex), entry = entries[index];
        activate(index);
        if (textarea) scrollToSource(entry);
        else {
            var heading = document.getElementById(entry.id);
            if (heading) heading.scrollIntoView({block: 'start', behavior: reducedMotion.matches ? 'auto' : 'smooth'});
            history.replaceState(null, '', '#' + entry.id);
        }
    });
    if (textarea) ['click', 'keyup', 'select'].forEach(function (name) {textarea.addEventListener(name, followSelection);});

    window.documentOutline = {
        update: function (source, target, markdown) {
            sidebar.hidden = !markdown;
            document.body.classList.toggle('has-outline', markdown);
            if (!markdown) {if (observer) observer.disconnect(); return;}
            if (source === lastSource && target === lastTarget) return;
            lastSource = source; lastTarget = target;
            if (observer) observer.disconnect();
            window.renderMarkdown(target, source);
            entries = window.markdownTools.outline(source, marked);
            var headings = Array.from(target.querySelectorAll('h1,h2,h3,h4,h5,h6'));
            var fragment = document.createDocumentFragment(); links = [];
            var minimum = entries.length ? Math.min.apply(null, entries.map(function (entry) {return entry.depth;})) : 1;
            entries.forEach(function (entry, index) {
                var heading = headings[index];
                if (heading) heading.id = entry.id;
                var item = document.createElement('li'), link = document.createElement('a');
                link.href = '#' + entry.id; link.dataset.outlineIndex = index;
                link.textContent = heading ? heading.textContent.trim() || '未命名标题' : entry.text;
                link.title = link.textContent;
                link.style.setProperty('--outline-indent', Math.min(48, (entry.depth - minimum) * 12) + 'px');
                item.appendChild(link); fragment.appendChild(item); links.push(link);
            });
            list.replaceChildren(fragment); empty.hidden = entries.length > 0;
            if (textarea) followSelection();
            else if (headings.length) {
                var selected = entries.findIndex(function (entry) {return '#' + entry.id === window.location.hash;});
                activate(Math.max(0, selected));
                if (selected >= 0) headings[selected].scrollIntoView({block: 'start'});
                if (typeof IntersectionObserver === 'function') {
                    observer = new IntersectionObserver(function (changes) {
                        var visible = changes.filter(function (change) {return change.isIntersecting;}).sort(function (a,b) {return a.boundingClientRect.top - b.boundingClientRect.top;});
                        if (visible.length) activate(headings.indexOf(visible[0].target));
                    }, {rootMargin: '0px 0px -65% 0px'});
                    headings.forEach(function (heading) {observer.observe(heading);});
                }
            }
        }
    };
})();
