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
Install/remove changes config; install also creates `~/.local/bin/jev-slim`.
Backups are beside the configuration. Inspect a backup before restoring it so
later unrelated settings are not overwritten. Removal does not purge logs,
briefs, saved output, or copied skill files.

| Adapter | Config default / override | Implemented events |
| --- | --- | --- |
| Claude Code | `~/.claude/settings.json` / `CLAUDE_SETTINGS` | PreToolUse, PreCompact, SessionStart/compact |
| Codex | `${CODEX_HOME:-~/.codex}/hooks.json` / `CODEX_HOOKS` | Same plus UserPromptSubmit and SessionEnd |
| Antigravity | `~/.gemini/config/hooks.json` / `JEV_ANTIGRAVITY_HOOKS` | PreToolUse, PreInvocation, PostToolUse, Stop |

The table describes adapter assumptions, not verified support in every host
release. Before claiming compatibility record host name, exact version, platform,
event/input shape, trust/feature settings, and actual hook observations. Check
the installed host help or authoritative documentation for its current contract.
No host version has been certified by the offline suite.

Codex integrations may require `/hooks` trust and enabled hooks in the host.
Verify those controls exist in the installed build. Antigravity's config path is
`~/.gemini/config/hooks.json` by default. `JEV_ANTIGRAVITY_MATCHER` controls tool
names registered by its installer. Antigravity supports:
- **PreToolUse guard & slimming**: deterministic checks, git pre-commit/force-push safety, and command output slimming via `overwrite: { CommandLine: ... }`.
- **PreInvocation context & guidance**: injects single-use carry-forward briefs across compaction and alerts on repeated tool thrashing or goal drift via `injectSteps`.
- **PostToolUse error triage**: classifies tool execution errors into structured categories and logs diagnostics.
- **Stop Definition of Done gate**: prevents termination via `decision: "continue"` if files were edited without subsequent test verification.
- **Skill packaging**: `./install-skill.sh antigravity` installs directly to `~/.gemini/config/skills/jev`.

Restart the target host after registration or environment changes. Verify in
three stages: registration; direct synthetic adapter event; real host tool call.
Direct invocation cannot prove the host loaded/trusted the hook. Use harmless
fixtures; never execute a destructive command to test a guard.

Resolve `TYPESAFE_API_KEY` from the user's existing secret manager at launch.
Check only whether it is present, never print its value or persist it in settings.
A missing key leaves deterministic local behavior active. An API call incurs
remote data processing and cost; check the data policy first.

For a build that ignores `updatedInput` without explicit approval, keep the
approval boundary and set `JEV_HOOKS_SLIM=0` at host launch. The two `*_ALLOW`
switches are permission changes, as described in SKILL.md, not routine fixes.
