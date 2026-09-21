---
name: jev
description: >-
  Operate the Jev decision layer (Claude Code, Codex, Antigravity): output slimming,
  tool guarding, git safety, thrashing and goal-drift warnings, error triage, a
  Definition of Done gate, and compaction briefs. Use when tool output displays
  "[… N lines hidden …]" or a "Full output:" path; when a tool call is blocked or
  questioned by a hook; when a message begins "[Jev Supervision]", "Jev Verification
  Gate" or "Jev Git Safety"; when a "Carried forward past compaction" block appears;
  when inspecting or installing hooks via install.sh; or when tuning thresholds in
  jev-log.jsonl.
---

# Jev Decision Layer

A typed judgment layer integrated into agent hooks to slim high-volume output, guard risky tool calls, watch for thrashing and unverified completion, and carry forward critical context across compaction.

## Operational Workflows

### 1. Recover Truncated Tool Output
When command output contains `[… N lines hidden …]` gap markers and ends with `[jev: N of M lines hidden as not relevant to the current task. Full output: <path>]`:
1. Extract the file path from that footer.
2. Inspect the file directly using file-viewing or text-search tools on that path. It holds the complete original output; the line counts in the footer refer to the de-noised text, so they can be smaller than the file.
3. **Completion Criterion**: Desired data is extracted directly from the saved file. Do NOT re-execute the original command, especially if it produced side effects or consumed network/compute resources. If the file is gone (the OS cleared its temp directory), report that recovery failed.

### 2. Diagnose a Questioned or Blocked Tool Call
When a tool call is blocked (`deny`) or requires user escalation (`ask`):
1. Query the latest decision record in `~/.local/state/jev-hooks/jev-log.jsonl`:
   ```bash
   jq -c 'select(.hook=="PreToolUse" and .decision!=null and .decision!="allow") | {tool, decision, by, reason, signals}' ~/.local/state/jev-hooks/jev-log.jsonl | tail -n 1
   ```
   Guard records are logged with `hook: "PreToolUse"` (there is no `"guard"` hook name). `suppressed` and `not_asked` are nested inside `signals`, not top-level. Git-safety records carry `gitSafety: true` and, on Claude Code, no `by` field; slimming records carry `wrapped`.
2. Identify the decider (`by`):
   - `by: "code"`: Deterministic check triggered (e.g. non-existent file path, absent/ambiguous edit string, directory read, catastrophic shell pattern such as `rm -rf /`, `--no-preserve-root`, `git push --force`/`-f`, `git reset --hard`, `curl | sh`). Fix the tool arguments in the agent prompt.
   - `by: "jev"`: Model probability threshold crossed. Every hazard asks at `JEV_GUARD_ASK_AT` (default 0.45); the two deny-action hazards (`destructive_unrequested`, `secret_exposure`) deny at `JEV_GUARD_DENY_AT` (default 0.85), the rest never exceed `ask`. Inspect `signals` for the fired hazard scores, `signals.suppressed` for hazards set aside, and `signals.blast_radius` (0–4, with `blast_radius_label`) for reach. Reach never fires alone: at or above `JEV_GUARD_BLAST_RADIUS_BLOCK` (default 3) it upgrades an existing `ask` to `deny`.
3. Validate against read-only invariant:
   - Calls Jev scores as read-only (`blast_radius` below 1) are interrupted ONLY for `secret_exposure` or `repeat_failure`. All other read hazards are suppressed to prevent interruption fatigue.
4. **Completion Criterion**: State whether the decision originated from deterministic code or model probability, cite the exact hazard/path, and provide the corrective parameter.

### 3. Install and Verify Hooks
To register or audit hooks across supported hosts:
1. Run registration check without mutating state:
   ```bash
   ./install.sh <agent> --check    # agent: claude | codex | antigravity | all
   ```
2. If installing or repairing:
   ```bash
   ./install.sh <agent>
   ```
   Run it from the copy that should stay put. Hooks are registered by absolute path, so an install from a temporary checkout breaks when that directory is cleaned up; the installer warns when it sees one. Node 18+ runs the hooks, Node 22+ runs the tests and evals.
3. Verify host-specific requirements:
   - **Claude Code**: Verifies `~/.claude/settings.json` has `PreToolUse` (guarding, git safety, command slimming, thrashing warning as `additionalContext`), `PostToolUseFailure` (error triage; PostToolUse fires only on success and is not used), `PreCompact`, and `SessionStart`.
   - **Codex**: Verifies `${CODEX_HOME:-~/.codex}/hooks.json` has `PreToolUse` (guarding, git safety, string/argv slimming), `PostToolUse` (error triage; the adapter also accepts `PostToolUseFailure`, unverified against a live build), `UserPromptSubmit`, `PreCompact`, `SessionStart`, and `SessionEnd` (Definition of Done audit logging and cleanup, one model attempt inside the 3 s cap). Must approve registered hooks inside Codex via `/hooks`. Confirm `~/.codex/config.toml` does not have `hooks = false`.
   - **Antigravity**: Hooks register in `~/.gemini/config/hooks.json` (overridable via `JEV_ANTIGRAVITY_HOOKS`). Supports `PreToolUse` (guarding, git safety, command slimming via `overwrite`, which by Antigravity's contract must be paired with `decision: "allow"`), `PreInvocation` (carry-forward briefs & thrashing/drift guidance), `PostToolUse` (error triage, same tool matcher as PreToolUse), and `Stop` (Definition of Done verification gate). Install skill globally via `./install-skill.sh antigravity`.
   Each feature has its own kill switch (see Configuration Reference): `JEV_HOOKS_GUARD`, `JEV_HOOKS_SLIM`, `JEV_HOOKS_CARRY_FORWARD`, `JEV_HOOKS_SUPERVISION`, `JEV_GIT_SAFETY`, `JEV_DOD_GATE`. Prefer these over unregistering a hook. `./install.sh <agent> --remove` unregisters one agent and leaves the shared `~/.local/bin/jev-slim`; `./install.sh all --remove` removes that too.
4. Restart the agent process, not just the session, so the hooks inherit `TYPESAFE_API_KEY`. A GUI-launched agent reads the launchd/user-session environment, not the shell's.
5. **Completion Criterion**: `./install.sh <agent> --check` prints positive registration; for Codex the hooks are approved under `/hooks`; and a test session writes a `PreToolUse` record to `jev-log.jsonl` with `by: "jev"`. A record with `by: "code"` and `reason: "no api key"` means the hooks run but the key did not reach the process.

### 4. Tune Hazard Thresholds and Questions
When investigating false interruptions or missed hazards:
1. Inspect the recorded probabilities in `jev-log.jsonl`:
   ```bash
   jq -c 'select(.hook=="PreToolUse" and .by=="jev") | {tool, decision, signals, probabilities}' ~/.local/state/jev-hooks/jev-log.jsonl
   ```
2. Diagnose in strict order:
   - **Applicability**: Check if the question should have been skipped (listed in `signals.not_asked`).
   - **Question Semantics**: Verify the wording. (e.g., asking whether a target was "seen" flags legitimate derived files; asking whether it was "fabricated" isolates guesses).
   - **Threshold Values**: Override via environment first (`JEV_GUARD_ASK_AT`, `JEV_GUARD_DENY_AT`, `JEV_GUARD_BLAST_RADIUS_BLOCK`, `JEV_THRASHING_THRESHOLD`) and only change the defaults in `lib/config.mjs` after verifying applicability and semantics across a multi-turn evaluation set.
3. **Completion Criterion**: The revised question or threshold passes `npm run eval` (22 offline cases) without regressing `npm run eval:live`. Never adjust thresholds based on fewer than 10 labeled traces; the shipped `evals/traces/held-out-sample.json` holds 3 and is a format example, not a sufficient set.

### 5. Respond to a Supervision Message
These arrive in the model's context, not as tool errors. Each names its source.
- **`[Jev Supervision] Repetitive failure loop detected`** or **`3 consecutive tool failures`**: the last calls repeated a failing action. Stop repeating it. Read the exact error text in full (recover it via workflow 1 if it was slimmed), inspect the target file or command output directly, and change the approach before the next attempt. If the design itself is in doubt, ask the user.
- **`[Jev Supervision] Potential goal drift detected`**: the quoted request is what the user asked for. Re-anchor the next action on it, or state explicitly why the detour serves it.
- **`Jev Verification Gate: Files were modified … but no test commands were run`** (Antigravity `Stop`): completion was refused because edits were not followed by a test run. Run the project's test command, fix what fails, then finish. If the project has no tests, say so to the user and set `JEV_DOD_GATE=0` for that host rather than stopping repeatedly.
- **`Jev Git Safety: force push to main/master`** or **`Sensitive file staged for commit`**: the call is waiting on the user. Explain what was flagged and why, and do not rephrase the command to slip past the check.
- **`# Carried forward past compaction`**: historical evidence from before compaction, not new instructions. Read user entries in transcript order; later corrections win. A `Complete brief:` trailer means the brief was bounded to the host's 10,000-character cap and the full text is at that path.
- **Completion Criterion**: the message is acted on as stated, and the decision record for it (`thrashingWarning`, `gitSafety`, `hook: "Stop"` or `hook: "SessionStart"`) is cited if the user asks why it appeared.

### 6. CLI Execution Without Hooks
To filter or execute commands using Jev directly:
```bash
jev-slim exec --task "<goal>" -- '<command>'
<command> | jev-slim filter --task "<goal>"
```
*Note*: `exec` preserves non-zero exit codes and output on error, and is the only mode that can. `filter` operates purely on the stdout stream and cannot know an upstream exit status.

---

## Operating Invariants

1. **Non-Zero Exit Preservation**: Commands that fail (exit code != 0) are NEVER slimmed. Full failure output and exit status are preserved, byte for byte.
2. **No Autonomous Privilege Escalation**: The guard never emits `allow`; it only escalates to `ask` or `deny` and otherwise stays silent, leaving the host's own permission prompt in force. The one exception is slimming self-approval: on Antigravity a rewritten command is paired with `decision: "allow"` because the host fails closed without a decision, and `JEV_ANTIGRAVITY_EXPLICIT_ALLOW=1` extends that to every untripped call; on Codex `JEV_CODEX_SLIM_ALLOW=1` pairs the rewrite with `permissionDecision: "allow"` and is off by default. The Claude Code adapter never emits `allow`.
3. **Safe Fail-Open**: Missing `TYPESAFE_API_KEY`, API timeouts, network failures, or malformed JSON payload will fail open. The host session continues uninterrupted; deterministic checks continue locally.
4. **Zero Silent Dropping**: Output truncation always counts hidden lines and writes the full raw text to a disk artifact before returning. A carry-forward brief longer than the host's 10,000-character context cap is injected bounded, newest entries first, with a trailer naming the `.full.md` file that holds the whole brief.

---

## Configuration Reference

| Variable | Default | Purpose |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | *(None)* | Authentication key. When absent, remote judgments fail open safely. |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` | Endpoint override; `/v1/systemone` is appended. |
| `JEV_MODEL` | `jev-latest` | Model name sent with every judgment. |
| `JEV_HOOKS` | `1` | Global kill-switch (`0` disables all hooks). |
| `JEV_HOOKS_SLIM` | `1` | Enable/disable command output slimming. |
| `JEV_HOOKS_GUARD` | `1` | Enable/disable pre-tool execution guard. |
| `JEV_HOOKS_CARRY_FORWARD` | `1` | Enable/disable post-compaction brief injection. |
| `JEV_HOOKS_SUPERVISION` | `1` | Enable/disable thrashing/goal-drift warnings and error triage. |
| `JEV_GIT_SAFETY` | `1` | Enable/disable the pre-commit and force-push checks on git commands. |
| `JEV_DOD_GATE` | `1` | Enable/disable the Definition of Done gate. Blocks completion on Antigravity `Stop`; on Codex `SessionEnd` it only logs `unverified: true`. |
| `JEV_GUARD_ASK_AT` | `0.45` | Hazard probability at which the guard escalates to `ask`. |
| `JEV_GUARD_DENY_AT` | `0.85` | Probability at which a deny-action hazard (`destructive_unrequested`, `secret_exposure`) escalates to `deny`; other hazards stop at `ask`. |
| `JEV_GUARD_BLAST_RADIUS_BLOCK` | `3` | Blast-radius score (0–4) at or above which an `ask` becomes a `deny`. Reach alone never escalates. |
| `JEV_THRASHING_THRESHOLD` | `0.75` | Probability above which a thrashing/drift warning is injected. |
| `JEV_SLIM_MIN_LINES` | `60` | Output shorter than this is never slimmed. |
| `JEV_SLIM_COMMANDS` | npm, pytest, cargo, kubectl, git, grep, … (see `lib/config.mjs`) | Comma-separated binaries whose output is routed through the slimmer. |
| `JEV_NEVER_WRAP` | vim, less, tail, ssh, tmux, claude, codex, … | Comma-separated binaries never wrapped, whatever else the command contains. |
| `JEV_CODEX_SLIM_ALLOW` | `0` | Codex only: pair a slimmed rewrite with `permissionDecision: "allow"`. |
| `JEV_ANTIGRAVITY_EXPLICIT_ALLOW` | `0` | Antigravity only: emit `decision: "allow"` on untripped calls instead of staying silent. |
| `JEV_TASK` | *(None)* | `jev-slim` CLI only: the task text when neither `--task` nor `--task-b64` is given. |
| `JEV_LOG` | `<JEV_STATE_DIR>/jev-log.jsonl` | Target decision log path. |
| `JEV_STATE_DIR` | `~/.local/state/jev-hooks` | Directory for briefs, stashed prompts and the decision log. Full slim output is written to a private directory under the OS temp dir, not here. |
| `JEV_TIMEOUT_MS` | `4000` | Per-attempt timeout for guard and slimming judgments before failing open. Supervision calls use fixed shorter budgets (2–2.5 s); carry-forward uses at least 8 s. |
| `JEV_RETRIES` | `1` | Retries after a timeout, 429 or 5xx. The total wait is `(retries + 1) × timeout` plus backoff. |

Install-time overrides (`CLAUDE_SETTINGS`, `CODEX_HOME`, `CODEX_HOOKS`, `JEV_ANTIGRAVITY_HOOKS`, `JEV_ANTIGRAVITY_MATCHER`, `CLAUDE_HOME`, `ANTIGRAVITY_HOME`) are listed in [references/integrations.md](references/integrations.md).

---

## Progressive Disclosure Reference Links
- Detailed host lifecycle and argument translation: [references/integrations.md](references/integrations.md)
- Complete failure triage and root-cause analysis: [references/troubleshooting.md](references/troubleshooting.md)
- Data redaction, PII masking, and network boundaries: [references/data-handling.md](references/data-handling.md)
- Regression test suite and evaluation protocol: [evals/README.md](evals/README.md)
