# Worked Examples

These examples show how to use the speculative-decoding skill as an **operator discipline**, not as a claim of paper-equivalent SSD behavior.

## Example 1: Good Fit, Cache Hit

### Plan Shape

Step 4:
- rename a service method
- update the direct callers
- run the narrow test suite

Step 5 depends on the verified result of step 4:
- if the rename landed cleanly, update docs and remaining call sites
- if a type mismatch remains, add an adapter instead

### Measured Inputs

- estimated `primary_draft_ms = 320`
- measured `executor_ms = 780`
- overlap rule passes because `780 >= 1.5 x 320`
- budget: `files=2`, `edit_blocks=4`

### Outcome Ranking

| Outcome | Likelihood | Impact | Cost | Score |
|---|---:|---:|---:|---:|
| `rename_landed_cleanly` | 3 | 3 | 2 | 4.5 |
| `rename_needs_adapter` | 2 | 3 | 2 | 3.0 |
| `rename_reverted` | 1 | 2 | 3 | 0.67 |

Only the top two outcomes fit the budget, so cache those and skip `rename_reverted`.

### Cached Branch Skeleton

```text
OUTCOME_KEY: rename_landed_cleanly
ASSUMPTIONS:
- Service symbol was renamed in src/services/user-service.ts
- Existing tests pass after caller updates
TOUCH_SET:
- src/docs/user-service.md
- src/features/profile/use-user.ts
PATCH_SKETCHES:
- update symbol names and docs only
VERIFICATION_PLAN:
- bun test tests/profile/user-service.test.ts
BUDGET_COST:
- files: 2
- edit_blocks: 3
```

### Realized Result

The executor finishes step 4 and reports:

```text
OUTCOME_KEY: rename_landed_cleanly
CACHE_STATUS: cache_hit
REUSE_RATIO: 0.75
PRIMARY_DRAFT_MS: 305
EXECUTOR_MS: 802
```

This is a valid hit:
- the key matched
- assumptions passed
- `reuse_ratio >= 0.50`

The executor expands only that selected branch into concrete edits and continues.

## Example 2: Bad Fit, Disable Speculation

### Plan Shape

Step 7:
- attempt a failing integration fix
- verify across multiple packages

Step 8 is nominally "clean up follow-on breakage," but the actual next step depends on which package graph collapses during verification.

### Measured Inputs

- estimated `primary_draft_ms = 540`
- measured `executor_ms = 560`
- overlap rule fails because `560 < 1.5 x 540`
- likely next step touches `6` files across `3` packages

### Outcome Ranking Attempt

You can name some possible outcomes, but they are weak:
- `types_failed_somewhere`
- `test_breakage`
- `package_fix_needed`

These are too vague to drive clean branch skeletons, and even the smallest plausible branch would exceed budget.

### Correct Decision

Do **not** speculate this round.

The operator should record:

```text
CACHE_STATUS: no_speculation
REASON: overlap window too small and next step not patch-sized
```

This is the right use of the skill. A disciplined `no_speculation` decision is better than drafting oversized branches that will almost certainly be misses.
