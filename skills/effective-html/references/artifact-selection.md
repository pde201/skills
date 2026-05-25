# Artifact Selection

Choose the shape by the reader's task, not by the source document format.

| Reader needs to... | Create this | Primary structure | Useful affordances |
| --- | --- | --- | --- |
| Decide between options | Decision brief | Recommendation, options matrix, trade-offs, constraints | Side-by-side panels, scoring table, decision log |
| Execute implementation | Implementation plan | Scope, milestones, data flow, files, risks | Timeline, source file list, diagram, open questions |
| Review code or PR risk | Review artifact | PR summary, risk map, file cards, findings | Severity chips, jump links, annotated snippets |
| Understand a codebase area | Architecture explainer | Entry points, modules, flow, glossary | SVG map, collapsible depth, tabbed examples |
| Debug a behavior | Debugging artifact | Symptom, evidence, hypotheses, experiments, fix options | Repro path, hypothesis table, timeline |
| Migrate or refactor safely | Migration plan | Current state, target state, phases, compatibility | Before/after diagrams, blast-radius table |
| Compare designs or states | Design sheet | Tokens, components, variants, responsive behavior | Swatches, state matrix, contact sheet |
| Report status or incident | Report | Status, timeline, impact, decisions, follow-ups | KPI strip, chart, grouped updates |
| Teach or explain research | Explainer | TL;DR, concepts, examples, gotchas, FAQ | Sticky nav, details, tabs, source list |
| Tune a prompt or config | Custom editor | Inputs, validation, preview, output | Controls, warnings, reset, copy/export |
| Present live | Lightweight deck | One point per section, speaker-safe flow | Keyboard navigation, progress indicator |

## Selection Heuristics

- **Comparison dominates**: use columns, matrices, or split panes.
- **Sequence dominates**: use timelines, step cards, or path diagrams.
- **System relationships dominate**: use inline SVG maps with direct labels.
- **Large evidence dominates**: use filters, severity chips, collapsible details, and source lists.
- **The user must edit or tune**: use a custom editor with portable export.
- **The artifact will be pasted into another workflow**: provide copy buttons for Markdown, JSON, prompt text, or patch-like output.

## When Not To Use HTML

- The artifact is short linear prose.
- The user expects a Git-tracked Markdown spec.
- Accessibility or review constraints forbid browser artifacts.
- The content needs real-time multi-user editing.
- The output will be consumed only by a plain-text system.
