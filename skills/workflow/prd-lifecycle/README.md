# prd-lifecycle

An agentic coding skill designed for AI assistants and developers to manage parent PRD tickets and child implementation issue lifecycles in GitHub with automated verification checks and closing walkthrough documentation.

Requires `git`, `node` and an authenticated [`gh`](https://cli.github.com/).

## Installation

With the [skills.sh](https://skills.sh) CLI (add `--agent claude-code` or `--agent codex` to choose an agent, or drop `--global` for a project-local install):

```bash
npx --yes skills add pde201/skills --skill prd-lifecycle --global --yes
```

Or from a clone, with the repository's installer (targets `agents`, `codex` or `claude`; default `agents`):

```bash
git clone https://github.com/pde201/skills.git
./skills/install.sh prd-lifecycle claude
```

The installer also accepts `--dest DIR` for another skills directory and `--force` to replace an existing install; run it with `--help` for details.

## Scripts

| Script | Purpose |
|---|---|
| `scripts/generate-walkthrough.js <md> <html>` | Render a walkthrough Markdown file as a standalone responsive HTML page |
| `scripts/verify-prd-closing.sh <prd> [--dir DIR] [--typecheck CMD] [--test CMD] [--html PATH]` | Check that child issues are closed, the walkthrough exists, the tree is clean, and the typecheck and tests pass |
| `scripts/post-walkthrough.js <prd> [md] [--close]` | Post the walkthrough as a comment on the PRD, and close it only with `--close` |

The verify script detects `npm run typecheck`, `npx tsc --noEmit` and `npm test`. For other projects, pass the commands as flags or set `PRD_CHECK_DIR`, `PRD_TYPECHECK_CMD` and `PRD_TEST_CMD`.

## Tests

```bash
npm test
```

Runs offline against a stub `gh`; needs `git`, `bash` and `jq`.
