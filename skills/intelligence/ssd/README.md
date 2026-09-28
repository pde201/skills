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

## Install

With the [skills.sh](https://skills.sh) CLI (drop `--global` for a project-local install):

```bash
npx --yes skills add pde201/skills --skill ssd --global --agent claude-code --yes   # or --agent codex
```

Or from a clone, with the repository's installer (targets `agents`, `codex` or `claude`; default `agents`):

```bash
git clone https://github.com/pde201/skills.git
./skills/install.sh ssd claude
```

The installer also accepts `--dest DIR` for another skills directory and `--force` to replace an existing install. It creates an `ssd/` directory inside the chosen skills directory.

Restart your agent after installing so it can discover the new skill.

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
+-- package.json
+-- scripts/ssd-tracker.js
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
- `npx skills add pde201/skills --list` lists this skill as `ssd`.
