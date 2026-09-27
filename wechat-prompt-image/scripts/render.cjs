#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const HELP = `Render one complete prompt as one branded landscape PNG (offline).

Usage:
  node scripts/render.cjs --input prompt.md --title "提示词标题" --output poster.png

Options:
  --author NAME                Default: 路人甲
  --avatar FILE                Default: assets/lurenjia-ip.png (local PNG/JPEG/WebP)
  --browser-executable FILE    Use a specific Chromium/Chrome executable
  --columns auto|1..16         Default: auto; column order is left to right
  --scale NUMBER               PNG pixel ratio, 1..3; default: 2
  --help                      Show this help

Also writes poster.html (self-contained) and poster.check.json. No prompt commands
or embedded HTML are executed. Requires Node.js 20+ and the playwright package.
`;

function args(argv) {
  const out = {};
  const valid = new Set(['input', 'title', 'output', 'author', 'avatar', 'browser-executable', 'columns', 'scale']);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') return { help: true };
    if (!argv[i].startsWith('--') || !valid.has(argv[i].slice(2))) throw new Error(`Unknown option: ${argv[i]}`);
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${argv[i]}`);
    out[argv[i].slice(2)] = argv[++i];
  }
  for (const name of ['input', 'title', 'output']) if (!out[name]) throw new Error(`--${name} is required. Use --help.`);
  if (!out.title.trim()) throw new Error('--title must not be empty.');
  if (!/\.png$/i.test(out.output)) throw new Error('--output must end in .png.');
  out.columns = out.columns === undefined || out.columns === 'auto' ? null : Number(out.columns);
  if (out.columns !== null && (!Number.isInteger(out.columns) || out.columns < 1 || out.columns > 16)) throw new Error('--columns must be auto or an integer from 1 to 16.');
  out.scale = out.scale === undefined ? 2 : Number(out.scale);
  if (!Number.isFinite(out.scale) || out.scale < 1 || out.scale > 3) throw new Error('--scale must be between 1 and 3.');
  return out;
}

const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
const normalize = text => text.replace(/\s+/gu, '');

// This intentionally small formatter never interprets HTML, links, or images.
// Unsupported Markdown remains literal instead of disappearing.
function inline(raw) {
  let html = '', text = '';
  for (let i = 0; i < raw.length;) {
    if (raw[i] === '\\' && i + 1 < raw.length && /[\\`*_{}\[\]()#+\-.!]/.test(raw[i + 1])) {
      text += raw[i + 1]; html += escape(raw[i + 1]); i += 2; continue;
    }
    const delimiter = raw[i] === '`' ? '`' : raw.startsWith('**', i) ? '**' : null;
    if (delimiter) {
      const end = raw.indexOf(delimiter, i + delimiter.length);
      if (end > i + delimiter.length) {
        const content = raw.slice(i + delimiter.length, end);
        // Code spans preserve every byte, including literal backslashes.
        const decoded = delimiter === '`' ? content : content.replace(/\\([\\`*_{}\[\]()#+\-.!])/g, '$1');
        text += decoded;
        html += `<${delimiter === '`' ? 'code' : 'strong'}>${escape(decoded)}</${delimiter === '`' ? 'code' : 'strong'}>`;
        i = end + delimiter.length; continue;
      }
    }
    text += raw[i]; html += escape(raw[i]); i++;
  }
  return { text, html };
}

function parse(source) {
  let prepared = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  const lines = prepared.split('\n');
  const outer = lines[0]?.match(/^\s*(`{3,}|~{3,})(?:plain|text|txt|markdown|md)?\s*$/i);
  if (outer && lines.length > 1 && lines.at(-1).trim() === outer[1]) {
    prepared = lines.slice(1, -1).join('\n');
  }
  const blocks = [];
  let codeFence = null, code = [];
  const add = (type, raw, extra = {}) => {
    const formatted = type === 'code' ? { text: raw, html: escape(raw) } : inline(raw);
    blocks.push({ id: blocks.length, type, raw, ...formatted, ...extra });
  };
  for (const originalLine of prepared.split('\n')) {
    const fence = originalLine.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (codeFence) {
      if (fence && fence[1][0] === codeFence[0] && fence[1].length >= codeFence.length && !fence[2].trim()) {
        add('code', code.join('\n')); code = []; codeFence = null;
      } else code.push(originalLine);
      continue;
    }
    if (fence) { codeFence = fence[1]; code = []; continue; }
    const line = originalLine.replace(/^(\s*)\\(?=#{1,6}\s)/, '$1').replace(/^(\s*\d+)\\\.(?=\s)/, '$1.');
    if (!line.trim()) continue;
    if (/^\s*(?:-{3,}|\*{3,}|_{3,}|\\-{3,})\s*$/.test(line)) { add('separator', ''); continue; }
    const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
    if (heading) { add('heading', heading[2], { level: heading[1].length }); continue; }
    const ordered = line.match(/^(\s*)(\d+[.)])\s+(.*)$/);
    if (ordered) { add('list', ordered[3], { marker: ordered[2], indent: Math.floor(ordered[1].length / 2) }); continue; }
    const bullet = line.match(/^(\s*)([-+*])\s+(.*)$/);
    if (bullet) { add('list', bullet[3], { marker: bullet[2], indent: Math.floor(bullet[1].length / 2) }); continue; }
    // Breaking a prose paragraph at sentence boundaries changes layout only.
    const sentences = line.match(/[^。！？]*[。！？]+[”’」』]?|[^。！？]+$/gu) || [line];
    if (sentences.join('') !== line) throw new Error('Sentence layout did not conserve source text.');
    if (line.length > 110 && sentences.length > 1 && !/[`*]/.test(line)) {
      for (const sentence of sentences) if (sentence.trim()) add('paragraph', sentence.trim());
    } else add('paragraph', line.trim());
  }
  if (codeFence) throw new Error('Unclosed code fence. Close it before rendering; source content was not discarded.');
  if (!blocks.some(block => block.text)) throw new Error('Input has no visible prompt content.');
  return blocks;
}

function blockHTML(block, short, index) {
  const source = `<span class="source-text" data-source-id="${block.id}">${block.html}</span>`;
  if (block.type === 'heading') return `<h2 class="block" data-id="${block.id}">${source}</h2>`;
  if (block.type === 'separator') return `<hr class="block separator" data-id="${block.id}">`;
  if (block.type === 'code') return `<pre class="block code-block" data-id="${block.id}">${source}</pre>`;
  if (block.type === 'list') return `<div class="block list-item" data-id="${block.id}" style="--indent:${block.indent}"><span class="number source-marker" data-marker-id="${block.id}">${escape(block.marker)}</span>${source}</div>`;
  return `<div class="block paragraph" data-id="${block.id}">${short ? `<span class="number" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span>` : ''}${source}</div>`;
}

function optionsFor(columns) {
  const short = columns === 1, width = short ? 1200 : Math.max(1440, columns * 480);
  return {
    short, width, columns,
    labelSize: Math.round(width / 30),
    bodySize: short ? 25 : 17.5,
    bodyLine: short ? 1.72 : 1.62,
    titleSize: short ? 49 : 56,
    headingSize: short ? 30 : 23,
    avatarSize: short ? 140 : 180,
    identityWidth: short ? 166 : 210,
    authorSize: short ? 20 : 26,
  };
}

function documentHTML({ source, blocks, css, title, author, avatar, options }) {
  const o = options;
  const variables = {
    width: `${o.width}px`, columns: o.columns, 'label-size': `${o.labelSize}px`,
    'label-pad-x': `${o.short ? 20 : Math.max(24, o.labelSize / 3)}px`, 'label-pad-y': `${o.short ? 10 : o.labelSize / 6}px`,
    'square-size': `${Math.round(o.labelSize * .175)}px`, 'body-size': `${o.bodySize}px`, 'body-line': o.bodyLine,
    'title-size': `${o.titleSize}px`, 'heading-size': `${o.headingSize}px`, 'avatar-size': `${o.avatarSize}px`,
    'identity-width': `${o.identityWidth}px`, 'author-size': `${o.authorSize}px`,
  };
  const vars = Object.entries(variables).map(([key, value]) => `--${key}:${value}`).join(';');
  return `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; script-src 'none'; base-uri 'none'; form-action 'none'"><title>${escape(title)} · ${escape(author)}提示词</title><style>${css}</style></head><body class="${o.short ? 'short' : 'long'}"><main class="poster" style="${vars}" aria-label="${escape(author)}：${escape(title)}完整提示词"><header><div class="heading"><div><div class="topline"><span class="prompt-label"><span class="square" aria-hidden="true"></span>提示词</span><span class="tag">PROMPT</span></div><h1>${escape(title)}</h1><div class="subtitle">完整提示词${o.short ? '' : '　｜　从左至右，逐栏阅读'}</div></div><figure class="identity"><img class="ip-image" src="${avatar}" alt="${escape(author)} IP 形象"><figcaption class="author">${escape(author)}</figcaption></figure></div><div class="rule" aria-hidden="true"></div></header><div class="columns"><div class="column">${blocks.map((b, i) => blockHTML(b, o.short, i)).join('')}</div></div><div class="footline" aria-hidden="true"></div></main><template id="original-source" data-encoding="base64">${Buffer.from(source).toString('base64')}</template></body></html>`;
}

function browserPaths() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) candidates.push(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
  if (process.platform === 'darwin') candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  if (process.platform === 'linux') candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/google/chrome/chrome');
  if (process.platform === 'win32') for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean)) candidates.push(path.join(base, 'Google/Chrome/Application/chrome.exe'), path.join(base, 'Microsoft/Edge/Application/msedge.exe'));
  return candidates.filter(candidate => fsSync.existsSync(candidate));
}

async function avatarData(file) {
  const data = await fs.readFile(file);
  const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
  const type = types[path.extname(file).toLowerCase()];
  if (!type) throw new Error('--avatar must be a local PNG, JPEG, or WebP file.');
  return `data:${type};base64,${data.toString('base64')}`;
}

// Partition contiguous groups by measured heights; source order cannot change.
function partition(groups, count) {
  if (groups.length <= count) return groups.map(group => [group]);
  const prefix = [0];
  for (const group of groups) prefix.push(prefix.at(-1) + group.height);
  const dp = Array.from({ length: count + 1 }, () => Array(groups.length + 1).fill(Infinity));
  const cut = Array.from({ length: count + 1 }, () => Array(groups.length + 1).fill(0));
  dp[0][0] = 0;
  for (let k = 1; k <= count; k++) for (let end = k; end <= groups.length; end++) for (let start = k - 1; start < end; start++) {
    const cost = Math.max(dp[k - 1][start], prefix[end] - prefix[start]);
    if (cost < dp[k][end]) { dp[k][end] = cost; cut[k][end] = start; }
  }
  const result = []; let end = groups.length;
  for (let k = count; k > 0; k--) { const start = cut[k][end]; result.unshift(groups.slice(start, end)); end = start; }
  return result;
}

async function balance(page, blocks, count) {
  if (count === 1) return;
  let main = blocks, intro = [];
  const firstHeading = blocks.findIndex(block => block.type === 'heading');
  if (firstHeading > 0 && firstHeading <= 9 && blocks.slice(0, firstHeading).every(block => block.type === 'paragraph')) {
    intro = blocks.slice(0, firstHeading); main = blocks.slice(firstHeading);
  }
  // The first column is made as narrow as later columns during measurement.
  const heights = await page.evaluate(() => {
    const column = document.querySelector('.column'); column.style.paddingLeft = '24px';
    return [...column.children].map(el => ({ id: Number(el.dataset.id), height: el.getBoundingClientRect().height + parseFloat(getComputedStyle(el).marginTop) + parseFloat(getComputedStyle(el).marginBottom) }));
  });
  const byId = new Map(heights.map(entry => [entry.id, entry.height]));
  let groups = [];
  for (const block of main) {
    if (block.type === 'heading' || !groups.length) groups.push({ ids: [], height: 0 });
    groups.at(-1).ids.push(block.id); groups.at(-1).height += byId.get(block.id);
  }
  const target = main.reduce((sum, b) => sum + byId.get(b.id), 0) / count;
  const split = [];
  for (const group of groups) {
    if (group.height <= target * 1.2 && groups.length >= count) { split.push(group); continue; }
    let chunk = { ids: [], height: 0 };
    for (const id of group.ids) {
      const previous = blocks[chunk.ids.at(-1)];
      if (chunk.ids.length && chunk.height + byId.get(id) > target && previous.type !== 'heading') { split.push(chunk); chunk = { ids: [], height: 0 }; }
      chunk.ids.push(id); chunk.height += byId.get(id);
    }
    if (chunk.ids.length) split.push(chunk);
  }
  const columns = partition(split, count).map(column => column.flatMap(group => group.ids));
  await page.evaluate(({ columns, intro, count }) => {
    const root = document.querySelector('.columns');
    const elements = new Map([...root.querySelectorAll('[data-id]')].map(el => [Number(el.dataset.id), el]));
    if (intro.length) {
      const wrapper = document.createElement('div'); wrapper.className = 'intro';
      const parts = Math.min(3, count, intro.length); wrapper.style.setProperty('--intro-columns', parts);
      const size = Math.ceil(intro.length / parts);
      for (let i = 0; i < intro.length; i += size) {
        const part = document.createElement('div'); part.className = 'intro-part';
        for (const id of intro.slice(i, i + size)) part.append(elements.get(id));
        wrapper.append(part);
      }
      root.before(wrapper);
    }
    root.replaceChildren();
    root.style.setProperty('--columns', columns.length);
    columns.forEach((ids, index) => {
      const column = document.createElement('div'); column.className = 'column';
      const label = document.createElement('div'); label.className = 'column-label'; label.setAttribute('aria-hidden', 'true'); label.textContent = String(index + 1).padStart(2, '0'); column.append(label);
      for (const id of ids) column.append(elements.get(id));
      root.append(column);
    });
  }, { columns, intro: intro.map(block => block.id), count });
}

async function inspect(page, blocks, source, options) {
  const result = await page.evaluate(() => {
    const poster = document.querySelector('.poster'), bounds = poster.getBoundingClientRect();
    const texts = [...document.querySelectorAll('[data-source-id]')].map(el => ({ id: Number(el.dataset.sourceId), text: el.textContent }));
    const markers = [...document.querySelectorAll('[data-marker-id]')].map(el => ({ id: Number(el.dataset.markerId), text: el.textContent }));
    const overflow = [...poster.querySelectorAll('.block, h1, .identity, .prompt-label, .source-text')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.left < bounds.left - .5 || r.right > bounds.right + .5 || r.bottom > bounds.bottom + .5 || el.scrollWidth > el.clientWidth + 2;
    }).map(el => ({ text: el.textContent.slice(0, 160), className: el.className }));
    const label = document.querySelector('.prompt-label').getBoundingClientRect();
    const title = document.querySelector('h1').getBoundingClientRect();
    const avatar = document.querySelector('.identity').getBoundingClientRect();
    const image = document.querySelector('.ip-image');
    return {
      texts, markers, overflow, width: bounds.width, height: Math.ceil(bounds.height),
      columns: document.querySelectorAll('.column').length,
      headerFits: label.bottom <= title.top && label.right < avatar.left && title.right < avatar.left,
      avatarLoaded: image.complete && image.naturalWidth > 0,
      promptLabelSize: parseFloat(getComputedStyle(document.querySelector('.prompt-label')).fontSize),
      author: document.querySelector('.author').textContent,
      originalSource: document.querySelector('#original-source').content.textContent,
    };
  });
  result.originalSource = Buffer.from(result.originalSource, 'base64').toString('utf8');
  const expected = blocks.filter(block => block.type !== 'separator').map(block => ({ id: block.id, text: block.text }));
  const expectedMarkers = blocks.filter(block => block.type === 'list').map(block => ({ id: block.id, text: block.marker }));
  const actualText = result.texts.map(entry => entry.text).join('\n');
  const report = {
    sourceSHA256: sha256(source), storedSourceSHA256: sha256(result.originalSource),
    exactSourceStored: source === result.originalSource,
    exactDisplayBlocks: JSON.stringify(expected) === JSON.stringify(result.texts),
    exactListMarkers: JSON.stringify(expectedMarkers) === JSON.stringify(result.markers),
    expectedDisplaySHA256: sha256(normalize(expected.map(entry => entry.text).join('\n'))),
    renderedDisplaySHA256: sha256(normalize(actualText)),
    textBlocks: expected.length, listItems: expectedMarkers.length,
    width: result.width, height: result.height, columns: result.columns,
    landscape: result.width > result.height, aspectRatio: Number((result.width / result.height).toFixed(3)),
    labelSize: result.promptLabelSize, author: result.author,
    headerFits: result.headerFits, avatarLoaded: result.avatarLoaded, overflow: result.overflow,
    notes: ['Only Markdown presentation syntax and layout whitespace are normalized.', 'Unsupported Markdown is displayed literally; source text is embedded in the HTML.'],
  };
  report.ok = report.exactSourceStored && report.exactDisplayBlocks && report.exactListMarkers && report.landscape && report.headerFits && report.avatarLoaded && !report.overflow.length;
  return report;
}

async function main() {
  const cli = args(process.argv.slice(2));
  if (cli.help) { console.log(HELP); return; }
  let chromium;
  try { ({ chromium } = require('playwright')); } catch { throw new Error('Missing playwright. Install it with npm install playwright, or expose an existing installation through NODE_PATH.'); }
  const source = await fs.readFile(path.resolve(cli.input), 'utf8');
  const blocks = parse(source);
  const output = path.resolve(cli.output), stem = output.replace(/\.png$/i, '');
  const htmlPath = `${stem}.html`, checkPath = `${stem}.check.json`;
  if ([output, htmlPath, checkPath].includes(path.resolve(cli.input))) throw new Error('Output paths must not overwrite the input file.');
  const css = await fs.readFile(path.join(__dirname, '../assets/template.css'), 'utf8');
  const avatar = await avatarData(cli.avatar ? path.resolve(cli.avatar) : path.join(__dirname, '../assets/lurenjia-ip.png'));
  const author = cli.author === undefined ? '路人甲' : cli.author;
  if (!author.trim()) throw new Error('--author must not be empty.');
  const launch = { headless: true };
  if (cli['browser-executable']) launch.executablePath = path.resolve(cli['browser-executable']);
  else if (fsSync.existsSync(chromium.executablePath())) launch.executablePath = chromium.executablePath();
  else launch.executablePath = browserPaths()[0];
  let browser;
  try { browser = await chromium.launch(launch); } catch (error) { throw new Error(`Could not launch Chromium. Install it with npx playwright install chromium, or use --browser-executable.\n${error.message}`); }
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, deviceScaleFactor: cli.scale });
    const runtimeErrors = [], networkRequests = [];
    page.on('pageerror', error => runtimeErrors.push(error.message));
    await page.route('**/*', route => { networkRequests.push(route.request().url()); return route.abort(); });
    const size = blocks.reduce((sum, b) => sum + b.text.length, 0);
    let columns = cli.columns || (size <= 950 && blocks.filter(b => b.type === 'heading').length <= 3 ? 1 : Math.max(2, Math.min(16, Math.ceil(Math.sqrt(size / 220)))));
    let report;
    for (;;) {
      const options = optionsFor(columns);
      await page.setViewportSize({ width: options.width, height: 1000 });
      await page.setContent(documentHTML({ source, blocks, css, title: cli.title, author, avatar, options }), { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      await balance(page, blocks, columns);
      report = await inspect(page, blocks, source, options);
      if (report.width >= report.height * 1.25 || cli.columns || columns >= 16) break;
      columns = columns === 1 ? 2 : columns + 1;
    }
    report.runtimeErrors = runtimeErrors;
    report.externalRequests = networkRequests;
    report.ok = report.ok && !runtimeErrors.length && !networkRequests.length;
    report.pixelWidth = Math.round(report.width * cli.scale); report.pixelHeight = Math.round(report.height * cli.scale);
    if (report.pixelWidth > 32760 || report.pixelHeight > 32760) { report.ok = false; report.notes.push('Image dimensions exceed the conservative Chromium capture limit; reduce --scale.'); }
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(checkPath, `${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) throw new Error(`Validation failed; see ${checkPath}. ${!report.landscape ? 'Increase --columns or shorten an unusually long title.' : ''} No new PNG was exported.`);
    const html = await page.content();
    await fs.writeFile(htmlPath, `${html}\n`);
    await page.locator('.poster').screenshot({ path: output });
    console.log(JSON.stringify({ png: output, html: htmlPath, check: checkPath, columns: report.columns, pixels: [report.pixelWidth, report.pixelHeight], ok: report.ok }, null, 2));
  } finally { await browser.close(); }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { parse, inline, partition, optionsFor, documentHTML };
