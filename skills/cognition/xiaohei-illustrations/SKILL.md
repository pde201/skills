---
name: xiaohei-illustrations
description: Generate quirky, hand-drawn "Xiaohei" explanatory illustrations for articles, blog posts, and docs — 16:9, pure-white background, sparse handwritten English labels. Use when the user asks to illustrate an article/post/blog/Notion page/methodology, wants "article illustrations", "inline figures", "illustration suggestions", a "shot list", or hand-drawn / deadpan / minimalist explanatory diagrams; also for de-titling or editing such images. Each figure turns one key idea, flow, structure, state, or metaphor into a clean hand-drawn sketch starring a recurring solid-black "Xiaohei" character — never a PPT infographic or cute cartoon.
license: MIT
---

# Xiaohei Illustrations

## What this makes

16:9, pure-white, hand-drawn explanatory figures for English articles. The goal is not commercial illustration, a PPT infographic, or cute cartoon — it's turning one key judgment, flow, structure, state, or metaphor from the article into a clean, quirky, readable sketch that explains without reading like a manual.

The recurring IP is **Xiaohei**: a small, solid-black creature with white dot eyes, thin legs, and a blank deadpan face, doing one absurd-but-coherent job. Xiaohei must perform the core action — never just stand beside the diagram as decoration.

## Requirements

This skill generates images by calling whatever **image-generation tool** is available in your environment (an MCP image tool, or an image-generation CLI). If none is available, run in **planning mode**: produce the shot list plus ready-to-paste prompts (see `references/prompt-template.md`) and hand them to the user to run in their own generator. Don't fabricate or claim an image was produced when no tool ran.

## Read these references on demand

List them as needed — don't load everything at once:

- `references/style-dna.md` — style, color rules, do/don't.
- `references/character.md` — Xiaohei's look, personality, action library, the "too decorative" test.
- `references/composition-patterns.md` — structure types and the fresh-metaphor method.
- `references/prompt-template.md` — the single-image generation prompt and image-edit prompts.
- `references/qa-checklist.md` — post-generation checks and iteration moves.
- `examples/images/` — **low-frequency visual calibration only** (line density, white space, color restraint, Xiaohei's vibe). Don't copy their compositions. These originals carry Chinese labels; your output uses English.

## Workflow

### 1. Digest the article

Read the article / link / markdown / screenshot. Extract: the core argument, which paragraphs carry a cognitive turn, what's worth a figure, and what should stay text-only. Don't illustrate evenly — pick **cognitive anchors**: a key judgment, two breakpoints, an input→output loop, a fork, a before/after, one-source-many-uses, a handoff path, common pitfalls, a state change.

### 2. Lead with a shot list

If the user only wants planning ("where should this be illustrated?"), output a shot list first. Per shot: placement (after which paragraph), theme, core idea, structure type, what Xiaohei is doing, suggested elements, and suggested English labels. Default **4–8**; **1–3** for short pieces; rarely above **9** even for long ones. Enough is enough — don't turn the article into a picture book.

### 3. Generate one image at a time

If the user says generate / make / output, don't stop for confirmation. Generate each figure **separately** (never tile several into one). One core structure per image. Every prompt must include: 16:9 horizontal; pure white background; black hand-drawn line art; sparse red/orange/blue handwritten English labels; lots of white space; Xiaohei as the core actor; and forbid PPT / commercial / cutesy / complex-architecture / top-left type-title. Don't replicate the bundled examples — reinvent a strange-but-coherent metaphor from **this** article. Use `references/prompt-template.md`.

### 4. QA and iterate

Check against `references/qa-checklist.md`. Regenerate or locally edit when: Xiaohei is mere decoration; the frame is overcrowded; it reads like a flowchart/PPT; there's too much text or bad spelling; a "Workflow / System / Common Pitfalls" title appears top-left; the style turns cute/childish/stiff; or the background isn't clean white.

### 5. Save and report

If working inside a workspace, copy finals to `assets/<article-slug>-illustrations/`, named `01-topic.png`, `02-topic.png`, … Keep originals; don't overwrite existing assets unless asked. Report: how many were generated, each one's purpose, the save paths, and which are solid vs optional.

## Output discipline

Keep the pre-generation strategy short and sharp. Don't lecture on style theory — let the images speak.
