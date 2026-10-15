(function (root, factory) {
    'use strict';
    var tools = factory();
    if (typeof module === 'object' && module.exports) module.exports = tools;
    else root.markdownTools = tools;
})(typeof window === 'object' ? window : this, function () {
    'use strict';

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
    return {outline: outline, table: table};
});
