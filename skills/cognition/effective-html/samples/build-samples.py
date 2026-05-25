#!/usr/bin/env python3
"""Regenerate sample HTML artifacts from he-dense-theme.css."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parent
CSS = (ROOT / "he-dense-theme.css").read_text(encoding="utf-8")

SHARED_JS = """
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const target = document.querySelector(button.dataset.copy);
    await copyText(target ? target.textContent.trim() : "");
    const previous = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => { button.textContent = previous; }, 1200);
  });
});

function initTabs(root) {
  const tabs = [...root.querySelectorAll("[data-tab]")];
  const panels = [...root.querySelectorAll("[data-panel]")];
  if (!tabs.length) return;

  function selectTab(tab, focusTab = true) {
    const id = tab.dataset.tab;
    tabs.forEach((item) => {
      const selected = item === tab;
      item.setAttribute("aria-selected", String(selected));
      item.tabIndex = selected ? 0 : -1;
    });
    panels.forEach((panel) => {
      panel.hidden = panel.dataset.panel !== id;
    });
    if (focusTab) tab.focus({ preventScroll: true });
  }

  tabs.forEach((tab, index) => {
    const id = tab.dataset.tab;
    tab.id = `tab-${id}`;
    tab.tabIndex = index === 0 ? 0 : -1;
    tab.setAttribute("aria-controls", `panel-${id}`);
    const panel = panels.find((item) => item.dataset.panel === id);
    if (panel) {
      panel.id = `panel-${id}`;
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", tab.id);
    }
    tab.addEventListener("click", () => selectTab(tab));
    tab.addEventListener("keydown", (event) => {
      const current = tabs.indexOf(tab);
      if (event.key === "ArrowRight") {
        event.preventDefault();
        selectTab(tabs[Math.min(current + 1, tabs.length - 1)]);
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        selectTab(tabs[Math.max(current - 1, 0)]);
      }
    });
  });
  selectTab(tabs[0], false);
}

document.querySelectorAll("[data-tabs]").forEach(initTabs);

document.getElementById("family-search")?.addEventListener("input", (event) => {
  const query = event.target.value.toLowerCase().trim();
  document.querySelectorAll(".searchable-row").forEach((row) => {
    row.style.display = row.textContent.toLowerCase().includes(query) ? "" : "none";
  });
});
""".strip()

PROMPT_EDITOR_JS = """
const defaults = {
  artifactType: "implementation plan",
  audience: "Implementing engineer",
  topic: "Add a samples gallery to effective-html with Thariq-themed dense reference artifacts.",
  sections: "TL;DR, summary strip, diagram, risks, copy handoff",
  exportFormat: "Markdown handoff",
  noCdn: true,
};

const els = {
  form: document.getElementById("editor"),
  artifactType: document.getElementById("artifact-type"),
  audience: document.getElementById("audience"),
  topic: document.getElementById("topic"),
  sections: document.getElementById("sections"),
  exportFormat: document.getElementById("export-format"),
  noCdn: document.getElementById("no-cdn"),
  warning: document.getElementById("validation-warning"),
  meta: document.getElementById("preview-meta"),
  prompt: document.getElementById("prompt-output"),
  json: document.getElementById("json-output"),
  reset: document.getElementById("reset"),
};

function readState() {
  return {
    artifactType: els.artifactType.value,
    audience: els.audience.value.trim(),
    topic: els.topic.value.trim(),
    sections: els.sections.value.trim(),
    exportFormat: els.exportFormat.value,
    noCdn: els.noCdn.checked,
  };
}

function buildPrompt(state) {
  const constraints = [
    state.noCdn ? "Inline CSS/SVG/JS only." : "CDN allowed if needed.",
    "Start from base.html.",
    "TL;DR above the fold.",
    `Include: ${state.sections || "standard sections"}.`,
    `Export: ${state.exportFormat}.`,
    "Run check-html-artifact.py.",
  ];
  return [
    "Use create-html-artifacts (effective-html).",
    "",
    `Create HTML ${state.artifactType} for: ${state.topic || "[topic required]"}`,
    "",
    `Reader: ${state.audience || "Unspecified"}`,
    "",
    "Constraints:",
    ...constraints.map((line) => `- ${line}`),
    "",
    "Deliver one portable .html file.",
  ].join("\\n");
}

function renderPromptEditor() {
  const state = readState();
  els.warning.classList.toggle("visible", !state.topic);
  els.meta.innerHTML = [
    state.artifactType,
    state.exportFormat,
    state.noCdn ? "inline only" : "CDN ok",
  ].map((label) => `<span class="chip">${label}</span>`).join("");
  els.prompt.textContent = buildPrompt(state);
  els.json.textContent = JSON.stringify(
    { skill: "create-html-artifacts", ...state, inlineOnly: state.noCdn },
    null,
    2,
  );
}

els.form.addEventListener("submit", (event) => event.preventDefault());
els.form.addEventListener("input", renderPromptEditor);
els.reset.addEventListener("click", () => {
  els.artifactType.value = defaults.artifactType;
  els.audience.value = defaults.audience;
  els.topic.value = defaults.topic;
  els.sections.value = defaults.sections;
  els.exportFormat.value = defaults.exportFormat;
  els.noCdn.checked = defaults.noCdn;
  renderPromptEditor();
});
renderPromptEditor();
""".strip()


def page(title: str, body: str, extra_js: str = "") -> str:
    scripts = SHARED_JS
    if extra_js:
        scripts = f"{scripts}\n\n{extra_js}"
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
{CSS}
</style>
</head>
<body>
{body}
<script>
{scripts}
</script>
</body>
</html>
"""


SAMPLES = {
    "effective-html-overview.html": page(
        "Effective HTML Skill — Sample",
        """<main class="page">
<header>
<p class="eyebrow">Acuity cognition · sample</p>
<h1>Effective HTML Skill Overview</h1>
<p class="lede"><strong>TL;DR:</strong> Package <code>effective-html</code> ships skill <code>create-html-artifacts</code> — single-file browser artifacts when layout beats Markdown.</p>
</header>
<section class="summary" aria-label="Summary">
<div class="cell"><div class="k">Package</div><div class="v">effective-html</div></div>
<div class="cell"><div class="k">Skill</div><div class="v accent">create-html-artifacts</div></div>
<div class="cell"><div class="k">Category</div><div class="v">Cognition</div></div>
<div class="cell"><div class="k">Output</div><div class="v">One .html</div></div>
</section>
<section>
<div class="sec-head"><span class="num">01</span><h2>When to use</h2></div>
<p class="sec-intro">Comparison, flow, risk tables, editors — not linear prose or Git-tracked specs.</p>
<div class="compare">
<article><h3>Markdown</h3><ul><li>Short linear prose</li><li>Collaborative diffs</li><li>Plain-text consumers</li></ul></article>
<article><h3>HTML artifact</h3><ul><li>Side-by-side options</li><li>Timelines &amp; SVG flows</li><li>Copy/export controls</li></ul></article>
</div>
</section>
<section>
<div class="sec-head"><span class="num">02</span><h2>Workflow</h2></div>
<div class="diagram">
<svg viewBox="0 0 820 120" role="img" aria-labelledby="wf-title wf-desc">
<title id="wf-title">Workflow</title>
<desc id="wf-desc">Reader task to open artifact in browser</desc>
<defs><marker id="arrow-a" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="currentColor"/></marker></defs>
<g class="box"><rect x="8" y="34" width="118" height="52" rx="7"/><rect x="158" y="34" width="118" height="52" rx="7"/><rect x="308" y="34" width="118" height="52" rx="7"/><rect x="458" y="34" width="118" height="52" rx="7"/><rect x="608" y="34" width="118" height="52" rx="7"/><rect x="758" y="34" width="54" height="52" rx="7"/></g>
<text x="67" y="64" text-anchor="middle">Reader task</text><text x="217" y="64" text-anchor="middle">Pick shape</text><text x="367" y="64" text-anchor="middle">base.html</text><text x="517" y="64" text-anchor="middle">Build</text><text x="667" y="64" text-anchor="middle">Validate</text><text x="785" y="64" text-anchor="middle">Open</text>
<g fill="none" stroke="currentColor" marker-end="url(#arrow-a)"><path d="M128 60 H152"/><path d="M278 60 H302"/><path d="M428 60 H452"/><path d="M578 60 H602"/><path d="M728 60 H752"/></g>
</svg>
<p class="caption">Inline CSS/SVG/JS only unless user requests CDN.</p>
</div>
</section>
<section>
<div class="sec-head"><span class="num">03</span><h2>Examples</h2></div>
<div class="tabs" data-tabs>
<div class="tabbar" role="tablist" aria-label="Artifact examples">
<button type="button" role="tab" aria-selected="true" data-tab="plan">Plan</button>
<button type="button" role="tab" aria-selected="false" data-tab="review">Review</button>
<button type="button" role="tab" aria-selected="false" data-tab="decision">Decision</button>
</div>
<div class="panel" data-panel="plan"><h3>Implementation plan</h3><p class="sec-intro">Summary strip, milestones, data-flow SVG, risks, open questions.</p></div>
<div class="panel" hidden data-panel="review"><h3>Code review</h3><p class="sec-intro">Severity chips, file cards, annotated diff, fix options.</p></div>
<div class="panel" hidden data-panel="decision"><h3>Decision brief</h3><p class="sec-intro">Recommendation, options matrix, trade-offs, decision log export.</p></div>
</div>
</section>
<section>
<div class="sec-head"><span class="num">04</span><h2>Artifact families</h2></div>
<div class="search-bar"><label class="sr-only" for="family-search">Filter families</label><input id="family-search" placeholder="Filter families…" aria-controls="family-table"></div>
<table class="data" id="family-table"><thead><tr><th>Family</th><th>Structure</th><th>Affordances</th></tr></thead><tbody>
<tr class="searchable-row"><td><strong>Plan</strong></td><td>Scope, milestones, flow, files</td><td>Timeline, diagram</td></tr>
<tr class="searchable-row"><td><strong>Review</strong></td><td>Summary, file cards, findings</td><td>Severity chips, diff</td></tr>
<tr class="searchable-row"><td><strong>Explainer</strong></td><td>TL;DR, modules, glossary</td><td>Tabs, collapsible depth</td></tr>
<tr class="searchable-row"><td><strong>Editor</strong></td><td>Inputs, preview, output</td><td>Reset, copy/export</td></tr>
</tbody></table>
</section>
<section>
<div class="sec-head"><span class="num">05</span><h2>Risks</h2></div>
<table class="data"><thead><tr><th>Risk</th><th>Impact</th><th>Mitigation</th></tr></thead><tbody>
<tr><td>External CDNs</td><td>Offline break</td><td>Inline assets by default</td></tr>
<tr><td>JS-only content</td><td>Bad screenshots</td><td>Progressive enhancement</td></tr>
</tbody></table>
</section>
<section>
<details><summary>Sources</summary>
<ul class="muted" style="margin-top:6px;padding-left:18px"><li><code>create-html-artifacts/SKILL.md</code></li><li><a href="https://thariqs.github.io/html-effectiveness/">HTML Effectiveness gallery</a></li></ul>
</details>
<div class="toolbar"><button class="btn" type="button" data-copy="#handoff">Copy handoff</button><button class="btn ghost" type="button" onclick="window.print()">Print</button></div>
<pre class="soft" id="handoff">Use create-html-artifacts when layout improves cognition. Install: npx --yes github:pde201/skills/skills/cognition/effective-html</pre>
</section>
</main>""",
    ),
    "code-review-sample.html": page(
        "PR Review — effective-html installer",
        """<main class="page">
<header class="pr-head">
<p class="eyebrow">pde201/skills · PR #142</p>
<h1>Review: effective-html installer hardening</h1>
<p class="lede"><strong>TL;DR:</strong> Approve after path validation on <code>--dest</code>. One high, two medium.</p>
<div class="chips">
<a class="chip high" href="#f-install"><span class="dot"></span>bin/install.js</a>
<a class="chip medium" href="#f-install"><span class="dot"></span>--force</a>
<a class="chip medium" href="#f-check"><span class="dot"></span>checker warning</a>
<a class="chip low" href="#f-readme"><span class="dot"></span>README</a>
</div>
</header>
<section class="summary" aria-label="PR summary">
<div class="cell"><div class="k">Verdict</div><div class="v accent">Approve w/ changes</div></div>
<div class="cell"><div class="k">Files</div><div class="v">4</div></div>
<div class="cell"><div class="k">Blast radius</div><div class="v">Install only</div></div>
<div class="cell"><div class="k">Tests</div><div class="v">Missing</div></div>
</section>
<div class="layout-2">
<nav class="jump" aria-label="Jump links"><a href="#findings">Findings</a><a href="#files">Files</a><a href="#repro">Repro</a><a href="#fixes">Fixes</a></nav>
<div>
<section id="findings">
<div class="sec-head"><span class="num">01</span><h2>Findings</h2></div>
<table class="data"><thead><tr><th>Sev</th><th>Finding</th><th>File</th></tr></thead><tbody>
<tr><td><span class="chip high"><span class="dot"></span>High</span></td><td><code>--dest</code> accepts <code>../</code> — write outside skills root</td><td><code>bin/install.js</code></td></tr>
<tr><td><span class="chip medium"><span class="dot"></span>Med</span></td><td><code>--force</code> deletes without confirm in non-TTY</td><td><code>bin/install.js</code></td></tr>
<tr><td><span class="chip medium"><span class="dot"></span>Med</span></td><td>Side-border checker warning vague</td><td><code>check-html-artifact.py</code></td></tr>
<tr><td><span class="chip low"><span class="dot"></span>Low</span></td><td>README omits <code>--dest</code> safety</td><td><code>README.md</code></td></tr>
</tbody></table>
</section>
<section id="files">
<div class="sec-head"><span class="num">02</span><h2>Files</h2></div>
<article class="file-card" id="f-install">
<div class="file-head"><span class="file-path">bin/install.js</span><span class="risk-tag attention">needs attention</span></div>
<div class="diff">
<div class="diff-row del"><span class="ln">12</span><span class="mark">-</span><span class="code">fs.cpSync(src, dest, { recursive: true });</span></div>
<div class="diff-row add"><span class="ln">12</span><span class="mark">+</span><span class="code">if (!dest.startsWith(allowedRoot)) throw new Error('Invalid --dest');</span></div>
<div class="diff-row add"><span class="ln">13</span><span class="mark">+</span><span class="code">fs.cpSync(src, dest, { recursive: true });</span></div>
</div>
</article>
<article class="file-card" id="f-check">
<div class="file-head"><span class="file-path">scripts/check-html-artifact.py</span><span class="risk-tag medium">worth a look</span></div>
<p class="file-note">Heuristic tweak only — improve warning text with selector hint.</p>
</article>
<article class="file-card" id="f-readme">
<div class="file-head"><span class="file-path">README.md</span><span class="risk-tag safe">safe</span></div>
<p class="file-note">Docs-only: document resolved-path behavior for <code>--dest</code>.</p>
</article>
</section>
<section id="repro">
<div class="sec-head"><span class="num">03</span><h2>Reproduction</h2></div>
<ol class="muted" style="padding-left:18px"><li><code>npx acuity-effective-html --dest ../../tmp/evil</code></li><li>Files land outside skills root.</li><li>Repeat with symlinked dest.</li></ol>
</section>
<section id="fixes">
<div class="sec-head"><span class="num">04</span><h2>Fix options</h2></div>
<div class="grid">
<article class="panel stack"><h3>Option A — minimal guard</h3><p class="muted">Resolve <code>--dest</code>, compare to <code>allowedRoot</code>, one unit test. Same-day merge.</p></article>
<article class="panel stack"><h3>Option B — sandbox API</h3><p class="muted">Shared install module with dry-run + audit log. If more installers coming.</p></article>
</div>
<div class="toolbar"><button class="btn" type="button" data-copy="#review-handoff">Copy handoff</button></div>
<pre class="soft" id="review-handoff">Verdict: Approve with changes. Must fix: validate --dest under allowedRoot.</pre>
</section>
</div>
</div>
</main>""",
    ),
    "implementation-plan-sample.html": page(
        "Implementation Plan — effective-html samples",
        """<main class="page">
<header>
<p class="eyebrow">Implementation plan</p>
<h1>Samples gallery for effective-html</h1>
<p class="lede"><strong>TL;DR:</strong> Add <code>samples/</code> with reference artifacts, README links, checker in CI — ~1 day.</p>
</header>
<section class="summary" aria-label="Plan summary">
<div class="cell"><div class="k">Effort</div><div class="v">~1 day</div></div>
<div class="cell"><div class="k">Surfaces</div><div class="v">samples + README</div></div>
<div class="cell"><div class="k">New files</div><div class="v accent">4 HTML</div></div>
<div class="cell"><div class="k">Flag</div><div class="v">none</div></div>
</section>
<section>
<div class="sec-head"><span class="num">01</span><h2>Milestones</h2></div>
<p class="sec-intro">Three slices, each independently reviewable.</p>
<div class="milestones">
<div class="milestone"><div class="when">Day 1 AM</div><div class="dot-col"><div class="dot"></div><div class="line"></div></div><div class="body"><h3>Sample artifacts</h3><p>Overview, review, plan, editor — Thariq theme, dense layout.</p><span class="tag">4 files</span></div></div>
<div class="milestone"><div class="when">Day 1 PM</div><div class="dot-col"><div class="dot"></div><div class="line"></div></div><div class="body"><h3>Validation</h3><p>Run <code>check-html-artifact.py</code> on each; fix or document warnings.</p></div></div>
<div class="milestone"><div class="when">Day 2</div><div class="dot-col"><div class="dot"></div><div class="line"></div></div><div class="body"><h3>Document</h3><p>README samples table with open commands and family mapping.</p></div></div>
</div>
</section>
<section>
<div class="sec-head"><span class="num">02</span><h2>Data flow</h2></div>
<div class="diagram">
<svg viewBox="0 0 700 110" role="img" aria-labelledby="plan-flow-title plan-flow-desc">
<title id="plan-flow-title">Delivery flow</title>
<desc id="plan-flow-desc">Author, validate, document, open in browser</desc>
<defs><marker id="arrow-b" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="currentColor"/></marker></defs>
<g class="box"><rect x="10" y="28" width="120" height="48" rx="7"/><rect x="190" y="28" width="120" height="48" rx="7"/><rect x="370" y="28" width="120" height="48" rx="7"/><rect x="550" y="28" width="120" height="48" rx="7"/></g>
<text x="70" y="56" text-anchor="middle">Author</text><text x="250" y="56" text-anchor="middle">Checker</text><text x="430" y="56" text-anchor="middle">README</text><text x="610" y="56" text-anchor="middle">Browser</text>
<g fill="none" stroke="currentColor" marker-end="url(#arrow-b)"><path d="M132 52 H186"/><path d="M312 52 H366"/><path d="M492 52 H546"/></g>
</svg>
<p class="caption">CI fails on checker errors. Solid = file path; no CDN.</p>
</div>
</section>
<section>
<div class="sec-head"><span class="num">03</span><h2>Key files</h2></div>
<table class="data"><thead><tr><th>Path</th><th>Change</th></tr></thead><tbody>
<tr><td><code>samples/*.html</code></td><td>Reference artifacts</td></tr>
<tr><td><code>samples/build-samples.py</code></td><td>Regenerate HTML from theme</td></tr>
<tr><td><code>README.md</code></td><td>Samples section</td></tr>
</tbody></table>
</section>
<section>
<div class="sec-head"><span class="num">04</span><h2>Risks</h2></div>
<table class="data"><thead><tr><th>Risk</th><th>Sev</th><th>Mitigation</th></tr></thead><tbody>
<tr><td>Samples drift from SKILL.md</td><td><span class="chip med"><span class="dot"></span>MED</span></td><td>Regenerate via build script; CI check</td></tr>
<tr><td>Checker false positives</td><td><span class="chip low"><span class="dot"></span>LOW</span></td><td>Document accepted warnings</td></tr>
</tbody></table>
</section>
<section>
<div class="sec-head"><span class="num">05</span><h2>Open questions</h2></div>
<div class="stack">
<div class="panel"><h3>CI job for samples?</h3><p class="muted">Run <code>python3 samples/build-samples.py --check</code> in CI.</p></div>
<div class="panel"><h3>Publish to skills.sh?</h3><p class="muted">Gallery could link externally later.</p></div>
</div>
<div class="toolbar"><button class="btn" type="button" data-copy="#plan-handoff">Copy handoff</button></div>
<pre class="soft" id="plan-handoff">Plan: 4 samples, checker gate, README links. Effort ~1 day.</pre>
</section>
</main>""",
    ),
    "prompt-editor-sample.html": page(
        "Prompt Editor — HTML artifact generator",
        """<main class="page">
<header>
<p class="eyebrow">Custom editor</p>
<h1>HTML Artifact Prompt Builder</h1>
<p class="lede"><strong>TL;DR:</strong> Tune type, audience, constraints — copy a paste-ready agent prompt.</p>
</header>
<div class="toolbar sticky"><span class="hint">LIVE · edits re-render</span></div>
<section class="cols">
<form class="panel" id="editor" aria-label="Prompt controls">
<div class="field"><label for="artifact-type">Artifact type</label>
<select id="artifact-type"><option>implementation plan</option><option>code review pack</option><option>architecture explainer</option><option>decision brief</option><option>incident report</option><option>custom editor</option></select></div>
<div class="field"><label for="audience">Reader</label><input id="audience" type="text" value="Implementing engineer"></div>
<div class="field"><label for="topic">Topic</label><textarea id="topic">Add a samples gallery to effective-html with Thariq-themed dense reference artifacts.</textarea></div>
<div class="field"><label for="sections">Sections</label><input id="sections" type="text" value="TL;DR, summary strip, diagram, risks, copy handoff"></div>
<div class="field"><label for="export-format">Export</label><select id="export-format"><option>Markdown handoff</option><option>JSON summary</option><option>Patch-like diff</option></select></div>
<div class="field-check"><input type="checkbox" id="no-cdn" checked><label for="no-cdn">Inline assets only (no CDN)</label></div>
<p class="warn" id="validation-warning" role="status">Add a topic.</p>
<button class="btn ghost" type="button" id="reset">Reset</button>
</form>
<div class="panel">
<h2 class="preview-title">Preview</h2>
<div class="chips" id="preview-meta" aria-live="polite" style="margin-bottom:5px"></div>
<div class="toolbar"><button class="btn" type="button" data-copy="#prompt-output">Copy prompt</button><button class="btn ghost" type="button" data-copy="#json-output">Copy JSON</button></div>
<pre class="block" id="prompt-output" aria-live="polite"></pre>
<pre class="visually-hidden" id="json-output"></pre>
</div>
</section>
</main>""",
        PROMPT_EDITOR_JS,
    ),
}


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Verify generated files match on-disk HTML")
    args = parser.parse_args()

    if args.check:
        mismatches = []
        for name, expected in SAMPLES.items():
            path = ROOT / name
            if path.read_text(encoding="utf-8") != expected:
                mismatches.append(name)
        if mismatches:
            print("Samples out of date:", ", ".join(mismatches))
            return 1
        print("Samples are up to date.")
        return 0

    for name, content in SAMPLES.items():
        (ROOT / name).write_text(content, encoding="utf-8")
        print(f"wrote {name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
