# Effective HTML

A portable skill for any agent that understands `SKILL.md`-style skills, turning dense work into self-contained browser artifacts.

Use it when a spec, plan, review, research note, incident report, design sheet, debugging trace, or decision brief would be easier to understand as a single `.html` file with layout, diagrams, tables, timelines, controls, or copy/export affordances.

## What This Skill Does

`effective-html` helps an agent decide when HTML is the right medium and then produce a polished, self-contained artifact. The skill includes:

- a concise workflow in [`SKILL.md`](effective-html/SKILL.md)
- an artifact picker for choosing the right format
- reusable HTML/CSS/JS recipes
- a starter `base.html` template
- a lightweight checker for generated HTML artifacts

It is useful for:

- implementation plans and technical specs
- code review and debugging artifacts
- architecture and research explainers
- design sheets and component/state reviews
- incident/status reports
- prompt, config, and workflow editors
- meeting decks and decision briefs

## Sample artifacts

Reference HTML files live in [`samples/`](samples/). Theme follows the [HTML Effectiveness gallery](https://thariqs.github.io/html-effectiveness/) (dense layout).

| Sample | Family | Open |
| --- | --- | --- |
| `effective-html-overview.html` | Explainer | `open samples/effective-html-overview.html` |
| `code-review-sample.html` | Code review | `open samples/code-review-sample.html` |
| `implementation-plan-sample.html` | Implementation plan | `open samples/implementation-plan-sample.html` |
| `prompt-editor-sample.html` | Custom editor | `open samples/prompt-editor-sample.html` |

Validate all samples:

```bash
for f in samples/*.html; do python3 effective-html/scripts/check-html-artifact.py "$f"; done
```

Regenerate samples after editing `samples/he-dense-theme.css` or `samples/build-samples.py`:

```bash
python3 samples/build-samples.py
python3 samples/build-samples.py --check   # CI: fail if HTML is stale
```

## Install

With the [skills.sh](https://skills.sh) CLI, which installs for your detected agent (add `--agent codex` or `--agent claude-code` to choose one, or drop `--global` for a project-local install):

```bash
npx --yes skills add pde201/skills --skill effective-html --global --yes
```

Or from a clone, with the repository's installer (targets `agents`, `codex` or `claude`; default `agents`):

```bash
git clone https://github.com/pde201/skills.git
./skills/install.sh effective-html claude
```

The installer also accepts `--dest DIR` for another skills directory and `--force` to replace an existing install. It creates an `effective-html/` directory inside the chosen skills directory.

Restart the agent after installing, then invoke it with:

```text
Use $effective-html to turn this implementation plan into a self-contained HTML artifact.
```

### Upgrading from create-html-artifacts

Before 2.0 this skill was named `effective-html` and installed into a directory of that name. Installing 2.0 leaves the old copy in place, and the installer prints its path; remove it so the two do not load side by side.

## Using the HTML Checker

The skill ships with a small validation helper:

```bash
effective-html/scripts/check-html-artifact.py path/to/artifact.html
```

It checks for common issues such as a missing title, missing viewport tag, external dependencies (including `url()` and `@import` in CSS), missing landmarks, unlabeled controls, and stale placeholders. Its tests run with `python3 -m unittest discover -s tests` from this directory.

## What Gets Installed

The installed skill directory contains:

- `SKILL.md` with the trigger and workflow
- `references/` with artifact-selection guidance, reusable recipes, and pattern examples
- `assets/templates/base.html` as a self-contained starter template
- `scripts/check-html-artifact.py` for generated artifact checks
- `agents/openai.yaml` as optional OpenAI/Codex UI metadata. Other agents can ignore it.

## Repository Layout

```text
.
+-- package.json
+-- README.md
+-- evals/evals.json
+-- samples/            (reference artifacts and their generator)
`-- effective-html/
    |-- SKILL.md
    |-- agents/openai.yaml
    |-- assets/templates/base.html
    |-- references/
    |   |-- artifact-selection.md
    |   |-- html-artifact-patterns.md
    |   `-- recipes.md
    `-- scripts/check-html-artifact.py
```

## Notes

- The skill itself has no dependency on Codex, Claude Code, or any single agent runtime.
- `agents/openai.yaml` is optional metadata for OpenAI/Codex interfaces; other agents can ignore it.
- Generated HTML artifacts should be self-contained unless the user explicitly asks for external assets or dependencies.
