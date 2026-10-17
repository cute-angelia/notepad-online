(function (root, factory) {
    'use strict';
    var tools = factory(typeof module === 'object' && module.exports ? require('./js-yaml.min.js') : root.jsyaml);
    if (typeof module === 'object' && module.exports) module.exports = tools;
    else root.markdownTools = tools;
})(typeof window === 'object' ? window : this, function (yaml) {
    'use strict';

    function frontMatter(source) {
        var match = source.match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
        return match && /^[^\s#][^:\r\n]*:/m.test(match[1]) ? match[0] : '';
    }

    function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, (char) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[char]));
    }
    function metadataValue(value, parents = []) {
        if (value !== null && typeof value === 'object') {
            if (parents.includes(value) || parents.length >= 20) {
                throw new Error('Recursive YAML metadata');
            }
            const next = [...parents, value];
            if (Array.isArray(value)) {
                if (!value.length)
                    return '[]';
                return '<table><tbody><tr>' + value.map((item) => '<td>' + metadataValue(item, next) + '</td>').join('') + '</tr></tbody></table>';
            }
            const entries = Object.entries(value);
            if (!entries.length)
                return '{}';
            return '<table><thead><tr>' + entries.map(([key]) => '<th>' + escapeHtml(key) + '</th>').join('') +
                '</tr></thead><tbody><tr>' + entries.map(([, item]) => '<td>' + metadataValue(item, next) + '</td>').join('') +
                '</tr></tbody></table>';
        }
        const text = escapeHtml(value);
        if (typeof value === 'string' && /^(https?:\/\/|mailto:)\S+$/i.test(value)) {
            return '<a href="' + text + '" target="_blank" rel="noopener noreferrer">' + text + '</a>';
        }
        return text;
    }
    /** Render metadata separately so user Markdown never needs raw HTML enabled. */
    function renderMarkdown(source, renderBody) {
        const match = source.match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
        if (!match || !/^[^\s#][^:\r\n]*:/m.test(match[1]))
            return renderBody(source);
        try {
            const data = yaml.load(match[1], { schema: yaml.JSON_SCHEMA });
            if (!data || typeof data !== 'object' || Array.isArray(data))
                return renderBody(source);
            const entries = Object.entries(data);
            if (!entries.length)
                return renderBody(source);
            const rows = entries.map(([key, value]) => '<tr><th scope="row">' + escapeHtml(key) + '</th><td>' + metadataValue(value, [data]) + '</td></tr>');
            const table = '<table class="yaml-front-matter"><tbody>' + rows.join('') + '</tbody></table>';
            return table + '\n' + renderBody(source.slice(match[0].length));
        }
        catch {
            // Preserve malformed YAML or recursive aliases as readable source.
        }
        const header = match[0].replace(/^\uFEFF/, '').replace(/\r?\n$/, '');
        const runs = header.match(/\x60+/g) || [];
        const length = runs.reduce((size, run) => Math.max(size, run.length + 1), 3);
        const fence = '`'.repeat(length);
        return renderBody(fence + 'yaml\n' + header + '\n' + fence + '\n\n' + source.slice(match[0].length));
    }

    // Map container text (quotes/list items) back to the original source lines.
    function project(text, raw, offsets) {
        var map = [], cursor = 0;
        text.split('\n').forEach(function (line, index, lines) {
            var start = line ? raw.indexOf(line, cursor) : raw.indexOf('\n', cursor);
            if (start < 0) start = cursor;
            for (var i = 0; i < line.length; i++) map.push(offsets[start + i]);
            var newline = raw.indexOf('\n', start + line.length);
            if (index < lines.length - 1) map.push(offsets[newline < 0 ? start + line.length : newline]);
            cursor = newline < 0 ? start + line.length : newline + 1;
        });
        map.push(offsets[offsets.length - 1]);
        return map;
    }

    function outline(source, parser) {
        var normalized = [], offsets = [], headings = [];
        for (var i = 0; i < source.length; i++) {
            offsets.push(i);
            if (source[i] === '\r') {
                normalized.push('\n');
                if (source[i + 1] === '\n') i++;
            } else normalized.push(source[i]);
        }
        offsets.push(source.length);
        var text = normalized.join('');
        var prefix = frontMatter(text);
        // Mask the header without changing source offsets used by the editor.
        text = prefix.replace(/[^\n]/g, ' ') + text.slice(prefix.length);
        function walk(tokens, container, map) {
            var cursor = 0;
            tokens.forEach(function (token) {
                var raw = token.raw || '', start = container.indexOf(raw, cursor);
                if (start < 0) start = cursor;
                var tokenMap = map.slice(start, start + raw.length + 1);
                if (token.type === 'heading') {
                    var position = map[start] || 0;
                    headings.push({depth: token.depth, text: token.text, offset: position === 0 ? 0 : Math.max(source.lastIndexOf('\n', position - 1), source.lastIndexOf('\r', position - 1)) + 1, id: 'document-section-' + (headings.length + 1)});
                } else if (token.type === 'blockquote') {
                    walk(token.tokens, token.text, project(token.text, raw, tokenMap));
                } else if (token.type === 'list') {
                    var itemCursor = 0;
                    token.items.forEach(function (item) {
                        var itemStart = raw.indexOf(item.raw, itemCursor);
                        if (itemStart < 0) itemStart = itemCursor;
                        walk(item.tokens, item.text, project(item.text, item.raw, tokenMap.slice(itemStart, itemStart + item.raw.length + 1)));
                        itemCursor = itemStart + item.raw.length;
                    });
                }
                cursor = start + raw.length;
            });
        }
        walk(parser.lexer(text), text, offsets);
        return headings;
    }

    function table(selection) {
        var rows = selection.trim() && selection.includes('\t') ? selection.trim().split(/\r?\n/).map(function (line) {return line.split('\t');}) : [ ['列 1', '列 2', '列 3'], ['内容', '内容', '内容'], ['内容', '内容', '内容'] ];
        var columns = Math.max.apply(null, rows.map(function (row) {return row.length;}));
        function row(cells) {
            return '| ' + Array.from({length: columns}, function (_, index) {return (cells[index] || '').replace(/\|/g, '\\|');}).join(' | ') + ' |';
        }
        var lines = [row(rows[0]), row(Array(columns).fill('---'))];
        rows.slice(1).forEach(function (cells) {lines.push(row(cells));});
        if (rows.length === 1) lines.push(row([]));
        return lines.join('\n') + '\n';
    }
    return {outline: outline, table: table, renderMarkdown: renderMarkdown};
});
