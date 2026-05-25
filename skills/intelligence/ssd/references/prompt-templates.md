# Speculative Decoding Prompt Templates

These are prompt bodies. Pair them with the runtime roles from [Drafter Backends](drafter-backends.md) and the cache semantics from [Outcome Cache](outcome-cache.md).

These templates implement a **paper-inspired agentic analogue**, not token-level SSD. They optimize for lightweight reusable branch skeletons that fit inside an executor overlap window.

## Primary Drafter Prompt Body

Use this prompt with the selected primary drafter.

```text
You are the primary drafter in a bounded speculative-decoding analogue.

## Plan
{paste full plan text here}

## Current State
Step {N} is currently being executed by the executor.
Draft branch skeletons only for the likely verification outcomes listed below.

## Draft Target
Draft step {N+1}: {step N+1 title and full description}

## Overlap Budget
EXECUTOR_WINDOW_MS: {estimated overlap window}
CACHE_BUDGET_UNITS: {for example files=2,edit_blocks=5}

## Allowed Outcome Keys
{paste ranked likely `OUTCOME_KEY`s and one sentence explaining each}

## Relevant Files
{paste only the files step N+1 is likely to read or modify}

## Output Format
Emit exactly one outcome branch for each allowed `OUTCOME_KEY`.
Each branch must use this exact wrapper:

=== OUTCOME_BRANCH START ===
OUTCOME_KEY: {key_name}
OUTCOME_REASON: {why this outcome is plausible and branch-driving}
ASSUMPTIONS:
- assumption one the executor must verify before reuse
- assumption two the executor must verify before reuse
TOUCH_SET:
- path/to/file.ext
- path/to/another.ext
PATCH_SKETCHES:
--- PATCH: path/to/file.ext ---
ANCHOR: {function, section, symbol, or nearby text}
CHANGE:
- {minimal edit summary}
OPTIONAL_SNIPPET:
{small anchored snippet or hunk only if needed}
--- END PATCH ---
VERIFICATION_PLAN:
- {narrowest command, test, or observable check for step N+1}
BUDGET_COST:
- files: {n}
- edit_blocks: {n}
=== OUTCOME_BRANCH END ===

## Rules
- Draft only the scope of step {N+1}.
- Keep speculation bounded to one step of lookahead.
- Stay within the supplied cache budget.
- Optimize for high reuse density, not completeness for its own sake.
- Keep each branch tied to one `OUTCOME_KEY`; do not merge outcomes.
- Prefer anchored patch sketches over full-file payloads.
- Include full diffs or file contents only for very small files that still fit the budget.
- Write concrete edits, not pseudocode.
- Never write to the workspace. This is draft output only.
```

## Backup Drafter Prompt Body

cache miss or low-value partial branch reuse

```text
You are the backup drafter in a bounded speculative-decoding analogue.

## Plan
{paste full plan text here}

## Realized Current State
The executor has already finished step {N} and reported the real verification outcome.
Draft step {N+1} only for that realized outcome.

## Draft Target
Draft step {N+1}: {step N+1 title and full description}

## Realized Outcome
OUTCOME_KEY: {actual outcome key emitted by the executor}
OUTCOME_REASON: {executor's reason for the realized outcome}
CACHE_MISS_REASON: {not_in_cache | assumptions_failed | draft_incomplete | low_reuse | other concrete reason}

## Overlap Budget
EXECUTOR_WINDOW_MS: {latest overlap window}
CACHE_BUDGET_UNITS: {for example files=1,edit_blocks=3}

## Relevant Files
{paste only the files step N+1 now needs}

## Output Format
Emit exactly one branch using this exact wrapper:

=== OUTCOME_BRANCH START ===
OUTCOME_KEY: {actual key only}
OUTCOME_REASON: {why this realized outcome changes step N+1}
ASSUMPTIONS:
- assumption one the executor must verify before reuse
- assumption two the executor must verify before reuse
TOUCH_SET:
- path/to/file.ext
PATCH_SKETCHES:
--- PATCH: path/to/file.ext ---
ANCHOR: {function, section, symbol, or nearby text}
CHANGE:
- {minimal edit summary}
OPTIONAL_SNIPPET:
{small anchored snippet or hunk only if needed}
--- END PATCH ---
VERIFICATION_PLAN:
- {narrowest command, test, or observable check for step N+1}
BUDGET_COST:
- files: {n}
- edit_blocks: {n}
=== OUTCOME_BRANCH END ===

## Rules
- Draft exactly one branch for the realized `OUTCOME_KEY`.
- Do not regenerate branches for outcomes that did not happen.
- Keep speculation bounded to one step of lookahead.
- Stay within the supplied cache budget.
- Prefer the smallest branch skeleton that still gives the executor a real head start.
- Write concrete edits, not pseudocode.
- Never write to the workspace. This is draft output only.
```

## Executor Prompt Body

Use this prompt with the selected executor.

```text
You are the executor in a bounded speculative-decoding analogue.

## Plan
{paste full plan text here}

## Current Step
Execute step {N}: {step N title and full description}

## Workspace State
{paste the real files step N needs right now}

## Accepted Draft For This Step
{paste the accepted, partial, or regenerated branch skeleton for step N, or write NONE}

## Requirements
- Execute step {N} completely using the real workspace state.
- Treat any draft as a starting point, not as ground truth.
- Re-read the files you touch before editing.
- If a branch skeleton was supplied, verify its assumptions before trusting it.
- Expand only the selected branch into concrete edits.
- Run the narrowest verification that proves the step landed.
- Decide whether the supplied branch was a cache hit, cache miss, partial branch reuse, or no speculation.
- Estimate reuse depth honestly; low reuse means the cache payload was poorly sized even if the key matched.

## Required Final Report
Emit these exact fields, in this order:
OUTCOME_KEY: {the single realized outcome key for step N}
OUTCOME_REASON: {why the verification outcome maps to that key}
PRODUCED_IDENTIFIERS:
- {symbols, files, migrations, or other branch-driving identifiers produced by this step}
TOUCHED_FILES:
- path/to/file.ext
VERIFICATION:
- {command, test, or observable check}
- RESULT: {passed | failed | partial}
CACHE_STATUS: {cache_hit | cache_miss | partial_branch_reuse | no_speculation}
CACHE_MISS_REASON: {none | not_in_cache | assumptions_failed | draft_incomplete | low_reuse | unclear_verification | other concrete reason}
REUSE_RATIO: {0.00-1.00 | reused_blocks/total_blocks | unknown}
PRIMARY_DRAFT_MS: {integer | unknown}
BACKUP_DRAFT_MS: {integer | unknown}
EXECUTOR_MS: {integer | unknown}
CACHE_BUDGET_UNITS: {summary | unknown}
CACHE_PAYLOAD_UNITS: {summary of the selected branch | none}
SELECTED_OUTCOME_RANK: {1 | 2 | 3 | ... | unknown}

## Rules
- Emit exactly one realized `OUTCOME_KEY`.
- Tell the truth about the workspace, even if the plan expected something else.
- If verification is unclear, do not claim a cache hit.
- If the branch key matched but reuse was low, report `partial_branch_reuse` or `cache_miss` instead of overcrediting the cache.
- Emit `CACHE_MISS_REASON: none` for `cache_hit` or `no_speculation`; otherwise emit the concrete fallback reason that the operator will pass to the backup drafter.
- Do not speculate past step {N+1}.
```

## Notes

- Replace every placeholder before dispatching either agent.
- Keep relevant files tight. Oversupplying context slows both drafter and executor.
- If a step is the final step in the plan, skip both drafters and run only the executor with `CACHE_STATUS: no_speculation`.
- If the selected branch cannot fit inside the overlap budget as a lightweight skeleton, do not speculate that round.
