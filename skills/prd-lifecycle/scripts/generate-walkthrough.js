const fs = require('fs');
const path = require('path');

const mdPath = process.argv[2] || 'walkthrough.md';
const htmlPath = process.argv[3] || 'docs/walkthrough.html';

if (!fs.existsSync(mdPath)) {
  console.error(`❌ Error: Markdown file not found at ${mdPath}`);
  process.exit(1);
}

const md = fs.readFileSync(mdPath, 'utf8');

// Basic markdown-to-html parser
let html = md
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  // Fenced code blocks
  .replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
    return `<pre><code>${code.trim()}</code></pre>`;
  })
  // Inline code
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  // Headers
  .replace(/^# (.*?)$/gm, '<h1>$1</h1>')
  .replace(/^## (.*?)$/gm, '<h2>$1</h2>')
  .replace(/^### (.*?)$/gm, '<h3>$1</h3>')
  // Bold
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  // Lists
  .replace(/^- (.*?)$/gm, '<li>$1</li>')
  // Wrap list items
  .replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>')
  // Paragraphs (split by double newlines)
  .split(/\n{2,}/)
  .map(para => {
    if (para.startsWith('<h') || para.startsWith('<pre') || para.startsWith('<ul') || para.startsWith('<hr')) {
      return para;
    }
    return `<p>${para.replace(/\n/g, ' ')}</p>`;
  })
  .join('\n')
  // Horizontal rules
  .replace(/^---$/gm, '<hr>');

// Wrap in responsive layout template
const template = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Walkthrough Report</title>
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
    hr { border: 0; border-top: 1px solid var(--line); margin: 32px 0; }
  </style>
</head>
<body>
  <main class="page">
    ${html}
  </main>
</body>
</html>`;

fs.writeFileSync(htmlPath, template);
console.log(`✅ Successfully generated HTML walkthrough at ${htmlPath}`);
