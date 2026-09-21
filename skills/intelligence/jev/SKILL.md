---
name: jev
description: >-
  Operate the Jev decision layer — Claude Code hooks that slim bloated tool
  output, guard risky tool calls, and carry a brief across compaction, using
  TypeSafe's Jev for the judgments. Use when asked to install, check, remove
  or update the Jev hooks; when TYPESAFE_API_KEY, jev-slim, jev-hook or
  JEV_* environment variables come up; when output arrives truncated with
  "[… N lines hidden …]" markers or a "full output" path; when a tool call is
  unexpectedly questioned or blocked by a hook; when a brief is injected after
  a compaction; or when tuning thresholds from jev-log.jsonl.
---

# Jev decision layer

A set of Claude Code hooks that spend a few hundred milliseconds and a
fraction of a cent on a small typed judgment instead of letting three
recurring problems eat the context window: tool output that is mostly
noise, compaction that drops the wrong things, and tool calls that fail
for reasons something could have known in advance.

This skill is the operating manual. The hooks are run by Claude Code
itself, not invoked by the model, so there is nothing here to "call" —
what follows is how to install them, read what they decided, tune them,
and work out why they did something.

`README.md` next to this file has the design and the reasoning behind it.
Read it before changing behaviour; read this before running anything.

## Layout

Every path below is relative to this skill's own directory.

| Path | What it is |
| --- | --- |
| `install.sh` | Merges the hooks into `~/.claude/settings.json` |
| `bin/jev-hook.mjs` | The only Claude Code-specific file; one entry point for every hook event |
| `bin/jev-slim.mjs` | Standalone CLI — runs or filters a command and prints less of it |
| `lib/` | The engine. No knowledge of Claude Code at all |
| `lib/config.mjs` | Every knob, with its default and why it is that value |
| `test/run.mjs` | Offline suite; needs no key and no network |
| `test/live.mjs` | Prints real judgments with latency and cost |
| `bin/install.js`, `install-skill.sh` | Packaging only — copy this directory into a skills directory |

Requires `node` and `jq` on `PATH`. No npm
dependencies — these run on every tool call, so they depend on nothing.

## Installing

```bash
./install.sh            # install or update
./install.sh --check    # show what is registered
./install.sh --remove   # take it back out
```

`install.sh` is the hook installer and the only one that matters here.
`install-skill.sh` and `bin/install.js` share the name by accident: they
copy this directory into a skills directory and register nothing.

It merges into `~/.claude/settings.json` rather than symlinking, because
Claude Code writes to that file itself. Re-running replaces only the Jev
entries and leaves the rest untouched, and every run backs the file up
first. Three events get registered: `PreToolUse` (guard and slim),
`PreCompact` (write the brief), and `SessionStart` matching `compact`
(inject it).

**Hooks are read at session start.** After installing, removing or
re-pointing them, a running session keeps the old configuration — start a
new one.

**`install.sh` registers whatever copy of itself it was run from.** It
resolves its own directory and writes that absolute path into the
settings, so running it out of a skills-manager copy points the hooks at
the copy, and a later `git pull` in a checkout will not reach them. If a
checkout is meant to be the source of truth, run `install.sh` from there,
or install the skill as a symlink rather than a copy.

### The API key

The hooks read `TYPESAFE_API_KEY` from the environment they inherit.
**With no key set every hook is inert** and the session behaves exactly as
if none of this were installed, so a missing key is a silent no-op, not an
error. That is also the first thing to check when it appears to be doing
nothing.

The key never belongs in the repository. Resolve it at launch rather than in
every shell:

```zsh
# ~/.zshrc.local — not tracked
claude() { TYPESAFE_API_KEY="$(op read 'op://Private/TYPESAFE_API_KEY/credential')" command claude "$@"; }
```

Never print the key, never pass it as a command-line argument, and never
write it into a settings file or a commit.

## What it does, and the rules it will not break

Four properties are enforced in code and covered by tests. Do not work
around them; if one is in the way, the design is what needs changing.

- **A command that exits non-zero is never slimmed.** A failure is the one
  output you must not cut.
- **The hook never emits `permissionDecision: "allow"`.** It can escalate
  to `ask` or `deny`, never widen. An output filter should not be able to
  self-approve a tool call.
- **Everything fails open.** No key, no network, a timeout, a malformed
  event, an internal exception — all end with the session behaving
  normally.
- **Nothing is silently dropped.** Hidden lines are counted in the output
  and the full text is written to disk, with the path in the footer.

Two constraints in Claude Code's hook contract shape the whole design, and
are worth knowing before proposing a change:

- `PostToolUse` **cannot rewrite tool output**, only append to it. So
  bloat is prevented at `PreToolUse` via `updatedInput` rather than
  trimmed afterwards.
- `PreCompact` **cannot steer what a compaction keeps** — it is allow or
  deny only. So it writes a brief to disk and a `SessionStart` hook
  matching `compact` injects it afterwards, exactly once.

## Turning parts of it off

Every knob is an environment variable, so a machine can dial this down
without editing the skill. `lib/config.mjs` is the full list with current
defaults — read it there rather than trusting a value quoted elsewhere.
The switches:

```bash
JEV_HOOKS=0                 # everything off
JEV_HOOKS_SLIM=0            # keep the guard, stop rewriting commands
JEV_HOOKS_GUARD=0           # keep slimming, stop guarding tool calls
JEV_HOOKS_CARRY_FORWARD=0   # stop carrying a brief past compaction
```

If a user wants it off *now*, in a running session, an environment
variable will not reach the already-started hooks reliably — run
`./install.sh --remove` and start a new session.

## Reading what it decided

Every decision is appended to `~/.local/state/jev-hooks/jev-log.jsonl`,
one JSON object per line, and the hooks never read it back. Each record
carries `hook`, `decision`, `by` (`code` or `jev`), `reason`, `signals`
(the probability behind each hazard), `ms` and `cost_usd`. This is the
answer to "why did that happen", and to almost every tuning question.

```bash
LOG=~/.local/state/jev-hooks/jev-log.jsonl

tail -5 "$LOG" | jq .                                      # the last few decisions
jq 'select(.decision == "deny" or .decision == "ask")' "$LOG"
jq -s 'map(.ms // empty) | add / length' "$LOG"            # mean latency
jq -s 'map(.cost_usd // 0) | add' "$LOG"                   # what it has cost
```

Override the location with `JEV_LOG` for a single file, or `JEV_STATE_DIR`
to move the whole state directory.

**The default thresholds have been measured against a recorded set, not
against your sessions.** The README says what was measured and how much
room the nearest one has.

When asked to tune them, work from this log on real sessions — and reach
for the threshold last. A wrong judgment is far more often a question that
asks something other than what you meant. The first live run here had
`invented_target` at 0.76 on `src/api/client.test.ts`, because it asked
whether the path had been *seen* this session when the hazard is about
whether it was *fabricated*; a test file named after a source file in
evidence is an obvious inference, not a guess. No threshold separates that
0.76 from the 0.86 of a genuinely invented path. Rewording the question
moved the classes apart — conventional paths below `ask`, fabricated ones
at 0.59 and 0.71 — which no amount of moving the number could have done.

Every probability is logged, including those that fired nothing and those
a hazard raised that were then set aside. That is what makes *lowering* a
threshold possible: a log of only what crossed the line can argue for
raising one and never for lowering one, so a question that has quietly
stopped matching anything looks exactly like a question with nothing to
catch. Change a number only once you are sure the question is right, and
raising `deny` is safer than lowering it: `ask` is cheap, `deny` is not.

## Troubleshooting

**Nothing appears to happen.** In order: is `TYPESAFE_API_KEY` set in the
environment Claude Code was launched from; did the session start after
the install; does `./install.sh --check` list the hooks; is `JEV_HOOKS=0`
set anywhere. Then look for entries in the log.

**Output was cut and the user wants the rest.** It was never lost. The
footer carries the path to the full text on disk. Read that file rather
than re-running the command.

**A command that should not be slimmed is being slimmed.** Only commands
on a known list get wrapped, and never when they stream, need a terminal,
or contain a heredoc. Both lists are `slimCommands` and `neverWrap` in
`lib/config.mjs`, and both are overridable by environment variable —
prefer adding to `JEV_NEVER_WRAP` over editing the file.

**A tool call was questioned or blocked and the user disagrees.** Find it
in the log: the entry says whether code or Jev decided, and on what
probability. Code handles what is knowable (a file that does not exist, an
`old_string` that is absent or ambiguous, `rm -rf /`) — those are not
threshold questions and a disagreement there is a bug worth reporting.
Jev handles judgment, and those are tunable as above.

**Hooks are slowing the session down.** Check the latency in the log
before assuming. `JEV_TIMEOUT_MS` bounds each request; a judgment that has
not returned by then is abandoned and the call proceeds.

## Using it without the hooks

`bin/jev-slim.mjs` is a plain CLI and knows nothing about Claude Code.
`install.sh` symlinks it to `~/.local/bin/jev-slim`.

```bash
jev-slim exec --task "why is the build failing" -- 'npm run build'
some-noisy-command | jev-slim filter --task "find the migration error"
```

Any agent that can be told to prefix a command, and any shell alias, can
use it today. Hooks are Claude Code's own mechanism — Gemini CLI and Codex
have no equivalent, and reaching them properly needs a second adapter,
most likely an MCP server exposing the same judgments. That is not built.

## Changing it

```bash
node --test test/run.mjs                 # offline; no key, no network
TYPESAFE_API_KEY=… node test/live.mjs    # real judgments, latency, cost
```

Name `test/run.mjs` explicitly. Bare `node --test` sweeps the directory
and picks up `test/live.mjs`, which fails by design without a key, and
`node --test test/` does not resolve as a directory on Node 22.

The offline suite covers the mechanics and every fail-open path, and must
stay green. The live script is how the judgments themselves get checked —
whether a threshold is right is not something the offline tests can
assert.

Keep `lib/` free of any Claude Code knowledge; `bin/jev-hook.mjs` is the
only place that belongs. New questions go into an existing batched request
where one exists: questions batched over one state are scored
independently, so batching changes no answer and costs a single round
trip.
