# jev — a decision layer for coding agents

Three things go wrong in a long agentic coding session, over and over:

- **Tool output is enormous.** A `kubectl get pods` returns 200 lines to tell
  you one pod is crash-looping. The other 199 lines cost tokens, push out
  context, and bring compaction closer.
- **Compaction loses the wrong things.** The summary keeps the narrative and
  drops the constraint the user stated forty turns ago.
- **Tool calls fail for knowable reasons.** An `old_string` that isn't in the
  file. A path that was never observed to exist. The same command that failed
  a minute ago, run again unchanged.

None of these need a reasoning model. They need small, fast judgments —
*is this line relevant to what we're doing, does this command match what was
asked for, would forgetting this hurt* — of the kind
[TypeSafe's Jev](https://docs.typesafe.ai) returns as typed answers and
probabilities in a few hundred milliseconds, for a fraction of a cent.

This is that layer, wired into Claude Code's hooks.

## Install

Two steps, because they do unrelated things. First put the skill somewhere
your agent will find it:

```bash
npx --yes github:pde201/skills/skills/intelligence/jev claude
```

Then register the hooks from the installed copy:

```bash
~/.claude/skills/jev/install.sh          # merge into ~/.claude/settings.json
~/.claude/skills/jev/install.sh --check  # show what is registered
~/.claude/skills/jev/install.sh --remove # take it back out
```

`install.sh` writes the absolute path of the copy it was run from into the
settings, so run it from whichever copy should be the source of truth.

Then put the API key somewhere Claude Code will inherit it. The key never
belongs in the repository:

```zsh
# ~/.zshrc.local
claude() { TYPESAFE_API_KEY="$(op read 'op://Private/TYPESAFE_API_KEY/credential')" command claude "$@"; }
```

With no key set, every hook is inert and the session behaves exactly as if
none of this were installed.

## What each hook does

### Bloated output → `PreToolUse`, rewriting the command

`PostToolUse` cannot rewrite tool output — it can only append context. So the
bloat is prevented rather than cleaned up: a command known to produce a lot of
output is rewritten to run through `jev-slim`, and the oversized version never
enters the context window at all.

`jev-slim` splits the output into blocks and asks Jev, in one batched request:
what kind of output is this, does it report a failure, how much detail does the
current task need, and which blocks matter most. Code does the rest — budget,
selection, and stitching the kept blocks back together with explicit
`[… N lines hidden …]` markers and a path to the full text on disk.

Only commands on a known list get wrapped (`npm`, `pytest`, `kubectl`, `cargo`,
`git`, …), and never when the command streams, needs a terminal, or contains a
heredoc. Everything else runs exactly as written.

### Tool-call errors → `PreToolUse`, denying or asking

Two layers, and the split is the design:

**Code handles what is knowable.** The file doesn't exist. The `old_string`
isn't in it. The `old_string` appears three times. The path is a directory.
The command is `rm -rf /`. A model should never be asked a question that
`existsSync` already answers, and these checks cost nothing and never flake.

**Jev handles what needs judgment.** Does this command do something
materially different from what was asked for? Is it a repeat of one that just
failed, with nothing changed? Would it destroy something nobody asked to
destroy? Would it print a credential? Each is a Noul, asked together in one
request, routed to `ask` or `deny` by threshold with the strictest signal
winning.

### Compaction → `PreCompact` + `SessionStart`

`PreCompact` can only allow or deny compaction; it cannot steer what survives.
So this works in two halves. Before compaction, code harvests candidates from
the transcript — what the user asked for, what failed, what was changed — and
Jev ranks which would be most damaging to forget. Code assembles a brief and
writes it to disk. After compaction, a `SessionStart` hook matching `compact`
injects it and deletes it, so it lands exactly once.

Jev ranks but never writes. Every line of the brief is text that actually
appeared in the session, and user-stated constraints are carried by a code rule
rather than a judgment — those are not the model's call.

## Guarantees

These are enforced in code and covered by tests, not left to the model:

- **A command that exits non-zero is never slimmed.** A failure is the one
  output you must not cut.
- **The hook never emits `permissionDecision: "allow"`.** Self-approving tool
  calls is not something an output filter should be able to do. It can only
  escalate, never widen.
- **Everything fails open.** No key, no network, a timeout, a malformed event,
  an internal exception — all end with the session behaving normally.
- **Nothing is silently dropped.** Hidden lines are counted in the output and
  the full text is on disk.

## Configuration

Every knob is an environment variable, so a machine can dial this down in
`~/.zshrc.local` without editing the skill. See `lib/config.mjs`.

| Variable | Default | What it does |
| --- | --- | --- |
| `JEV_HOOKS` | `1` | Master switch. `0` disables everything. |
| `JEV_HOOKS_SLIM` | `1` | Rewrite bloated commands. |
| `JEV_HOOKS_GUARD` | `1` | Guard tool calls. |
| `JEV_HOOKS_CARRY_FORWARD` | `1` | Carry a brief past compaction. |
| `JEV_SLIM_MIN_LINES` | `60` | Shorter output is never touched. |
| `JEV_TIMEOUT_MS` | `4000` | Per-request timeout. |
| `JEV_GUARD_ASK_AT` | `0.45` | Probability at which a hazard asks. |
| `JEV_GUARD_DENY_AT` | `0.85` | Probability at which a hazard denies. |
| `JEV_MODEL` | `jev-latest` | Model identifier. |

**The thresholds have been measured against a recorded set, not against your
sessions.** As of 2026-09-20 the seven guard cases and three slimming cases in
`test/live.mjs` are judged correctly by a real Jev, with the nearest miss a
`0.45` ask threshold separating a conventional path (below it, unmeasured) from
a fabricated one (`0.59` and `0.71`). That is a margin, not a wide one, and ten
cases are not a distribution.

Every decision is appended to `~/.local/state/jev-hooks/jev-log.jsonl` with
every probability Jev returned — including the ones that fell below the
thresholds, and the ones a hazard raised that were then set aside — along with
latency and cost. The sub-threshold numbers are the point: a log of what fired
can justify raising a threshold and can never justify lowering one. Read the
log before trusting the defaults on work that matters.

## Tests

```bash
node test/run.mjs                        # offline; no key, no network
TYPESAFE_API_KEY=… node test/live.mjs    # real judgments
```

The offline suite covers the mechanics and every fail-open path. The live
script prints what Jev actually said for a set of recorded outputs and tool
calls, with latency and cost, and checks it against what the answers ought to
be — that part cannot be asserted in the abstract.

## Using it outside Claude Code

Hooks are Claude Code's own mechanism; Gemini CLI and Codex have no equivalent.
The engine is deliberately separate from the adapter for that reason:

- `lib/` has no knowledge of Claude Code at all.
- `bin/jev-slim.mjs` is a plain CLI. `jev-slim exec -- '<command>'` runs
  anything and slims what comes back; `jev-slim filter` reads stdin. Any agent
  that can be told to prefix a command, or any shell alias, can use it today.
- `bin/jev-hook.mjs` is the only Claude Code-specific file.

Reaching Codex and Gemini properly needs a second adapter — most likely an MCP
server exposing the same judgments as tools, since that is the integration
point all three have in common. Not built yet.

## Cost

Jev is priced at $0.042 per million input tokens, output free. A slimming call
on a 500-line output is on the order of $0.0002; a guard call is smaller. The
[parallel questions cookbook](https://docs.typesafe.ai/cookbooks/parallel_questions.md)
measures 13 batched questions at 0.27s against a 54k-character document, which
is why every hook here asks all of its questions in a single request.

## As a skill

`SKILL.md` in this directory makes it a Claude Code skill, so the directory
*is* the skill package — the hook scripts, the engine and the tests are its
supporting files, referenced by the relative paths they already have.

The skill is the operating manual, not the mechanism: the hooks are run by
Claude Code, so the skill covers installing and removing them, reading the
decision log, tuning the thresholds against it, and working out why a
particular call was questioned.

### Two files called install

`install.sh` registers the hooks — that is the one the skill and this
README mean everywhere. `install-skill.sh` and `bin/install.js` only copy
this directory into a skills directory; `bin/install.js` is what the `npx`
command above runs, and `install-skill.sh` is the same thing without npm.
