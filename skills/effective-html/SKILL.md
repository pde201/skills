---
name: effective-html
description: Use when dense planning, review, research, debugging, reporting, design, or handoff work would be easier to understand as a self-contained browser artifact with layout, diagrams, comparisons, controls, tables, timelines, or exportable edits.
---

# Create HTML Artifacts

## Overview

Create a self-contained `.html` artifact when browser layout, interaction, or visual hierarchy will help a reader understand, decide, review, or hand off work. HTML is the medium; the goal is better cognition.

Prefer Markdown when the content is mostly linear prose, needs collaborative text diffs, or gains nothing from spatial layout.

## Workflow

1. Identify the reader, their task, and the decision or handoff the artifact must support.
2. Choose the artifact shape from `references/artifact-selection.md`.
3. Use `assets/templates/base.html` as the starting shell when creating a new file.
4. Pull only needed snippets from `references/recipes.md`.
5. Build one portable `.html` file with inline CSS, inline SVG, and vanilla JS. Avoid CDNs, build steps, package installs, and external assets unless the user asks.
6. Put the highest-value readout above the fold: purpose, TL;DR, status, scope, sources, recommendation, or next decision.
7. Let layout carry meaning: comparisons side by side, flows as diagrams, risks as tables, sequences as timelines, states as contact sheets, and tunable decisions as controls.
8. Verify with `scripts/check-html-artifact.py <file.html>` and, when practical, open or screenshot the artifact at desktop and narrow widths.

## Artifact Families

- **Specs and implementation plans**: summary strip, milestones, data-flow diagram, risks, key files, open questions.
- **Code review and debugging**: severity chips, file cards, annotated diffs, module map, reproduction path, fix options.
- **Architecture and research explainers**: TL;DR, sticky table of contents, diagrams, source list, collapsible depth, tabbed examples.
- **Design artifacts**: swatches, type scale, spacing tokens, component/state contact sheets, responsive notes.
- **Reports and incident briefs**: KPI strip, timeline, grouped updates, charts, decisions, follow-ups.
- **Custom editors and tuners**: domain controls, validation warnings, live preview, reset, copy/export to Markdown, JSON, prompt, or patch-like text.
- **Meeting or decision briefs**: options matrix, recommendation, trade-offs, owners, unresolved questions, decision log.
- **Lightweight decks**: one section per slide, keyboard navigation, progress indicator, screenshot-safe contrast.

## Rules

- Use semantic HTML: `header`, `main`, `section`, `nav`, `table`, `details`, `summary`, `button`, `input`, `label`, and `dialog` where appropriate.
- Include `<meta name="viewport" content="width=device-width, initial-scale=1">` and a meaningful `<title>`.
- Keep all essential content visible without hover or JavaScript.
- Use progressive enhancement for tabs, filters, copy buttons, slide navigation, editor previews, and validation.
- Label diagrams directly so screenshots remain understandable.
- Show source grounding: files read, links used, assumptions, facts, recommendations, risks, and open questions.
- Make responsive behavior explicit with `auto-fit`, `minmax()`, width constraints, and mobile media queries.
- Add copy/export controls for editors so user changes can leave the page as a useful artifact.
- Keep styling purposeful. Avoid ornamental effects, opaque generated blobs, and animation that does not improve review.

## Quality Checklist

- Opens directly in a browser as one file.
- The top of the page tells the reader what the artifact is for.
- The artifact makes comparison, flow, risk, state, or decision structure easier to scan than Markdown.
- Controls have labels, focus states, empty states, and keyboard-friendly behavior.
- Tables, SVGs, cards, code blocks, and controls fit on phone and desktop widths.
- Exports are in the exact format the next reader, agent, reviewer, or implementer needs.
- `scripts/check-html-artifact.py` passes or any warnings are intentionally accepted.

## References

- Read `references/artifact-selection.md` to choose the artifact shape.
- Read `references/recipes.md` for reusable HTML/CSS/JS patterns.
- Read `references/html-artifact-patterns.md` for expanded examples inspired by the HTML Effectiveness gallery.

## Portability

This skill has no Codex-only runtime dependency. Other agents can use the `SKILL.md`, `references/`, `assets/`, and `scripts/` files directly; `agents/openai.yaml` is Codex UI metadata and may be ignored elsewhere.
