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
the circuit, a failure re-opens it. Breaker state is scoped to the API endpoint
and credential, so an auth failure in one installation does not pause another
credential. With the same inherited key and `JEV_STATE_DIR`, `resetBreaker()`
from `lib/client.mjs` resets that scope; the older unscoped `breaker.json` is
no longer read.

`TypeSafe 401` or `TypeSafe 403` means authorization was rejected or an edge
service blocked the request; a 403 HTML page alone does not distinguish those
causes. These responses are not retried within a call. After
`JEV_BREAKER_FAILURES` consecutive rejections, the same cooldown skips remote
judgments while deterministic checks continue. An HTML response is logged as
`HTML error page`, not copied into the log. Check the credential and provider
status before changing guard thresholds. A successful trial after the cooldown
restores remote judgments.

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

Guard interruptions name their source in the host prompt:
`Jev approval request (model estimate)` or
`Jev approval request (local check)`. Blocks say `Jev blocked call` instead.
These are Jev decisions; the host may still apply its own permission prompt.
The model estimate compares an edit with the current task text. For brief
follow-ups such as “continue,” “retry …,” option selections (“option 2”, and replies that pick from the assistant’s numbered options: “1, 2 and 3”, “all”, “implement all”, which also carry that assistant message), and scope amendments, Jev
includes recent user directions in chronological order and treats the latest
direction as controlling. Independent new requests stand alone, and explicit
replacement instructions end the older task context. If `intent_mismatch`
repeatedly questions ordinary edits, check that this context captures the
active task before changing the threshold. Decision logs record scores and
reasons, not the full task text or independently verified labels.

Read-only calls suppress most model hazards, but credential exposure and repeat
failure remain relevant. Deterministic checks run before model judgments.
Unknown or malformed model responses must not silently trim output.

A `wrong_scope` ask on a file edit means the target lay outside every
workspace root: the cwd, the host's workspace folders, directories the session
had already written to, the temp directory, and `JEV_WORKSPACE_ROOTS`. Inside
them the question is not asked at all and `signals.not_asked` says so. If a
directory you work in keeps drawing asks, add it to `JEV_WORKSPACE_ROOTS`
rather than raising `JEV_GUARD_ASK_AT`, which lowers every hazard at once.

For shell calls, `wrong_scope` stays in the question batch because a command
may have effects beyond its named path. The judgment should still treat a new
sibling worktree of the current repository and routine Git preflight (`git
config`, account status, `git fetch origin`, revision comparison) as project
work. A worktree in an unrelated shared directory and a command that exposes
an auth token remain hazards. Check the actual command and user request before
labeling a prompt false.

A `repeat_failure` question is not asked when the user has written a new
message since the failed call: the reply is the change a retry needed (for
example "create the label and continue"). A retry with no user turn between
still asks.

An `intent_mismatch` question is not asked when a file tool changes only the
agent's own places: a `.claude/projects/<project>/memory` directory or the
Claude Code session scratchpad (`/tmp/claude-<uid>/<project>/<session>/scratchpad`).
That upkeep runs alongside any task, so the task is no measure of it.
Destruction and exposure are still judged there. The same holds for a shell
command that starts with `cd` into one of those places, keeps every `cd` /
`git -C` there, runs only local file tools (`sed`, `rg`, `cat`, `mv`, `rm`, …;
no `git`, network, environment assignments, or `$(…)` / backticks outside
single quotes), and names no absolute path elsewhere. Other shell commands in
those places stay with the model, whose question says the same.

Work on the repository's own remotes that the task needs — pushing where the
project's policy says work lands by pushing, or creating a label while filing
issues the user asked for — should not read as `wrong_scope`. Policy lines come
from `AGENTS.md`, then `CLAUDE.md`; point `JEV_POLICY_FILES` elsewhere if the
rules live in another file. An explicit user instruction still outranks policy.

The project is not only the session's cwd. `project_remotes` also lists the
remotes of other repositories this call, an earlier successful call, or a
command the user ran themselves (Claude Code `!` input, unless its output shows
`fatal:`, `error:` or `[rejected]`) works in (`cd <dir>`, `git -C <dir>`), each
labelled with its path, up to four. A push
from `cd ~/other-repo &&`, and a later `gh pr merge --repo` on that repo's
remote, are then project work the task can authorize. `project_policy` comes
from the repository a shell command works in (its first `cd` or `git -C`
directory, when that is a repository), else from the cwd's: a feature-branch
push in another repository is not judged against the session repository's
"push straight to main" rule.

Passing a credential to the command that needs it through its environment
(`GH_TOKEN="$(gh auth token …)" gh …`) is not `secret_exposure`; printing,
logging, writing or sending it elsewhere is.

Every PreToolUse log record carries `session_id`, `cwd`, a one-line `call`
summary and a `task_hash`, so an ask can be traced to its call and the request
in force without the transcript.

`JEV_GUARD_SOFT_UNTIL` is an opt-in soft band, off by default. Set above
`JEV_GUARD_ASK_AT` (for example 0.55), asks from `intent_mismatch`,
`wrong_scope`, `invented_target` or `repeat_failure` that all score below it —
on calls that are not wide-reaching — proceed, and the concern is passed to the
model as a note. Destruction and credential exposure are never softened. The
evidence behind 0.55 is four labeled incidents (2026-09-25/26), not a
calibration set; see below before making it a default.

## Tune from evidence

First label expected behavior and inspect applicability, then wording, then
thresholds. Separate false interruptions from missed hazards. Keep tuning cases
separate from held-out evaluation; report denominators, uncertainty, model and
question versions, and repeated-run variation. Five logs can reveal a bug but
cannot establish a calibrated threshold. Use the eval protocol in `evals/`.

Calibration evidence on record, one machine, 2026-09-21, 57 model asks: 38
sat between 0.45 and 0.54, and 33 of those were `wrong_scope` on Edit or Write
calls into a sibling checkout or scratch directory the session was already
working in. That was the question's wording — it named `cwd` alone — and the
fix was `workspace_roots`, after which the question is not asked for such
edits at all. Raising `JEV_GUARD_ASK_AT` to 0.55 would have hidden the same
asks while also lowering every other hazard, and it was reverted once the
cause was fixed. Genuine detections in the same log sat well clear of the
line: `wrong_scope` 0.61 on an edit to the agent's own settings file, and
`intent_mismatch` 0.91–0.93 on edits that did not serve the stated request.
The 0.45 default stands on that evidence; a tighter or looser value needs a
labeled set of its own.

Measure end-to-end latency, including retries and wrapper overhead. The timeout
is per attempt; it is not a total hook deadline. Record p50/p95, cost, and
critical-evidence retention rather than only average latency or fewer lines.
PreToolUse decision logs record `hook_ms` from the start of transcript processing
through the decision path; the historical `ms` field starts after transcript
processing. Neither includes host launch overhead, so use wall time for a full
user-visible measurement.

`jev-slim` records `command_ms`, `ms` (slimming work), and `wrapper_ms` (Node
process start through output submission), plus stdout/stderr byte counts and
the exit code. These timings include different spans; compare whole-command
wall time with a direct run before claiming speed gained. Failed stdout and
the exit code stay exact by default. `JEV_SLIM_FAILURES=1` enables a local-only
diagnostic summary on long failed stdout, retaining exact selected lines and
a private path to the complete stdout. It is an opt-in trial until labeled
failure examples show that essential diagnostics survive. stderr streams as
the command runs and is never slimmed.

A failed judgment waits `(JEV_RETRIES + 1) × JEV_TIMEOUT_MS`: 8 s at the
defaults, which is what every guarded call and wrapped command paid during
the 2026-09-21 provider outage until the breaker opened. `JEV_RETRIES=0`
halves that and leaves sustained outages to the breaker; the retry only ever
helped with a single transient 5xx or 429. Set it where the agent process
will inherit it (Claude Code: `env` in `~/.claude/settings.json`; GUI-launched
agents: the login session; terminals: the shell rc) and start a new session —
a running one keeps the environment it began with.
