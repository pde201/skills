# HTML Artifact Patterns

Source inspiration: Thariq Shihipar's HTML Effectiveness gallery, especially its examples of self-contained `.html` artifacts replacing linear Markdown for plans, reviews, explainers, reports, diagrams, decks, and custom editors: https://thariqs.github.io/html-effectiveness/

Use this file for expanded examples. Do not copy a pattern wholesale; adapt it to the reader's decision and the available source material.

## Pattern Catalogue

| Need | Best HTML Shape | Include |
| --- | --- | --- |
| Hand off implementation work | Plan page | Summary metrics, milestone timeline, data-flow SVG, inline mockups, key code, risks, open questions |
| Compare solution directions | Exploration sheet | Option columns, decision criteria, trade-offs, recommendation, "choose this if" notes |
| Review code changes | Review artifact | PR header, risk chips, file cards, annotated diffs, severity tags, jump links |
| Explain unfamiliar code | Module map | Entry points, package boxes, call graph, hot path highlight, glossary |
| Debug a behavior | Debugging board | Symptom, reproduction, evidence, hypotheses, experiments, next action |
| Plan a migration | Migration map | Current/target states, phases, compatibility, blast radius, rollback |
| Review design language | Design sheet | Color swatches, type scale, spacing tokens, component contact sheets, state matrix |
| Prototype an interaction | Sandbox | Minimal rendered UI, sliders/toggles for tunable values, live preview, reset |
| Show a process | Diagram page | Inline SVG flowchart, clickable steps, timing/failure notes, legend |
| Present in a meeting | Slide deck | One `section` per slide, keyboard navigation, progress indicator, speaker-safe contrast |
| Explain research or a feature | Explainer | TL;DR, sticky TOC, source files, collapsible path steps, tabbed code, gotchas, FAQ |
| Report status or incident | Report | KPI strip, timeline, grouped updates, chart, decisions, follow-up checklist |
| Let user express a hard-to-describe choice | Custom editor | Domain-specific controls, validation, live preview, copy/export to Markdown/JSON/diff |

## Structural Moves

- Put a dense summary above the fold: status, decision, scope, effort, owners, source files, or next step.
- Use spatial comparison for alternatives so the reader does not have to remember option A while reading option C.
- Keep code snippets close to their explanation. For diffs, annotate beside the changed lines rather than below them.
- Turn sequences into timelines or numbered path cards. If the order branches, use SVG.
- Turn token, design, system, or test-state data into swatches and contact sheets.
- Use native `<details>` for optional depth and tab controls for mutually exclusive examples.
- Add a sticky side nav only when the page has enough sections to justify it.
- For long handoff artifacts, end with risks, open questions, and where to focus review.

## Interaction Moves

- Prefer no-JS where HTML already works: anchors, tables, details/summary, forms, and semantic sections.
- Use small vanilla JS for tabs, filters, copy buttons, editor previews, slide navigation, and validation.
- Show empty, invalid, and copied states explicitly in custom editors.
- Always make editor output portable: copy a Markdown summary, JSON config, prompt template, or patch-like diff.
- Keep all critical content visible without needing hover.

## Visual Rules

- Use restrained styling that helps scanning: strong hierarchy, clear grouping, generous whitespace, and a few semantic colors.
- Use CSS variables for palette, type, spacing, and status colors.
- Keep cards shallow and purposeful. Do not nest decorative cards inside cards.
- Make responsive behavior explicit with `auto-fit`, `minmax()`, width constraints, and mobile media queries.
- Label diagrams directly. Legends help, but screenshots should still be understandable on their own.
- Avoid external fonts, frameworks, or image dependencies unless the source material requires them.

## Verification

Before calling the artifact done:

1. Run `scripts/check-html-artifact.py <file.html>`.
2. Open it directly in a browser or render a screenshot.
3. Check a desktop width and a phone-width viewport.
4. Click every control: tabs, details, filters, copy/export, slide navigation, editor reset.
5. Confirm text does not overlap, clip, or depend on hover-only disclosure.
6. Confirm generated export is exactly the format the next reader, agent, reviewer, or implementer should receive.
