# Jev decision layer

Jev adds optional judgments to coding-agent hooks: selecting useful tool output,
checking tool calls, and carrying context across compaction. Code owns execution,
validation, storage, and permissions; the model supplies rankings and scores.

[SKILL.md](SKILL.md) is the operating entrypoint. Use its task-specific references
for installation, troubleshooting, data handling, and evaluation.

## Architecture

- `bin/jev-hook*.mjs` translates each host's events and verdicts.
- `lib/guard.mjs` runs deterministic checks before model hazard scoring, and
  judges scope against the workspace (cwd, host folders, directories already
  written to, temp, `JEV_WORKSPACE_ROOTS`) rather than the cwd alone.
- `lib/wrap.mjs` decides which shell commands are worth routing through the
  slimmer and builds the rewrite; `lib/config.mjs` holds every knob and default.
- `lib/slim.mjs` preserves full local output and selects ranked blocks only after
  a valid response. `bin/jev-slim.mjs` supplies exec and filter modes.
- `lib/supervision.mjs` provides git safety, thrashing and goal-drift detection,
  error triage, and the Definition of Done gate.
- `lib/carryforward.mjs` preserves chronological user context and selects optional
  history. Historical requests and failures require reconciliation with later turns.
- `lib/transcript.mjs` reads each host's transcript format and strips the text
  hosts inject into user turns (system reminders, hook notices, terminal relays).
- `lib/client.mjs` handles redacted remote requests and response validation;
  `lib/privacy.mjs` is the redaction and private-file layer both use.
- `lib/log.mjs` records decisions for investigation and labeled evaluation.

The guard never self-approves a call. Slimming self-approval exists where a host
requires it: Antigravity pairs an `overwrite` with `decision: "allow"` by default
because it fails closed without one; Codex does so only under
`JEV_CODEX_SLIM_ALLOW=1`; Claude Code never. Missing credentials leave local
deterministic features active. Model/API failure adds no model restriction and
leaves output intact; Jev is not an enforcement boundary.

## Validation

Node 18+ runs the hooks (built-in `fetch`). Node 22+ and `jq` are required for
the full offline suite. Run from this directory:

```bash
npm test
npm run eval:self-test
```

The live smoke script is separate: `node test/live.mjs` requires an inherited
`TYPESAFE_API_KEY` and approved synthetic data. Its small fixture set is not a
calibration distribution. See [evals](evals/README.md) for behavioral cases,
scoring, held-out judgments, repeated trials, and host integration evidence.

Offline adapter checks do not certify any host release. Record actual host
versions and observed behavior before marking an integration verified. Avoid
bare `node --test`, which may discover the live script.

## Packaging and rollout

`bin/install.js` and `install-skill.sh` copy the skill plus its implementation,
references, tests, and evals. `install.sh <agent>` separately registers the copy
whose absolute path should run. Check that path before updating. Retain the prior
copy and config backup for rollback; review permission changes independently.

Dependencies remain Node built-ins plus `jq` in shell installers. Keep shared
mechanics in `lib/`; add host-specific behavior to its adapter. Test semantic
outcomes, output preservation, permissions, and evidence retention before using
compression or speed improvements as release criteria.
