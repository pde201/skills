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

This is that layer, wired into the lifecycle hooks of Claude Code, Codex and
Antigravity. `lib/` is the engine and knows about none of them; each agent gets
one adapter in `bin/`.

## What works where

Not every agent exposes the same hooks, and the gaps are not papered over.

| | Claude Code | Codex | Antigravity |
| --- | --- | --- | --- |
| Guard tool calls | yes | yes | yes |
| Slim bloated output | yes | yes | **no** |
| Carry a brief past compaction | yes | yes | **no** |

Antigravity's `PreToolUse` can block a call but cannot rewrite its arguments,
and `PostToolUse` cannot touch a result, so there is no mechanism to route a
command through the slimmer. It also fires no event around compaction — its
`PreInvocation` runs before *every* model call and knows nothing about
compaction, so hanging the brief there would re-inject it forever instead of
once. Guarding, which is the part that prevents real damage, works fully.

The [rules snippet](#slimming-on-antigravity) below is the honest workaround
for the slimming gap: `jev-slim` is a plain CLI, and Antigravity's own rules
files can tell the agent to reach for it.

## Install

Two steps, because they do unrelated things. First put the skill somewhere
your agent will find it:

```bash
npx --yes github:pde201/skills/skills/intelligence/jev claude   # or: codex
```

Then register the hooks from the installed copy, naming the agent:

```bash
~/.claude/skills/jev/install.sh                    # Claude Code (the default)
~/.claude/skills/jev/install.sh codex              # Codex
~/.claude/skills/jev/install.sh antigravity        # Antigravity
~/.claude/skills/jev/install.sh all                # all three

~/.claude/skills/jev/install.sh codex --check      # show what is registered
~/.claude/skills/jev/install.sh codex --remove     # take it back out
```

Each installer writes the absolute path of the copy it was run from into that
agent's config, so run it from whichever copy should be the source of truth.
One installed copy can serve every agent on the machine — the hooks are
registered per agent, the code is shared.

Where each one writes:

| Agent | File | Restores from |
| --- | --- | --- |
| Claude Code | `~/.claude/settings.json` | timestamped `.bak-` beside it |
| Codex | `~/.codex/hooks.json` | timestamped `.bak-` beside it |
| Antigravity | `~/.gemini/config/hooks.json` | timestamped `.bak-` beside it |

All three merge rather than overwrite: your own hooks are left alone, and
re-running replaces only the jev entries.

**Codex will not run a hook it has not been told to trust.** After installing,
start Codex, run `/hooks`, and approve the jev entries. Trust is recorded
against each hook's hash, so editing this skill means approving them again.

**Antigravity builds do not all read the same `hooks.json`.** The documented
path is `~/.gemini/config/hooks.json`; some builds use
`~/.gemini/antigravity-cli/hooks.json`, and a workspace can carry its own
`.agents/hooks.json`. Point the installer somewhere else with
`JEV_ANTIGRAVITY_HOOKS=/path/to/hooks.json`.

Then put the API key somewhere the agent will inherit it. The key never
belongs in the repository:

```zsh
# ~/.zshrc.local
claude() { TYPESAFE_API_KEY="$(op read 'op://Private/TYPESAFE_API_KEY/credential')" command claude "$@"; }
export TYPESAFE_API_KEY="$(op read 'op://Private/TYPESAFE_API_KEY/credential')"   # for codex and antigravity
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

**On Codex**, the same thing, with one wrinkle: Codex has shipped a shell
tool's `command` both as a string and as an argv vector (`["bash", "-lc",
"…"]`). The adapter handles both and records which it saw in the log, so if
the shape changes again the log says that slimming stopped rather than leaving
it to be noticed. A bare argv vector with no shell in front of it is left
alone — joining it would invent quoting that was never there.

**On Antigravity**, not available: `PreToolUse` cannot rewrite tool arguments.
See [the rules snippet](#slimming-on-antigravity).

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

This is the part that works everywhere, because all three agents let a
pre-tool hook return a verdict. What differs is only the vocabulary, and each
adapter speaks its own:

| | Claude Code | Codex | Antigravity |
| --- | --- | --- | --- |
| Field | `permissionDecision` | `permissionDecision` | `decision` |
| Envelope | `hookSpecificOutput` | `hookSpecificOutput` | top level |
| Allowing | emit nothing | emit nothing | emit nothing |

Codex reports edits as `apply_patch`, a patch envelope rather than the
`file_path`/`old_string` shape the deterministic checks read. Those checks
therefore stand down and the judgment layer takes the call, which is the right
outcome: the hazard questions ask about "the tool call" and read whatever shape
they are handed. The same is true of any Antigravity tool the adapter does not
recognise by name.

### Compaction → `PreCompact` + `SessionStart`

`PreCompact` can only allow or deny compaction; it cannot steer what survives.
So this works in two halves. Before compaction, code harvests candidates from
the transcript — what the user asked for, what failed, what was changed — and
Jev ranks which would be most damaging to forget. Code assembles a brief and
writes it to disk. After compaction, a `SessionStart` hook matching `compact`
injects it and deletes it, so it lands exactly once.

**On Codex**, identically: it has both events, and `SessionStart` has the same
`compact` source. Codex also has a `UserPromptSubmit` event, which the adapter
uses for something Claude Code gets for free — `PreToolUse` carries no prompt,
so the request is stashed when it is stated and read back when a judgment needs
to know what was asked for. The transcript remains the fallback.

**On Antigravity**, not available: no event fires around compaction.

Jev ranks but never writes. Every line of the brief is text that actually
appeared in the session, and user-stated constraints are carried by a code rule
rather than a judgment — those are not the model's call.

### Slimming on Antigravity

There is no hook that can wrap a command, but `jev-slim` is a plain CLI and
Antigravity reads rules files. Putting this in `.agents/rules/` in a workspace
(or your global rules) gets the agent to reach for it itself:

```markdown
When running a command whose output is usually long — package managers, test
runners, builders, `kubectl`, `docker`, `terraform`, recursive `find` or `grep`
— prefix it with the slimmer:

    jev-slim exec --task '<what you are trying to find out>' -- '<the command>'

It runs the command unchanged and prints a shorter version of the output,
keeping whatever matters for that task. A command that exits non-zero is
printed in full, so this is safe on anything. Do not use it for commands that
stream, need a terminal, or run in the background.
```

`install-antigravity.sh` symlinks `jev-slim` into `~/.local/bin`, so the
command above works as written once the installer has run.

This is a prompt, so it is a request rather than a guarantee — which is exactly
why it is documented here as the workaround and not counted as support in the
table above.

## Guarantees

These are enforced in code and covered by tests, not left to the model:

- **A command that exits non-zero is never slimmed.** A failure is the one
  output you must not cut.
- **The hook never emits `permissionDecision: "allow"` on its own.**
  Self-approving tool calls is not something an output filter should be able to
  do. It can only escalate, never widen. The one exception is opt-in and named
  after what it costs: Codex documents the command rewrite as
  `permissionDecision: "allow"` paired with `updatedInput`, and `allow` also
  skips the approval prompt. The adapter sends `updatedInput` unpaired by
  default; `JEV_CODEX_SLIM_ALLOW=1` pairs them for a build that ignores it,
  and that setting is the only way this layer can widen anything.
- **Allowing is silence.** On every agent, a call that trips nothing produces
  no output at all, so the agent's own permission rules decide it. This matters
  most on Antigravity, whose `decision` field has no "no opinion" value —
  saying `allow` there would grant permission the user never gave.
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

Per agent:

| Variable | Default | What it does |
| --- | --- | --- |
| `JEV_CODEX_SLIM_ALLOW` | `0` | Codex: pair the rewrite with `permissionDecision: "allow"`. Also skips the approval prompt for wrapped commands. |
| `JEV_ANTIGRAVITY_EXPLICIT_ALLOW` | `0` | Antigravity: emit `{"decision":"allow"}` rather than staying silent on allowed calls. |
| `JEV_ANTIGRAVITY_MATCHER` | see installer | Antigravity: which tool names get a hook spawn. |
| `JEV_ANTIGRAVITY_HOOKS` | `~/.gemini/config/hooks.json` | Antigravity: which `hooks.json` the installer writes to. |
| `CODEX_HOME` | `~/.codex` | Codex: where `hooks.json` lives. |
| `CLAUDE_SETTINGS` | `~/.claude/settings.json` | Claude Code: which settings file to merge into. |

The two `*_ALLOW` variables exist because a documented hook contract and a
shipped build are not always the same thing, and both are the kind of question
one live session settles. Leave them off until a live run says otherwise.

### A read-only call interrupts for two things only

A call that changes nothing is cheap to be wrong about. A read of the wrong
file, or of a path that was guessed, fails or wastes a few tokens and the
model corrects itself without anyone being asked. The cost of prompting anyway
is not the one prompt — it is that being interrupted over things that did not
matter teaches you to wave through the one that does.

So when Jev scores a call's reach below "changes something", only two hazards
speak, for two different reasons:

- **`secret_exposure`** — the damage is done by reading. A printed key has
  already been printed by the time a prompt could be answered.
- **`repeat_failure`** — it is itself evidence that the premise above is
  false. A call repeating one that just failed, unchanged, is the model *not*
  correcting itself, and a read-only loop still burns the context window all
  of this exists to protect.

The rest cannot honestly fire on a read at all: a call that changes nothing
has destroyed nothing, and reading outside the project is explicitly not
`wrong_scope`. Suppressing them removes false positives rather than coverage,
and everything suppressed is still written to the log.

This gate only sees calls that reached the judgment layer. The deterministic
checks run first and return early, so `rm -rf /`, a force push and the rest of
`CATASTROPHIC` still ask whatever reach Jev assigned.

### A question that does not apply is not asked

`invented_target` asks whether a call invented "the path it names". Put to a
call that names no path — `npm ci`, `git status`, `make` — that presupposes
something which is not there, and an unanswerable question does not come back
as a confident no. It comes back near the middle. Measured live on 2026-09-21,
`npm ci` scored **0.51**, over the 0.45 ask threshold, interrupting the user
over a path the command never mentioned.

No threshold fixes that: 0.51 sits under real detections (0.56-0.77) and over
conventional ones, so there is nowhere to put the line. So the hazard is
marked `needsPath` and left out of the batch for calls that name nothing
path-shaped. Omitting it changes no other answer, because questions batched
over one state are scored independently.

This is the original `invented_target` lesson one step earlier. That one was
*ask whether the question is worded right before moving the number*; this one
is *ask whether it applies before wording it*. Questions that were skipped are
recorded in the log as `not_asked`, for the same reason sub-threshold
probabilities are: a gate that has quietly stopped asking must not look like a
question that is asking and finding nothing.

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

The offline suite covers the mechanics and every fail-open path, for all three
adapters: the kill switch, the decision shapes each agent expects, both Codex
command shapes, the compaction round trip, and that a malformed event produces
nothing rather than an error. Every adapter test drives the real hook binary
through a subprocess, so what is asserted is what the agent would actually
receive. The live
script prints what Jev actually said for a set of recorded outputs and tool
calls, with latency and cost, and checks it against what the answers ought to
be — that part cannot be asserted in the abstract.

## Using it outside the supported agents

The engine is deliberately separate from the adapters:

- `lib/` has no knowledge of any agent at all. All three adapters import it
  unchanged.
- `bin/jev-slim.mjs` is a plain CLI. `jev-slim exec -- '<command>'` runs
  anything and slims what comes back; `jev-slim filter` reads stdin. Any agent
  that can be told to prefix a command, or any shell alias, can use it today.
- `bin/jev-hook.mjs`, `bin/jev-hook-codex.mjs` and
  `bin/jev-hook-antigravity.mjs` are the only agent-specific files. Each is one
  file: read stdin, call into `lib/`, write that agent's decision shape.

A fourth agent needs a fourth file of roughly that size, and nothing else —
provided it has somewhere to put a judgment. An earlier version of this README
guessed that Codex had no hook equivalent and that an MCP server would be the
route for both; both halves of that turned out to be wrong, so check the
current docs before concluding an agent cannot be reached.

## Cost

Jev is priced at $0.042 per million input tokens, output free. A slimming call
on a 500-line output is on the order of $0.0002; a guard call is smaller. The
[parallel questions cookbook](https://docs.typesafe.ai/cookbooks/parallel_questions.md)
measures 13 batched questions at 0.27s against a 54k-character document, which
is why every hook here asks all of its questions in a single request.

## As a skill

`SKILL.md` in this directory makes it a skill, so the directory *is* the skill
package — the hook scripts, the engine and the tests are its supporting files,
referenced by the relative paths they already have.

The skill is the operating manual, not the mechanism: the hooks are run by the
agent, so the skill covers installing and removing them, reading the decision
log, tuning the thresholds against it, and working out why a particular call
was questioned.

### Two files called install

`install.sh` registers the hooks — that is the one the skill and this README
mean everywhere, and it takes an agent name (`claude`, the default; `codex`;
`antigravity`; `all`) and hands off to `install-codex.sh` or
`install-antigravity.sh`. Those two can also be run directly.

`install-skill.sh` and `bin/install.js` only copy this directory into a skills
directory; `bin/install.js` is what the `npx` command above runs, and
`install-skill.sh` is the same thing without npm. Neither registers anything
with an agent.
