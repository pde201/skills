# prd-lifecycle

An agentic coding skill designed for AI assistants and developers to manage parent PRD tickets and child implementation issue lifecycles in GitHub with automated verification checks and closing walkthrough documentation.

Requires `git`, `node` and an authenticated [`gh`](https://cli.github.com/).

## Installation

### Via npx
```bash
npx --yes github:pde201/skills/skills/workflow/prd-lifecycle
```

### Via install.sh
```bash
./install.sh
```

Both accept a target (`agents`, `codex` or `claude`), `--dest DIR` and `--force`; run with `--help` for details.

## Scripts

| Script | Purpose |
|---|---|
| `scripts/generate-walkthrough.js <md> <html>` | Render a walkthrough Markdown file as a standalone responsive HTML page |
| `scripts/verify-prd-closing.sh <prd> [--dir DIR] [--typecheck CMD] [--test CMD] [--html PATH]` | Check that child issues are closed, the walkthrough exists, the tree is clean, and the typecheck and tests pass |
| `scripts/post-walkthrough.js <prd> [md] [--close]` | Post the walkthrough as a comment on the PRD, and close it only with `--close` |

The verify script detects `npm run typecheck`, `npx tsc --noEmit` and `npm test`. For other projects, pass the commands as flags or set `PRD_CHECK_DIR`, `PRD_TYPECHECK_CMD` and `PRD_TEST_CMD`.
