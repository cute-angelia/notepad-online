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
    assert.match(html, /<table(?: [^>]*)?>/);
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

const renderBody = source => marked.parse(source);
const render = source => tools.renderMarkdown(source, renderBody);

const skill = '---\nname: park-hae-young-dialogue-polisher\ndescription: 克制、疏离，却藏着温柔与治愈的对白。\n---\n\n# 使用方法\n\n正文 **保持加粗**。\n';

test('SKILL front matter renders as a field/value table', () => {
    const html = render(skill);
    assert.match(html, /<table(?: [^>]*)?>/);
    assert.match(html, /<td>park-hae-young-dialogue-polisher<\/td>/);
    assert.match(html, /<td>克制、疏离/);
    assert.match(html, /<h1(?: [^>]*)?>使用方法<\/h1>/);
    assert.match(html, /<strong>保持加粗<\/strong>/);
    assert.doesNotMatch(html, /<hr|<h2/);
});

test('BOM, CRLF, nested YAML, multiline descriptions and end-of-file delimiter are preserved', () => {
    const source = '\uFEFF---\r\nname: test\r\ndescription: |\r\n  第一行\r\n  第二行\r\nmetadata:\r\n  tags: [dialogue, 中文]\r\n---';
    const html = render(source);
    assert.match(html, /<table(?: [^>]*)?>/);
    assert.match(html, /第一行(?:&#10;|\n)第二行/);
    assert.match(html, /tags[\s\S]*dialogue[\s\S]*中文/);
    assert.doesNotMatch(html, /<h[12]|<hr/);
});

test('ordinary Markdown, later separators and incomplete front matter stay unchanged', () => {
    for (const source of ['# 标题\n\n---\n\n正文', '---\n\n普通文本\n\n---\n', '---\nname: unfinished\n', '```yaml\nname: example\n```', '\n---\nname: not-at-start\n---']) {
        assert.equal(render(source), renderBody(source));
    }
});

test('YAML values remain literal inside table cells', () => {
    const html = render('---\nname: safe\ndescription: |\n  ```\n  ~~~~\n  <script>alert(1)</script>\n  # Not a heading\n---\n\n# Body');
    assert.equal((html.match(/<table(?: [^>]*)?>/g) || []).length, 1);
  assert.doesNotMatch(html, /<pre>|<code/);
    assert.doesNotMatch(html, /<script>|<h1>Not a heading/);
    assert.match(html, /(?:&lt;|&#60;)script(?:&gt;|&#62;)/);
    assert.match(html, /<h1(?: [^>]*)?>Body<\/h1>/);
});

test('outline excludes front matter headings and retains original body offsets', () => {
    const source = '\uFEFF---\r\nname: test\r\ndescription: |\r\n  # Not a heading\r\n---\r\n\r\n# Body\r\n\r\n## Next';
    const result = tools.outline(source, marked);
    assert.deepEqual(result.map(h => h.text), ['Body', 'Next']);
    assert.equal(result[0].offset, source.indexOf('# Body'));
    assert.equal(result[1].offset, source.indexOf('## Next'));
});


test('YAML types, folded descriptions and special characters are parsed safely', () => {
    const html = render('---\nname: "A | B"\nenabled: false\ncount: 0\ndescription: >\n  第一行\n  第二行\ntext: "**literal** <img src=x onerror=alert(1)>"\n---\n');
    assert.match(html, /A (?:\||&#124;) B/);
    assert.match(html, /<td>false<\/td>/);
    assert.match(html, /<td>0<\/td>/);
    assert.match(html, /第一行 第二行/);
    assert.doesNotMatch(html, /<img|<strong|<script/);
    assert.match(html, /(?:\*|&#42;){2}literal(?:\*|&#42;){2}/);
});

test('invalid YAML falls back to a visible code block while body still renders', () => {
    const html = render('---\nname: [broken\n---\n\n# Body');
    assert.match(html, /language-yaml/);
    assert.match(html, /name: \[broken/);
    assert.match(html, /<h1(?: [^>]*)?>Body<\/h1>/);
});


test('illustrator metadata renders nested tables and a clickable homepage', () => {
  const source = '---\nname: baoyu-article-illustrator\ndescription: Analyzes article structure, Type × Style × Palette.\nversion: 1.117.4\nmetadata:\n  openclaw:\n    homepage: https://github.com/JimLiu/baoyu-skills#baoyu-article-illustrator\n---\n\n# Body';
  const html = render(source);
  assert.match(html, /<table class="yaml-front-matter">/);
  assert.equal((html.match(/<table(?: [^>]*)?>/g) || []).length, 3);
  assert.match(html, /<th scope="row">metadata<\/th>/);
  assert.match(html, /<th>openclaw<\/th>/);
  assert.match(html, /<th>homepage<\/th>/);
  assert.match(html, /href="https:\/\/github.com\/JimLiu\/baoyu-skills#baoyu-article-illustrator"/);
  assert.match(html, /1\.117\.4/);
  assert.doesNotMatch(html, /&quot;openclaw&quot;|字段/);
  assert.match(html, /<h1(?: [^>]*)?>Body<\/h1>/);
});

test('arrays preserve their items and nested object structure', () => {
  const html = render('---\nname: demo\ntags: [first, second]\nauthors:\n  - name: Alice\n    active: false\n  - name: Bob\nempty: []\nmissing: null\n---');
  assert.match(html, /<table><tbody><tr><td>first<\/td><td>second<\/td><\/tr><\/tbody><\/table>/);
  assert.match(html, /<th>name<\/th>/);
  assert.match(html, /<td>Alice<\/td>/);
  assert.match(html, /<td>false<\/td>/);
  assert.match(html, /<td>\[\]<\/td>/);
  assert.match(html, /<td>null<\/td>/);
});

test('metadata HTML and unsafe URLs stay literal and cyclic aliases remain readable', () => {
  const html = render('---\nname: "<img src=x onerror=alert(1)>"\nurl: "javascript:alert(1)"\nmeta:\n  "<script>": "</td><script>alert(1)</script>"\n---');
  assert.doesNotMatch(html, /<img|<script|href="javascript:/);
  assert.match(html, /&lt;img/);
  const cyclic = render('---\nname: loop\nmeta: &ref\n  self: *ref\n---\n\n# Body');
  assert.match(cyclic, /language-yaml/);
  assert.match(cyclic, /<h1(?: [^>]*)?>Body<\/h1>/);
});


test('comic requirements render sibling columns and array cells at every nesting level', () => {
  const html = render('---\nname: baoyu-comic\nversion: 1.117.4\nmetadata:\n  openclaw:\n    homepage: https://github.com/JimLiu/baoyu-skills#baoyu-comic\n    requires:\n      anyBins:\n        - bun\n        - npx\n---');
  assert.equal((html.match(/<table(?: [^>]*)?>/g) || []).length, 5);
  assert.match(html, /<th>homepage<\/th><th>requires<\/th>/);
  assert.match(html, /<th>anyBins<\/th>/);
  assert.match(html, /<td>bun<\/td><td>npx<\/td>/);
  assert.match(html, /href="https:\/\/github.com\/JimLiu\/baoyu-skills#baoyu-comic"/);
  assert.doesNotMatch(html, /<ul>|&quot;anyBins&quot;/);
});
