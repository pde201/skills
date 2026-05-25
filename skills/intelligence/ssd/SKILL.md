---
name: ssd
description: Use when a multi-step implementation plan has a slow current step, a few likely next-step outcomes, and you need to decide whether one-step speculative branching can hide planning latency without causing oversized drafts.
---

# Speculative Decoding

## Overview

This skill is a paper-inspired agentic analogue of speculative speculative decoding.

It is **not** token-level SSD or Saguaro:
- it is not lossless in the paper's sense
- it does not assume separate hardware
- it does not guarantee speedup

Use it only to hide **planning latency** for step `N+1` while the executor performs and verifies step `N`.

## When to Use

Use this skill when all of the following are true:
- the plan has 3 or more sequential steps
- step `N` has a measurable execution or verification window
- step `N+1` can be represented as a small branch skeleton, not a broad rewrite
- step `N` can end in a few concrete, verifiable outcomes
- the executor can measure whether speculation actually helped

Do **not** use this skill when any of the following are true:
- the task is single-step
- the next step is unknowable until the current step finishes
- step `N+1` requires broad edits across many files
- the likely outcomes cannot be ranked with any confidence
- destructive or high-risk changes would be hidden behind reuse

## Operator Checklist

1. Qualify the step.
   Speculate only if the current step has a real overlap window and the next step is patch-sized.
2. Size the overlap budget.
   Default rule: speculate only if estimated `executor_ms >= 1.5 x primary_draft_ms`.
   If you do not have timing data yet, run one round without speculation and measure first.
3. Rank outcomes by value.
   Use `score = likelihood_weight x impact_weight / cost_units`.
   Default weights:
   `3` = high, `2` = medium, `1` = low.
   Cache highest scores until the overlap budget is exhausted.
4. Draft lightweight branch skeletons.
   Each cached branch gets exactly one `OUTCOME_KEY` and includes only:
   `TOUCH_SET`, `ASSUMPTIONS`, `PATCH_SKETCHES`, `VERIFICATION_PLAN`, `BUDGET_COST`.
   Do not default to full-file payloads.
5. Classify reuse honestly.
   Default thresholds:
   `cache_hit` if assumptions pass and `reuse_ratio >= 0.50`
   `partial_branch_reuse` if the key matched but `0.25 <= reuse_ratio < 0.50`, or assumptions needed repair
   `cache_miss` if no key matched, verification was unclear, or `reuse_ratio < 0.25`
6. Adapt fallback only when misses become material.
   Keep backup equal to primary by default.
   Step down to a lower-latency backup only if misses occur in at least `2` of the last `5` rounds and fallback latency is on the critical path.
7. Stop when the economics break.
   Disable speculation if any default stop rule triggers:
   hit rate below `0.30` over the last `5` rounds
   `primary_ms >= executor_ms` for `2` consecutive rounds
   `reuse_ratio < 0.25` on `2` matched-key rounds
   the step expands into a broad rewrite instead of a patch-sized branch

## Default Workflow

Before round `N`:
1. choose runtime roles from [Drafter Backends](references/drafter-backends.md)
2. estimate the overlap window and cache budget
3. score likely `OUTCOME_KEY`s and keep only the highest-value branches that fit budget

During round `N`:
1. launch the executor for step `N`
2. launch the primary drafter in parallel to draft step `N+1` skeletons
3. wait for the executor's verified `OUTCOME_KEY`
4. on hit, verify assumptions and expand only the selected branch
5. on miss or low-value partial reuse, decide whether a backup branch can still arrive in time to help

After round `N`:
1. log hit/miss status, reuse ratio, and timing using the tracker CLI:
   ```bash
   node scripts/ssd-tracker.js log --round <id> --status <status> --primary-ms <ms> --executor-ms <ms> [--reuse <ratio>] [--key <key>] [--reason <reason>]
   ```
2. shrink budget, step down backup, or disable speculation based on measured results. Check overall metrics and trigger diagnostics with:
   ```bash
   node scripts/ssd-tracker.js stats
   ```

Never speculate beyond one step of lookahead.

## Red Flags

Stop and disable speculation if you catch yourself saying any of the following:
- "The branch is huge, but it might still help."
- "I cannot rank the outcomes, but I will cache a few anyway."
- "The key matched, so I will call it a hit."
- "Fallback is slow, but the cache probably still pays for itself."
- "This is close enough to the paper, so the analogy guarantees speedup."

## Common Mistakes

- Treating the cache as authoritative instead of advisory
- Hardcoding a fixed `2-4` branch policy instead of using a budget
- Caching full rewrites when a small patch sketch would do
- Overcrediting low-reuse matches as `cache_hit`
- Leaving speculation on after the overlap window disappears

## References

- [Prompt Templates](references/prompt-templates.md) — primary drafter, backup drafter, and executor prompts
- [Drafter Backends](references/drafter-backends.md) — runtime-specific model selection
- [Outcome Cache](references/outcome-cache.md) — detailed cache, fallback, and classification semantics
- [Worked Examples](references/examples.md) — two complete scenarios
- [Skill Evals](references/evals.md) — RED/GREEN pressure scenarios for this skill
- [Speculative Speculative Decoding (Kumar, Dao, May, 2026)](https://arxiv.org/html/2603.03251v2) — paper that inspired this analogue
