# Create HTML Artifacts

[![skills.sh](https://skills.sh/b/pde201/create-html-artifacts-skill)](https://skills.sh/pde201/create-html-artifacts-skill)

A portable skill for any agent that understands `SKILL.md`-style skills, turning dense work into self-contained browser artifacts.

Use it when a spec, plan, review, research note, incident report, design sheet, debugging trace, or decision brief would be easier to understand as a single `.html` file with layout, diagrams, tables, timelines, controls, or copy/export affordances.

## What This Skill Does

`create-html-artifacts` helps an agent decide when HTML is the right medium and then produce a polished, self-contained artifact. The skill includes:

- a concise workflow in [`SKILL.md`](create-html-artifacts/SKILL.md)
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
python3 create-html-artifacts/scripts/check-html-artifact.py samples/*.html
```

Regenerate samples after editing `samples/he-dense-theme.css` or `samples/build-samples.py`:

```bash
python3 samples/build-samples.py
python3 samples/build-samples.py --check   # CI: fail if HTML is stale
```

## Recommended Install With skills.sh

The easiest path is the `skills` CLI from [skills.sh](https://skills.sh). This installs the `create-html-artifacts` skill globally for your detected agent environment:

```bash
npx --yes skills add pde201/create-html-artifacts-skill \
  --skill create-html-artifacts \
  --global \
  --yes
```

To install for a specific agent, pass `--agent`. Codex:

```bash
npx --yes skills add pde201/create-html-artifacts-skill \
  --skill create-html-artifacts \
  --global \
  --agent codex \
  --yes
```

Claude Code:

```bash
npx --yes skills add pde201/create-html-artifacts-skill \
  --skill create-html-artifacts \
  --global \
  --agent claude-code \
  --yes
```

To preview what the repo exposes before installing:

```bash
npx --yes skills add pde201/create-html-artifacts-skill --list
```

For a project-local install, omit `--global`.

The repo is public, so these commands work without GitHub authentication. The `skills` CLI supports multiple agents and can install this skill wherever that agent expects skills.

## Direct npx Install

If you prefer to skip the `skills` CLI, this repo also exposes a direct GitHub `npx` installer:

```bash
npx --yes github:pde201/create-html-artifacts-skill
```

By default, the direct installer writes to a generic skills directory:

```text
${AGENTS_HOME:-$HOME/.agents}/skills/create-html-artifacts
```

Agent-specific shortcuts are also available:

```bash
npx --yes github:pde201/create-html-artifacts-skill codex
npx --yes github:pde201/create-html-artifacts-skill claude
```

For a custom skills directory:

```bash
npx --yes github:pde201/create-html-artifacts-skill --dest "$HOME/.agents/skills"
```

If you already have the skill installed, add `--force`:

```bash
npx --yes github:pde201/create-html-artifacts-skill --force
```

The direct installer copies the skill into the selected agent's global skills directory. Use the skills.sh installer above when you want ecosystem-friendly install tracking and multi-agent support.

## Clone-Based Install

Clone the repo, then run the installer for your agent:

```bash
gh repo clone pde201/create-html-artifacts-skill
cd create-html-artifacts-skill
./install.sh
```

Restart your agent after installing so it can discover the new skill.

## Install Targets

### Generic Agent Directory

```bash
./install.sh
```

Installs to:

```text
${AGENTS_HOME:-$HOME/.agents}/skills/create-html-artifacts
```

### Codex

```bash
./install.sh codex
```

Installs to:

```text
${CODEX_HOME:-$HOME/.codex}/skills/create-html-artifacts
```

### Claude Code

```bash
./install.sh claude
```

Installs to:

```text
${CLAUDE_HOME:-$HOME/.claude}/skills/create-html-artifacts
```

### Custom Skills Directory

Use `--dest` when your agent reads skills from another folder:

```bash
./install.sh --dest "$HOME/.agents/skills"
```

That creates:

```text
$HOME/.agents/skills/create-html-artifacts
```

### Overwrite an Existing Install

The installer refuses to overwrite by default. To replace an existing copy:

```bash
./install.sh --force
```

## Verify Installation

After a generic install, confirm the skill exists:

```bash
ls "${AGENTS_HOME:-$HOME/.agents}/skills/create-html-artifacts/SKILL.md"
```

For Codex:

```bash
ls "${CODEX_HOME:-$HOME/.codex}/skills/create-html-artifacts/SKILL.md"
```

For Claude Code:

```bash
ls "${CLAUDE_HOME:-$HOME/.claude}/skills/create-html-artifacts/SKILL.md"
```

Then restart the agent and invoke it with:

```text
Use $create-html-artifacts to turn this implementation plan into a self-contained HTML artifact.
```

## Using the HTML Checker

The skill ships with a small validation helper:

```bash
create-html-artifacts/scripts/check-html-artifact.py path/to/artifact.html
```

It checks for common issues such as a missing title, missing viewport tag, external dependencies, missing landmarks, unlabeled controls, and stale placeholders.

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
+-- install.sh
+-- package.json
+-- bin/install.js
+-- README.md
`-- create-html-artifacts/
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
