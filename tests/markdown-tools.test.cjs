const test = require('node:test');
const assert = require('node:assert/strict');
const marked = require('../static/marked.min.js');
const tools = require('../static/markdown-tools.js');

test('outline ignores fenced and indented code, keeps real duplicate titles and setext headings', () => {
    const source = '# Start\n\n```md\n## Repeated\n```\n\n    ## code\n\n## Repeated\n\nText\n\n## Repeated\n\nEnding\n------\n';
    const headings = tools.outline(source, marked);
    assert.deepEqual(headings.map(h => [h.depth,h.text]), [[1,'Start'],[2,'Repeated'],[2,'Repeated'],[2,'Ending']]);
    assert.equal(headings[1].offset, source.indexOf('## Repeated', source.indexOf('    ## code')));
    assert.equal(headings[2].offset, source.lastIndexOf('## Repeated'));
    assert.equal(headings[3].offset, source.indexOf('Ending'));
    assert.equal(new Set(headings.map(h => h.id)).size,4);
});

test('outline includes headings in quotes and lists while ignoring code', () => {
    const source = '> ## Quoted\n>\n> ```\n> # not a heading\n> ```\n\n- ### Nested\n\n### Last\n';
    const result = tools.outline(source, marked);
    assert.deepEqual(result.map(h => h.text), ['Quoted','Nested','Last']);
    assert.equal(result[0].offset,0);
    assert.equal(result[1].offset,source.indexOf('- ### Nested'));
});

test('default table is GFM and renders a header with two body rows', () => {
    const html = marked.parse(tools.table(''));
    assert.match(html, /<table>/);
    assert.equal((html.match(/<th>/g)||[]).length,3);
    assert.equal((html.match(/<tr>/g)||[]).length,3);
});

test('selected spreadsheet text becomes a table and escapes pipes', () => {
    const table = tools.table('Name\tValue\nA|B\t42');
    assert.match(table,/A\\\|B/);
    assert.match(marked.parse(table),/<td>A\|B<\/td>/);
});

test('duplicate headings inside quoted code do not steal source positions', () => {
    const source = '> ```\n> ## Same\n> ```\n>\n> ## Same\n';
    const result = tools.outline(source,marked);
    assert.equal(result.length,1);
    assert.equal(result[0].offset,source.lastIndexOf('> ## Same'));
});

test('outline offsets retain the original CRLF line positions', () => {
    const source = '# One\r\n\r\n### Two\r\n';
    const result = tools.outline(source,marked);
    assert.equal(result[1].offset,source.indexOf('### Two'));
});
