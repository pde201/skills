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
   tail -n 1 ~/.local/state/jev-hooks/jev-log.jsonl | jq '{hook, decision, by, reason, signals, suppressed}'
   ```
2. Identify the decider (`by`):
   - `by: "code"`: Deterministic check triggered (e.g. non-existent file path, absent/ambiguous edit string, directory read, catastrophic shell pattern). Fix the tool arguments in the agent prompt.
   - `by: "jev"`: Model probability threshold crossed. Inspect `signals` for the triggered hazard score and `suppressed` for hazards set aside.
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
4. Restart the agent session to load modified hook configurations.
5. **Completion Criterion**: `./install.sh <agent> --check` prints positive registration, host trust is confirmed, and a test session writes a record to `jev-log.jsonl`.

### 4. Tune Hazard Thresholds and Questions
When investigating false interruptions or missed hazards:
1. Inspect the recorded probabilities in `jev-log.jsonl`:
   ```bash
   jq 'select(.hook == "guard") | {tool, decision, signals, not_asked}' ~/.local/state/jev-hooks/jev-log.jsonl
   ```
2. Diagnose in strict order:
   - **Applicability**: Check if the question should have been skipped (marked `not_asked`).
   - **Question Semantics**: Verify the wording. (e.g., asking whether a target was "seen" flags legitimate derived files; asking whether it was "fabricated" isolates guesses).
   - **Threshold Values**: Adjust thresholds in `lib/config.mjs` only after verifying applicability and semantics across a multi-turn evaluation set.
3. **Completion Criterion**: The revised question or threshold is verified against `evals/cases.json` without regressing held-out cases. Never adjust thresholds based on fewer than 10 labeled traces.

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
2. **No Autonomous Privilege Escalation**: Adapters never emit `permissionDecision: "allow"`. They can escalate to `ask` or `deny`, but cannot bypass the host's existing permission bounds.
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
| `JEV_LOG` | `~/.local/state/jev-hooks/jev-log.jsonl` | Target decision log path. |
| `JEV_STATE_DIR` | `~/.local/state/jev-hooks` | Working directory for briefs, logs, and slim output. |
| `JEV_TIMEOUT_MS` | `800` | Remote judgment timeout before failing open. |

---

## Progressive Disclosure Reference Links
- Detailed host lifecycle and argument translation: [references/integrations.md](references/integrations.md)
- Complete failure triage and root-cause analysis: [references/troubleshooting.md](references/troubleshooting.md)
- Data redaction, PII masking, and network boundaries: [references/data-handling.md](references/data-handling.md)
- Regression test suite and evaluation protocol: [evals/README.md](evals/README.md)
