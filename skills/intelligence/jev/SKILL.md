---
name: jev
description: >-
  Operate the Jev decision layer (Claude Code, Codex, Antigravity) for output slimming,
  tool guarding, and compaction briefs. Use when tool output displays "[… N lines hidden …]"
  or full-output paths, when a tool call is blocked or questioned by a hook, when inspecting
  or installing hooks via install.sh, or when tuning thresholds in jev-log.jsonl.
---

# Jev Decision Layer

A typed judgment layer integrated into agent hooks to slim high-volume output, guard risky tool calls, and carry forward critical context across compaction.

## Operational Workflows

### 1. Recover Truncated Tool Output
When command output displays `[… N lines hidden …]` and a footer path:
1. Extract the file path from the footer line: `Full output: <path>`.
2. Inspect the file directly using file-viewing or text-search tools on that path.
3. **Completion Criterion**: Desired data is extracted directly from the saved file. Do NOT re-execute the original command, especially if it produced side effects or consumed network/compute resources.

### 2. Diagnose a Questioned or Blocked Tool Call
When a tool call is blocked (`deny`) or requires user escalation (`ask`):
1. Query the latest decision record in `~/.local/state/jev-hooks/jev-log.jsonl`:
   ```bash
   jq -c 'select(.hook=="PreToolUse" and .decision!=null and .decision!="allow") | {tool, decision, by, reason, signals}' ~/.local/state/jev-hooks/jev-log.jsonl | tail -n 1
   ```
   Guard records are logged with `hook: "PreToolUse"` (there is no `"guard"` hook name). `suppressed` and `not_asked` are nested inside `signals`, not top-level. Git-safety records carry `gitSafety: true` and no `by` field; slimming records carry `wrapped`.
2. Identify the decider (`by`):
   - `by: "code"`: Deterministic check triggered (e.g. non-existent file path, absent/ambiguous edit string, directory read, catastrophic shell pattern). Fix the tool arguments in the agent prompt.
   - `by: "jev"`: Model probability threshold crossed (`JEV_GUARD_ASK_AT`, default 0.45; `JEV_GUARD_DENY_AT`, default 0.85). Inspect `signals` for the fired hazard scores, `signals.suppressed` for hazards set aside, and `signals.blast_radius` (0–3, with `blast_radius_label`) for reach; a radius at or above `JEV_GUARD_BLAST_RADIUS_BLOCK` (default 3) escalates on its own.
3. Validate against read-only invariant:
   - Pure reads are interrupted ONLY for `secret_exposure` or `repeat_failure`. All other read hazards are suppressed to prevent interruption fatigue.
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
3. Verify host-specific requirements:
   - **Claude Code**: Verifies `~/.claude/settings.json` has `PreToolUse` (guarding, git safety, command slimming, thrashing warning injection), `PostToolUse` (error triage), `PreCompact`, and `SessionStart`.
   - **Codex**: Verifies `${CODEX_HOME:-~/.codex}/hooks.json` has `PreToolUse` (guarding, git safety, string/argv slimming), `PostToolUse` (error triage), `UserPromptSubmit`, `PreCompact`, `SessionStart`, and `SessionEnd` (Definition of Done audit logging and cleanup). Must approve registered hooks inside Codex via `/hooks`. Confirm `~/.codex/config.toml` does not have `hooks = false`.
   - **Antigravity**: Hooks register in `~/.gemini/config/hooks.json` (overridable via `JEV_ANTIGRAVITY_HOOKS`). Supports `PreToolUse` (guarding, git safety, command slimming via overwrite), `PreInvocation` (carry-forward briefs & thrashing/drift guidance), `PostToolUse` (error triage), and `Stop` (Definition of Done verification gate). Install skill globally via `./install-skill.sh antigravity`.
   Each feature has its own kill switch (see Configuration Reference): `JEV_HOOKS_GUARD`, `JEV_HOOKS_SLIM`, `JEV_HOOKS_CARRY_FORWARD`, `JEV_HOOKS_SUPERVISION`, `JEV_GIT_SAFETY`, `JEV_DOD_GATE`. Prefer these over unregistering a hook.
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

### 5. CLI Execution Without Hooks
To filter or execute commands using Jev directly:
```bash
jev-slim exec --task "<goal>" -- '<command>'
<command> | jev-slim filter --task "<goal>"
```
*Note*: `exec` preserves non-zero exit codes and output on error. `filter` operates purely on stdout stream.

---

## Operating Invariants

1. **Non-Zero Exit Preservation**: Commands that fail (exit code != 0) are NEVER slimmed. Full failure output and exit status are preserved.
2. **No Autonomous Privilege Escalation**: The guard never emits `allow`; it only escalates to `ask` or `deny` and otherwise stays silent, leaving the host's own permission prompt in force. The one exception is slimming self-approval, off by default: with `JEV_CODEX_SLIM_ALLOW=1` the Codex adapter pairs its rewritten command with `permissionDecision: "allow"`, and the Antigravity adapter emits `decision: "allow"` alongside an `overwrite` (and on every untripped call when `JEV_ANTIGRAVITY_EXPLICIT_ALLOW=1`). The Claude Code adapter never emits `allow`.
3. **Safe Fail-Open**: Missing `TYPESAFE_API_KEY`, API timeouts, network failures, or malformed JSON payload will fail open. The host session continues uninterrupted; deterministic checks continue locally.
4. **Zero Silent Dropping**: Output truncation always counts hidden lines and writes the full raw text to a disk artifact before returning.

---

## Configuration Reference

| Variable | Default | Purpose |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | *(None)* | Authentication key. When absent, remote judgments fail open safely. |
| `JEV_HOOKS` | `1` | Global kill-switch (`0` disables all hooks). |
| `JEV_HOOKS_SLIM` | `1` | Enable/disable command output slimming. |
| `JEV_HOOKS_GUARD` | `1` | Enable/disable pre-tool execution guard. |
| `JEV_HOOKS_CARRY_FORWARD` | `1` | Enable/disable post-compaction brief injection. |
| `JEV_HOOKS_SUPERVISION` | `1` | Enable/disable thrashing/goal-drift warnings and PostToolUse error triage. |
| `JEV_GIT_SAFETY` | `1` | Enable/disable the pre-commit and force-push checks on git commands. |
| `JEV_DOD_GATE` | `1` | Enable/disable the Definition of Done gate (Antigravity `Stop`, Codex `SessionEnd`). |
| `JEV_GUARD_ASK_AT` | `0.45` | Hazard probability at which the guard escalates to `ask`. |
| `JEV_GUARD_DENY_AT` | `0.85` | Hazard probability at which the guard escalates to `deny`. |
| `JEV_GUARD_BLAST_RADIUS_BLOCK` | `3` | Blast-radius score (0–3) at or above which a call escalates regardless of hazard. |
| `JEV_THRASHING_THRESHOLD` | `0.75` | Probability above which a thrashing/drift warning is injected. |
| `JEV_SLIM_MIN_LINES` | `60` | Output shorter than this is never slimmed. |
| `JEV_CODEX_SLIM_ALLOW` | `0` | Codex only: pair a slimmed rewrite with `permissionDecision: "allow"`. |
| `JEV_ANTIGRAVITY_EXPLICIT_ALLOW` | `0` | Antigravity only: emit `decision: "allow"` on untripped calls instead of staying silent. |
| `JEV_LOG` | `<JEV_STATE_DIR>/jev-log.jsonl` | Target decision log path. |
| `JEV_STATE_DIR` | `~/.local/state/jev-hooks` | Directory for briefs, supervision state and the decision log. Full slim output is written to a private directory under the OS temp dir, not here. |
| `JEV_TIMEOUT_MS` | `4000` | Remote judgment timeout before failing open. |

---

## Progressive Disclosure Reference Links
- Detailed host lifecycle and argument translation: [references/integrations.md](references/integrations.md)
- Complete failure triage and root-cause analysis: [references/troubleshooting.md](references/troubleshooting.md)
- Data redaction, PII masking, and network boundaries: [references/data-handling.md](references/data-handling.md)
- Regression test suite and evaluation protocol: [evals/README.md](evals/README.md)
