# Recipes

Use these small patterns inside a self-contained HTML artifact. Adapt names, labels, and output formats to the task.

## Summary Strip

```html
<section class="summary" aria-label="Summary">
  <div><span>Status</span><strong>Draft</strong></div>
  <div><span>Scope</span><strong>API + UI</strong></div>
  <div><span>Decision</span><strong>Pick rollout path</strong></div>
</section>
```

```css
.summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
.summary div { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 14px; }
.summary span { display: block; color: var(--muted); font: 12px/1.4 var(--mono); text-transform: uppercase; }
.summary strong { display: block; margin-top: 4px; font-size: 16px; }
```

## Two Option Comparison

```html
<section class="compare">
  <article>
    <h3>Option A</h3>
    <p>Best when speed matters and the risk is contained.</p>
  </article>
  <article>
    <h3>Option B</h3>
    <p>Best when long-term extensibility matters more than delivery speed.</p>
  </article>
</section>
```

```css
.compare { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }
.compare article { border: 1px solid var(--line); border-radius: 8px; padding: 16px; background: var(--panel); }
```

## Native Disclosure

```html
<details>
  <summary>Why this risk matters</summary>
  <p>Put optional depth here while keeping the main readout scannable.</p>
</details>
```

```css
details { border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; background: var(--panel); }
summary { cursor: pointer; font-weight: 650; }
details[open] summary { margin-bottom: 8px; }
```

## Tabs

```html
<div class="tabs" data-tabs>
  <div class="tabbar" role="tablist" aria-label="Examples">
    <button role="tab" aria-selected="true" data-tab="before">Before</button>
    <button role="tab" aria-selected="false" data-tab="after">After</button>
  </div>
  <pre data-panel="before">old behavior</pre>
  <pre hidden data-panel="after">new behavior</pre>
</div>
<script>
document.querySelectorAll("[data-tabs]").forEach((tabs) => {
  tabs.addEventListener("click", (event) => {
    const button = event.target.closest("[data-tab]");
    if (!button) return;
    tabs.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b === button)));
    tabs.querySelectorAll("[data-panel]").forEach((panel) => { panel.hidden = panel.dataset.panel !== button.dataset.tab; });
  });
});
</script>
```

## Copy Export

```html
<button data-copy="#export-output">Copy handoff</button>
<pre id="export-output">Recommendation: choose Option A.</pre>
<script>
document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const target = document.querySelector(button.dataset.copy);
    await navigator.clipboard.writeText(target ? target.textContent.trim() : "");
    const old = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => { button.textContent = old; }, 1200);
  });
});
</script>
```

## Inline SVG Flow

```html
<svg viewBox="0 0 760 180" role="img" aria-labelledby="flow-title">
  <title id="flow-title">Request flow</title>
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L0,6 L9,3 z" fill="currentColor"></path>
    </marker>
  </defs>
  <g fill="white" stroke="currentColor">
    <rect x="20" y="50" width="160" height="70" rx="8"></rect>
    <rect x="300" y="50" width="160" height="70" rx="8"></rect>
    <rect x="580" y="50" width="160" height="70" rx="8"></rect>
  </g>
  <g fill="currentColor" font-family="ui-monospace, monospace" font-size="14">
    <text x="100" y="90" text-anchor="middle">Client</text>
    <text x="380" y="90" text-anchor="middle">API</text>
    <text x="660" y="90" text-anchor="middle">Store</text>
  </g>
  <g fill="none" stroke="currentColor" marker-end="url(#arrow)">
    <path d="M185 85 H290"></path>
    <path d="M465 85 H570"></path>
  </g>
</svg>
```

## Lightweight Deck

```html
<main class="deck" data-deck>
  <section class="slide current"><h1>Decision</h1><p>Lead with the point.</p></section>
  <section class="slide"><h2>Evidence</h2><p>Show the support.</p></section>
  <p class="progress" aria-live="polite">1 / 2</p>
</main>
<script>
const deck = document.querySelector("[data-deck]");
if (deck) {
  const slides = [...deck.querySelectorAll(".slide")];
  const progress = deck.querySelector(".progress");
  let index = 0;
  const show = () => {
    slides.forEach((slide, i) => slide.classList.toggle("current", i === index));
    progress.textContent = `${index + 1} / ${slides.length}`;
  };
  addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight") index = Math.min(index + 1, slides.length - 1);
    if (event.key === "ArrowLeft") index = Math.max(index - 1, 0);
    show();
  });
}
</script>
```

## Searchable Table

```html
<div class="searchable-container">
  <div class="search-bar">
    <label for="table-search" class="sr-only">Search table rows</label>
    <input type="text" id="table-search" placeholder="Type to filter rows..." aria-controls="data-table">
  </div>
  <table id="data-table">
    <thead>
      <tr>
        <th>Component</th>
        <th>Status</th>
        <th>Description</th>
      </tr>
    </thead>
    <tbody>
      <tr class="searchable-row">
        <td><strong>Auth API</strong></td>
        <td>Active</td>
        <td>Handles session tokens, OAuth flow, and token revocation.</td>
      </tr>
      <tr class="searchable-row">
        <td><strong>Emissions Engine</strong></td>
        <td>Deprecated</td>
        <td>Old calculator replaced by Financed Emissions v2.</td>
      </tr>
      <tr class="searchable-row">
        <td><strong>Zero Ledger</strong></td>
        <td>Planning</td>
        <td>Double entry blockchain mapping for compliance accounting.</td>
      </tr>
    </tbody>
  </table>
</div>
<script>
document.getElementById('table-search')?.addEventListener('input', (event) => {
  const query = event.target.value.toLowerCase().trim();
  document.querySelectorAll('.searchable-row').forEach((row) => {
    const text = row.textContent.toLowerCase();
    row.style.display = text.includes(query) ? '' : 'none';
  });
});
</script>
```

```css
.search-bar { margin-bottom: 12px; }
.search-bar input {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel);
  color: var(--ink);
  font: 14px var(--sans);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  border: 0;
}
```

## Dynamic Mermaid Diagrams

Use this recipe to render live Mermaid flowcharts or sequence diagrams in your self-contained report.

```html
<div class="mermaid-container">
  <div class="mermaid-raw" style="display: none;">
    graph TD
      A[Client Request] --> B{Valid JWT?}
      B -- Yes --> C[Process Sector Data]
      B -- No --> D[Return 401 Unauthorized]
  </div>
  <!-- Mermaid Target -->
  <div class="mermaid-render" id="flowchart-diagram">Loading diagram...</div>
</div>

<script>
(function() {
  // Dynamically load Mermaid from a CDN with security settings
  const script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js';
  script.onload = () => {
    mermaid.initialize({ startOnLoad: false, theme: 'neutral' });
    const rawContent = document.querySelector('.mermaid-raw').textContent.trim();
    const renderTarget = document.getElementById('flowchart-diagram');
    renderTarget.innerHTML = rawContent;
    mermaid.init(undefined, renderTarget);
  };
  script.onerror = () => {
    document.getElementById('flowchart-diagram').innerHTML = 
      '<p class="error-msg">⚠️ Failed to load diagram rendering engine (Mermaid CDN blocked/offline).</p>';
  };
  document.head.appendChild(script);
})();
</script>
```

