# Host integration

Run commands from the maintained skill directory. `bin/install.js` and
`install-skill.sh` copy a package; `install.sh` registers hooks. A copied skill
is not updated by pulling a different checkout. Inspect the registered absolute
path before updating, and preserve unrelated configuration.

```bash
./install.sh claude --check
./install.sh codex --check
./install.sh antigravity --check
```

`--check` reports registration only and does not create a missing config file.
For installation use `./install.sh <agent>`; for removal use
`./install.sh <agent> --remove`. Use `all` only when all agents were requested.
Install/remove changes config; install also creates `~/.local/bin/jev-slim`,
which a single-agent removal leaves in place and `all --remove` deletes.
Backups are beside the configuration. Inspect a backup before restoring it so
later unrelated settings are not overwritten. Removal does not purge logs,
briefs, saved output, or copied skill files.

The installers refuse Node below 18, warn below 22 (tests and evals), and warn
when the skill directory looks temporary, because hooks are registered by
absolute path and stop working when that directory is deleted.

| Adapter | Config default / override | Implemented events |
| --- | --- | --- |
| Claude Code | `~/.claude/settings.json` / `CLAUDE_SETTINGS` | PreToolUse, PostToolUseFailure, PreCompact, SessionStart/compact; opt-in PostToolUse/Maven |
| Codex | `${CODEX_HOME:-~/.codex}/hooks.json` / `CODEX_HOOKS` | PreToolUse, PostToolUse (PostToolUseFailure also accepted), UserPromptSubmit, PreCompact, SessionStart, SessionEnd |
| Antigravity | `~/.gemini/config/hooks.json` / `JEV_ANTIGRAVITY_HOOKS`; tool matcher `JEV_ANTIGRAVITY_MATCHER` | PreToolUse, PreInvocation, PostToolUse, Stop |

Skill-copy destinations: `CLAUDE_HOME`, `CODEX_HOME`, `ANTIGRAVITY_HOME` (see
`install-skill.sh --help`).

The table describes adapter assumptions, not verified support in every host
release. Before claiming compatibility record host name, exact version, platform,
event/input shape, trust/feature settings, and actual hook observations. Check
the installed host help or authoritative documentation for its current contract.
No host version has been certified by the offline suite.

Codex integrations may require `/hooks` trust and enabled hooks in the host.
Verify those controls exist in the installed build. Antigravity's config path is
`~/.gemini/config/hooks.json` by default. `JEV_ANTIGRAVITY_MATCHER` controls tool
names registered by its installer.

### Supported Host Capabilities

- **Claude Code**:
  - **PreToolUse**: deterministic safety checks, git safety (force push and sensitive commit detection escalates to `ask`), command output slimming via `updatedInput.command`, and thrashing/goal drift warnings delivered to the model as `hookSpecificOutput.additionalContext`. (`systemMessage` is shown to the user only and carries the slimming notice.)
  - **Opt-in Maven PostToolUse pilot**: `JEV_CLAUDE_POST_SLIM=1 ./install.sh claude` registers a Bash `PostToolUse` hook filtered by the host to Maven commands. For successful, eligible, long Maven stdout, Jev returns `updatedToolOutput` with the original stderr and other result fields. Maven commands are not rewritten; other commands retain the wrapper. Short output, failed tools, interrupted results, and host-truncated output stay untouched. Re-run `./install.sh claude` without the flag to restore the Maven wrapper and remove the pilot hook. This selection is written into the registered hook command; changing the environment alone does not switch an existing installation. Claude Code [documents `updatedToolOutput`](https://code.claude.com/docs/en/hooks#posttooluse-decision-control), but a direct synthetic event does not prove a particular host build applies the rewrite.
  - **PostToolUseFailure**: error triage classifying tool execution failures into structured categories and logging diagnostics. `PostToolUse` fires only after a successful call and carries `tool_response`, never an error, so it is not registered.
  - **PreCompact & SessionStart**: context harvesting and single-use carry-forward brief injection across compaction, bounded to the host's 10,000-character `additionalContext` cap with the full brief kept on disk.
- **Codex**:
  - **PreToolUse**: deterministic safety checks, git safety (`ask`), and command slimming via `updatedInput.command` (handling string and argv shapes).
  - **PostToolUse**: error triage classifying tool execution failures into structured categories. The adapter reads `error` or `tool_result.is_error` and also accepts the event under the name `PostToolUseFailure`; which shape a given Codex build sends is not verified here.
  - **UserPromptSubmit**: prompt stashing for task-directed slimming without guessing transcript formats.
  - **PreCompact & SessionStart**: carry-forward brief injection across compaction.
  - **SessionEnd**: prompt cleanup and Definition of Done verification audit logging, with a single 1.5 s model attempt to stay inside Codex's 3 s cap. It logs; it cannot block.
- **Antigravity**:
  - **PreToolUse**: deterministic checks, git pre-commit/force-push safety, and command output slimming via `overwrite: { CommandLine: ... }`, which Antigravity requires to be paired with `decision: "allow"`; an untripped call gets no output unless `JEV_ANTIGRAVITY_EXPLICIT_ALLOW=1`. The event's `workspacePaths` become workspace roots for the scope judgment; Claude Code and Codex report only `cwd`, so their workspace grows from the directories the session writes to.
  - **PreInvocation**: injects single-use carry-forward briefs across compaction and alerts on repeated tool thrashing or goal drift via `injectSteps`.
  - **PostToolUse**: classifies tool execution errors into structured categories and logs diagnostics. Registered for the same tool matcher as PreToolUse rather than `*`.
  - **Stop**: Definition of Done gate preventing completion via `decision: "continue"` if files were edited without subsequent test verification. It sends one conversation back at most `JEV_DOD_MAX_CONTINUES` times (default 2), keyed by `conversationId`, then stands down and logs `gaveUp: true`; a verified stop resets the count. The counter lives in `JEV_STATE_DIR` as `dod-continues-<hash>.json`.
  - **Skill packaging**: `./install-skill.sh antigravity` installs directly to `~/.gemini/config/skills/jev`.

Restart the target host after registration or environment changes. Verify in
three stages: registration; direct synthetic adapter event; real host tool call.
Direct invocation cannot prove the host loaded/trusted the hook. Use harmless
fixtures; never execute a destructive command to test a guard.

The Claude Maven PostToolUse pilot must remain synchronous: an async hook cannot
replace the result before Claude reads it. It may avoid the extra shell process
and preserve native command behavior, but it still starts a hook process and
may call the provider. Measure full tool wall time and output retention on the
same workloads before claiming a speed gain. Claude Code may truncate the
original result before Jev receives it, so the full-output copy is complete
only relative to the hook input. The pilot skips the recognized truncation
marker and leaves failures to the unmodified `PostToolUseFailure` path.

Resolve `TYPESAFE_API_KEY` from the user's existing secret manager at launch.
Check only whether it is present, never print its value or persist it in settings.
A missing key leaves deterministic local behavior active. An API call incurs
remote data processing and cost; check the data policy first.

Hooks read every `JEV_*` variable from the environment the agent hands them.
Claude Code merges the `env` object from `~/.claude/settings.json` into each
new session, which makes it the right home for machine-level tuning such as
`JEV_RETRIES=0` or a `JEV_WORKSPACE_ROOTS` list of directories that should
always count as the workspace (plain string values; it is not a secret store,
so the key does not belong there). Codex and Antigravity have no equivalent that this
repo can cite: a GUI launch inherits the login session (`launchctl setenv`
on macOS, republished at login by whatever already publishes the key), a
terminal launch inherits the shell rc. In every host a running agent keeps
the environment it started with, so changes need a new session, and for a
GUI launch a relaunch of the app.

For a build that ignores `updatedInput` without explicit approval, keep the
approval boundary and set `JEV_HOOKS_SLIM=0` at host launch. The two `*_ALLOW`
switches are permission changes, as described in SKILL.md, not routine fixes.
