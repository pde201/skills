# SSD Skill

A portable agent skill for bounded speculative branching during multi-step implementation work.

`ssd` is an agentic analogue of speculative decoding: while an executor works on step `N`, a lightweight drafter prepares small branch skeletons for likely step `N+1` outcomes. The goal is to hide planning latency without letting speculation grow into broad, unsafe rewrites.

## What This Skill Helps With

Use `ssd` when a multi-step implementation plan has:

- a slow current step with a real execution or verification window
- a few likely next-step outcomes that can be ranked
- a next step that can be represented as small patch-sized branch skeletons
- a need to measure whether speculation actually helps

It helps agents:

- decide whether speculation is worth using
- rank likely outcome branches by value
- draft bounded `OUTCOME_KEY` branch skeletons
- classify cache hits, misses, and partial reuse honestly
- disable speculation when the economics stop working

## Recommended Install With skills.sh

The easiest path is the `skills` CLI from [skills.sh](https://skills.sh):

```bash
npx --yes skills add pde201/ssd \
  --skill ssd \
  --global \
  --agent codex \
  --yes
```

For Claude Code:

```bash
npx --yes skills add pde201/ssd \
  --skill ssd \
  --global \
  --agent claude-code \
  --yes
```

To preview what the repo exposes before installing:

```bash
npx --yes skills add pde201/ssd --list
```

For a project-local install, omit `--global`.

## Direct npx Install

You can also install directly from this GitHub repo:

```bash
npx --yes github:pde201/ssd codex
```

For Claude Code:

```bash
npx --yes github:pde201/ssd claude
```

For a custom skills directory:

```bash
npx --yes github:pde201/ssd --dest "$HOME/.agents/skills"
```

If you already have the skill installed, add `--force`:

```bash
npx --yes github:pde201/ssd codex --force
```

## Clone-Based Install

Clone the repo, then run the installer for your agent:

```bash
gh repo clone pde201/ssd
cd ssd
./install.sh codex
```

Restart your agent after installing so it can discover the new skill.

## Install Targets

### Codex

```bash
./install.sh codex
```

Installs to:

```text
${CODEX_HOME:-$HOME/.codex}/skills/ssd
```

### Claude Code

```bash
./install.sh claude
```

Installs to:

```text
${CLAUDE_HOME:-$HOME/.claude}/skills/ssd
```

### Generic Agent Directory

Use `--dest` when your agent reads skills from a different folder:

```bash
./install.sh --dest "$HOME/.agents/skills"
```

That creates:

```text
$HOME/.agents/skills/ssd
```

### Overwrite an Existing Install

The installer refuses to overwrite by default. To replace an existing copy:

```bash
./install.sh codex --force
```

## Verify Installation

After installing, confirm the skill exists:

```bash
ls "${CODEX_HOME:-$HOME/.codex}/skills/ssd/SKILL.md"
```

For Claude Code:

```bash
ls "${CLAUDE_HOME:-$HOME/.claude}/skills/ssd/SKILL.md"
```

Then restart the agent and invoke it with:

```text
Use $ssd to decide whether speculative branching is worthwhile for this multi-step implementation plan.
```

## Repository Layout

```text
.
+-- SKILL.md
+-- README.md
+-- install.sh
+-- package.json
+-- bin/install.js
`-- references/
    |-- drafter-backends.md
    |-- evals.md
    |-- examples.md
    |-- outcome-cache.md
    `-- prompt-templates.md
```

## Notes

- The skill is advisory. The executor remains authoritative for real workspace state and verification.
- The skill deliberately limits speculation to one step of lookahead.
- `npx skills add pde201/ssd --list` should show exactly one skill: `ssd`.
