# Troubleshooting and tuning

Establish provenance: Jev footer, registered Jev adapter, or matching decision
log. An arbitrary "full output" path or blocked tool call alone proves nothing.

## Installed but apparently inactive

Check the registered source path, host version and activation/trust, restarted
session, inherited switches, then presence of the API key without exposing it.
Read `lib/config.mjs` for current defaults. Distinguish absent registration,
untrusted hooks, unmatched tool names, disabled features, deterministic-only
operation, and remote API failure. Missing credentials do not make hooks inert.

A log full of `by: "code"` with `reason: "no api key"` while the key is set in
your shell means the agent process did not inherit it. GUI-launched agents read
the login session's environment, not shell rc files: publish the key there (on
macOS `launchctl setenv`), then quit and relaunch the app. A process keeps the
environment it started with, so rotating the key also needs a relaunch.

A `jev-slim` record with `reason: "jev unavailable: TypeSafe 422 …"` is a
request the API rejected as malformed. That is a bug in this layer, not a
tuning problem; the outbound body is redacted before it is sent, so check that
redaction has not altered the request's structure.

`jev unavailable: TypeSafe request failed after N attempt(s): …` names what
went wrong on the last attempt: `TypeSafe 503` is a provider outage, `fetch
failed ENOTFOUND` is the network, `timed out after M ms per attempt` is
latency. All three fail open, and the wrapped command still ran; the cost is
the wait, up to `(JEV_RETRIES + 1) × JEV_TIMEOUT_MS` per judgment. After
`JEV_BREAKER_FAILURES` such failures in a row the circuit opens and records
read `jev unavailable: circuit open after N consecutive provider failures
(last: …); retrying in S s` — no request is made and nothing waits. One
trial goes out when `JEV_BREAKER_COOLDOWN_MS` has passed; a success closes
the circuit, a failure re-opens it. Delete `<JEV_STATE_DIR>/breaker.json` to
reset it by hand.

## Recover output

Use the exact Jev footer path and inspect the needed range. If the file is gone,
report that recovery failed. Do not rerun a side-effecting command merely to
recover output. `jev-slim filter` cannot know an upstream exit status; use `exec`
when failure preservation matters.

## Investigate a verdict

The default log is `~/.local/state/jev-hooks/jev-log.jsonl`; `JEV_LOG` selects a
file and `JEV_STATE_DIR` selects the state directory. Record shapes vary by event.
`probabilities` contains raw hazard scores; `signals` describes fired/suppressed
hazards and `not_asked` records inapplicable questions. Inspect `by` to distinguish
code from model decisions. A log entry alone is not a ground-truth label.

Read-only calls suppress most model hazards, but credential exposure and repeat
failure remain relevant. Deterministic checks run before model judgments.
Unknown or malformed model responses must not silently trim output.

## Tune from evidence

First label expected behavior and inspect applicability, then wording, then
thresholds. Separate false interruptions from missed hazards. Keep tuning cases
separate from held-out evaluation; report denominators, uncertainty, model and
question versions, and repeated-run variation. Five logs can reveal a bug but
cannot establish a calibrated threshold. Use the eval protocol in `evals/`.

Measure end-to-end latency, including retries and wrapper overhead. The timeout
is per attempt; it is not a total hook deadline. Record p50/p95, cost, and
critical-evidence retention rather than only average latency or fewer lines.

A failed judgment waits `(JEV_RETRIES + 1) × JEV_TIMEOUT_MS`: 8 s at the
defaults, which is what every guarded call and wrapped command paid during
the 2026-09-21 provider outage until the breaker opened. `JEV_RETRIES=0`
halves that and leaves sustained outages to the breaker; the retry only ever
helped with a single transient 5xx or 429. Set it where the agent process
will inherit it (Claude Code: `env` in `~/.claude/settings.json`; GUI-launched
agents: the login session; terminals: the shell rc) and start a new session —
a running one keeps the environment it began with.
