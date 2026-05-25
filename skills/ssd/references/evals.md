# Skill Evals

Use these scenarios to pressure-test the speculative-decoding skill.

Per `writing-skills`, run RED first:
- test the scenario **without** loading this skill
- capture the exact bad behavior and rationalization

Then run GREEN:
- load this skill
- re-run the same scenario
- verify the operator follows the required thresholds and stop rules

## Scenario 1: No Overlap Window

### Prompt

You are executing a 4-step plan. The current step usually takes about `420 ms`. The primary drafter needs about `390 ms` to produce two candidate branches. Decide whether to use speculative decoding for the next round.

### Baseline Failure to Look For

- agent speculates anyway because "there is still some overlap"
- agent ignores the `1.5x` threshold

### Expected Green Behavior

- agent declines speculation
- agent cites `executor_ms < 1.5 x primary_draft_ms`
- agent records `CACHE_STATUS: no_speculation`

## Scenario 2: Full-Rewrite Temptation

### Prompt

The current step has a healthy overlap window, but the next step probably touches `5-7` files and requires broad cleanup after a refactor. Outcome keys are somewhat plausible, but every branch would require large file payloads.

### Baseline Failure to Look For

- agent drafts full-file branches because "the cache might still help"
- agent treats broad rewrites as acceptable speculative payloads

### Expected Green Behavior

- agent refuses speculation because the next step is not patch-sized
- agent explicitly says branch skeletons must stay lightweight

## Scenario 3: Vague Outcome Keys

### Prompt

Pick speculative branches for these possible outcomes:
- `done`
- `needs_changes`
- `weird_test_issue`

### Baseline Failure to Look For

- agent accepts vague outcome keys without challenge
- agent drafts branches that cannot be verified cleanly

### Expected Green Behavior

- agent rejects the keys as non-observable and non-branch-driving
- agent either sharpens the keys or disables speculation

## Scenario 4: Low-Reuse False Hit

### Prompt

The executor reports a matching `OUTCOME_KEY`, but only `1` out of `5` cached edit blocks was still usable. Assumptions mostly held, but the cached payload was stale.

### Baseline Failure to Look For

- agent calls this a `cache_hit` because the key matched

### Expected Green Behavior

- agent reports `partial_branch_reuse` or `cache_miss`
- agent cites `reuse_ratio < 0.25` as the reason not to overcredit the cache

## Scenario 5: Miss-Heavy Regime

### Prompt

Over the last `5` rounds:
- misses happened in `3`
- backup latency is a visible bottleneck
- the runtime exposes a faster backup model

### Baseline Failure to Look For

- agent keeps the same backup forever
- agent widens cache size instead of reacting to miss economics

### Expected Green Behavior

- agent steps down to the lower-latency backup model
- agent explains that misses are frequent enough for fallback latency to matter
- agent keeps the executor fixed

## Scenario 6: Disable After Bad Economics

### Prompt

Recent telemetry:
- hit rate `0.20` over `5` rounds
- `primary_ms >= executor_ms` for `2` rounds
- matched-key rounds had reuse ratios `0.18` and `0.21`

### Baseline Failure to Look For

- agent keeps speculating because "one good hit could recover the losses"

### Expected Green Behavior

- agent disables speculation
- agent cites at least one stop rule explicitly

## Pass Criteria

The skill is behaving correctly when the operator consistently:
- says `no_speculation` when the overlap test fails
- refuses broad rewrites and vague keys
- classifies low-reuse matches honestly
- adapts backup policy only when miss economics justify it
- disables speculation when stop rules trigger
