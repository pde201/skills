const fs = require('fs');
const path = require('path');

const mdPath = process.argv[2] || 'walkthrough.md';
const htmlPath = process.argv[3] || 'docs/walkthrough.html';

if (!fs.existsSync(mdPath)) {
  console.error(`❌ Error: Markdown file not found at ${mdPath}`);
  process.exit(1);
}

const md = fs.readFileSync(mdPath, 'utf8');

const escapeHtml = text => text
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// Inline markup on already-escaped text; code spans are protected first.
function inline(text) {
  const spans = [];
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, (_, code) => `\u0000${spans.push(code) - 1}\u0000`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|[^\s):]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${spans[i]}</code>`);
}

// Line-based Markdown subset: headings, fenced code, lists, rules, paragraphs.
function render(source) {
  const out = [];
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let para = [];
  let list = null;

  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map(item => `<li>${inline(item)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match;
    if (/^\s*```/.test(line)) {
      flushPara(); flushList();
      const code = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
    } else if ((match = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushPara(); flushList();
      out.push(`<h${match[1].length}>${inline(match[2])}</h${match[1].length}>`);
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara(); flushList();
      out.push('<hr>');
    } else if ((match = line.match(/^\s*(?:([-*+])|\d+[.)])\s+(.*)$/))) {
      flushPara();
      const tag = match[1] ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push(match[2]);
    } else if (!line.trim()) {
      flushPara(); flushList();
    } else if (list && /^\s+\S/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara(); flushList();
  return out.join('\n');
}

const html = render(md);
const heading = md.match(/^#\s+(.*)$/m);
const title = escapeHtml(heading ? heading[1].replace(/[`*]/g, '') : 'Walkthrough Report');

// Wrap in responsive layout template
const template = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root {
      --bg: oklch(0.98 0.006 82.5);
      --ink: oklch(0.13 0.006 82.5);
      --muted: oklch(0.50 0.009 82.5);
      --line: oklch(0.86 0.010 82.5);
      --panel: oklch(0.995 0.003 82.5);
      --soft: oklch(0.94 0.009 82.5);
      --accent: oklch(0.62 0.16 38);
      --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font: 15px/1.6 var(--sans);
      padding: 40px 16px 80px;
    }
    .page {
      max-width: 880px;
      margin: 0 auto;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 40px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.02);
    }
    h1, h2, h3 { line-height: 1.2; margin: 0 0 16px; font-weight: 750; letter-spacing: -0.02em; }
    h1 { font-size: 32px; border-bottom: 2px solid var(--line); padding-bottom: 12px; }
    h2 { font-size: 22px; margin-top: 32px; border-bottom: 1px solid var(--line); padding-bottom: 8px; }
    h3 { font-size: 16px; margin-top: 24px; }
    p { margin: 0 0 16px; color: var(--ink); }
    ul { margin: 0 0 20px; padding-left: 20px; }
    li { margin-bottom: 8px; }
    code { font-family: var(--mono); background: var(--soft); padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
    pre {
      overflow-x: auto;
      background: var(--soft);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      margin: 0 0 20px;
    }
    pre code { background: none; padding: 0; }
    ol { margin: 0 0 20px; padding-left: 24px; }
    a { color: var(--accent); }
    hr { border: 0; border-top: 1px solid var(--line); margin: 32px 0; }
  </style>
</head>
<body>
  <main class="page">
    ${html}
  </main>
</body>
</html>`;

fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
fs.writeFileSync(htmlPath, template);
console.log(`✅ Successfully generated HTML walkthrough at ${htmlPath}`);
