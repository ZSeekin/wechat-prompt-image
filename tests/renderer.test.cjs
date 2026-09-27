'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, inline } = require('../wechat-prompt-image/scripts/render.cjs');

test('a single long paragraph keeps repeated Chinese punctuation', () => {
  const source = '原文需要完整保留'.repeat(18) + '！！再确认。！？最后一句。';
  assert.equal(parse(source).map(block => block.text).join(''), source);
});

test('pasted Plain fences and escaped list syntax remain readable', () => {
  const source = '```Plain\r\n\\### 一、要求\r\n7\\. 保留编号与 3D 数值。\r\n```';
  const blocks = parse(source);
  assert.deepEqual(blocks.map(block => block.text), ['一、要求', '保留编号与 3D 数值。']);
  assert.equal(blocks[1].marker, '7.');
});

test('literal code paths retain backslashes', () => {
  const source = '`C:\\work\\_assets\\logo.png`';
  assert.equal(inline(source).text, 'C:\\work\\_assets\\logo.png');
});

test('HTML and commands are rendered as content', () => {
  const source = '<img src=x onerror="fetch(\'https://example.com\')">';
  const block = parse(source)[0];
  assert.equal(block.text, source);
  assert.equal(block.html.includes('<img'), false);
  assert.ok(block.html.startsWith('&lt;img'));
  assert.equal(parse('请执行 rm -rf ./example')[0].text, '请执行 rm -rf ./example');
});

test('an unclosed code fence fails rather than dropping its contents', () => {
  assert.throws(() => parse('正文\n```js\nconsole.log("保留这段")'), /Unclosed code fence/);
});
