# Skills repo

- Checks: `scripts/check` (CI runs the same script by group). Enable the pre-push hook once: `git config core.hooksPath .githooks`.
- Refresh the installed jev from this checkout: `scripts/reinstall-jev <label>`. Never `npx github:pde201/skills/...`; npm cannot install a repo subdirectory.
- Judge jev's behaviour after a reinstall: `scripts/jev-log`. Live API check: `scripts/jev-live` (needs `op signin` once in the user's shell).
- Context boundaries: [CONTEXT-MAP.md](CONTEXT-MAP.md).
- Run `node --test` only through each skill's `npm test`; bare `node --test` discovers jev's live script.
