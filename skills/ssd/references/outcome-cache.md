# Outcome Cache Contract

This document defines the bounded cache semantics for the speculative-decoding skill.

This is an agentic analogue of SSD. The cache therefore stores lightweight branch skeletons rather than token/logit tensors, and it should be judged by overlap, hit rate, and reuse depth rather than by paper-level lossless decoding guarantees.

## Overlap Window

The overlap window is the executor time available for the drafter to hide behind on the current round.

If useful branch skeletons cannot be drafted inside this window, the cache is oversized and speculation should be narrowed or disabled.

## Verification Outcome

A verification outcome is the executor's short, truthful report of what step N actually produced in the workspace.

At minimum, it must state:
- whether step N passed, failed, or partially landed
- what files or identifiers materially changed
- what fact now determines step N+1
- what fallback reason applies if the result is not a clean cache hit

The verification outcome is what the executor maps to a single `OUTCOME_KEY`.

## Outcome Key

An `OUTCOME_KEY` is a short label for one branch-driving result of step N.

Good outcome keys are:
- observable from executor verification
- narrow enough to drive a distinct step N+1 branch
- mutually exclusive when possible

Examples:
- `rename_required`
- `schema_added`
- `test_failed_known_import`
- `api_shape_unchanged`

Bad outcome keys are vague or non-verifiable, such as `done`, `misc_changes`, or `unknown`.

## Speculation Cache Contract

The speculation cache is the bounded set of step N+1 branch skeletons produced while step N executes.

Each cached branch must contain:
- exactly one `OUTCOME_KEY`
- a short `OUTCOME_REASON`
- explicit assumptions the executor can verify before reuse
- a `TOUCH_SET`
- minimal `PATCH_SKETCHES`
- a `VERIFICATION_PLAN`
- an explicit `BUDGET_COST`

The cache is advisory:
- it never overrides real workspace state
- it never selects its own winning branch
- it is valid for one step of lookahead only

If the executor cannot verify a branch's assumptions, that branch is not a cache hit.

## Budget Heuristic

Do not start from a fixed branch count.

Instead, choose cache size from the overlap window:
- estimate how much draft work fits before the executor finishes
- spend that budget on the most likely and most branch-driving outcomes first
- give earlier and higher-probability divergences more budget than late rare outcomes
- shrink payload size before adding more outcomes
- if the budget only fits one useful branch, speculate one branch
- if no useful branch fits, skip speculation

This is the agentic analogue of the paper's budgeted fan-out optimization: cache shape should follow likelihood and value, not a uniform cap.

Default scoring rule:
- `score = likelihood_weight x impact_weight / cost_units`
- use `3` for high, `2` for medium, `1` for low
- spend budget on highest scores first

## Cache Hit, Miss, and Partial Branch Reuse

### Cache hit
A cache hit means:
- the executor emitted an `OUTCOME_KEY` already present in the cache, and
- the matching branch assumptions still hold in the real workspace, and
- enough of the cached payload is reusable that it materially saved planning time

On hit, the executor may reuse and expand the selected branch after verifying it.

Default threshold:
- classify as `cache_hit` only if `reuse_ratio >= 0.50`

### Cache miss
A cache miss means any of the following:
- the executor emitted an `OUTCOME_KEY` not present in the cache
- the cache exists but no branch maps cleanly to the realized verification outcome
- verification is too unclear to trust any cached branch
- the cached payload was so oversized or off-target that it saved no real work

On miss, the cached branch is not reused as-is.

Default threshold:
- treat `reuse_ratio < 0.25` as `cache_miss` unless there is a strong reason to classify it as partial reuse instead

### Partial branch reuse
Partial branch reuse means:
- the realized `OUTCOME_KEY` matches a cached branch, but
- only part of the cached payload is still valid or useful against the current workspace

Two named sub-cases are distinguished by `CACHE_MISS_REASON`:

1. **fresh partial** (`CACHE_MISS_REASON: draft_incomplete`) — the cached branch key matched but the draft is structurally incomplete; the workspace advanced past what the draft covered.
2. **stale branch** (`CACHE_MISS_REASON: assumptions_failed`) — the `OUTCOME_KEY` matched a cached branch, but the executor could not verify one or more branch assumptions against the real workspace.

An additional practical sub-case is:

3. **low-value partial** (`CACHE_MISS_REASON: low_reuse`) — the key matched, but too little of the payload was reusable for the cache to have been worthwhile.

On partial branch reuse, prefer one of two actions:
- regenerate one fresh branch with the backup drafter when a refreshed branch will still arrive in time to help
- skip backup and continue sequentially when the overlap benefit is already gone

Default threshold:
- use `partial_branch_reuse` when `0.25 <= reuse_ratio < 0.50`, or when the key matched but assumptions required repair

## Fallback Behavior

Fallback behavior is intentionally narrow:
1. the executor finishes step N and emits the actual `OUTCOME_KEY`
2. if the cache is a miss or partial branch reuse, decide whether backup latency can still help this round
3. if yes, invoke the backup drafter for one complete fresh branch keyed to the realized outcome
4. if not, continue without speculative help for that round
5. the executor verifies any regenerated branch before reuse

Backup selection is adaptive:
- use the same drafter as backup when misses are rare and richer drafts are worth the wait
- use a lower-latency backup when misses are frequent enough that fallback latency dominates
- step back up or disable speculation if the faster backup harms reuse too much

Default switching rule:
- consider stepping down backup only if misses occur in at least `2` of the last `5` rounds and fallback latency is on the critical path

Fallback does not:
- rebuild the full cache
- add another speculation depth
- excuse missing verification

## Operational Rules

- primary drafter builds the initial speculation cache
- backup drafter produces one complete fresh branch on cache miss or partial branch reuse when fallback still has value
- executor remains authoritative for selection, verification, and final edits
- `CACHE_STATUS` must be one of `cache_hit`, `cache_miss`, `partial_branch_reuse`, or `no_speculation`
- `CACHE_MISS_REASON` must be `none` for `cache_hit` and `no_speculation`; otherwise it must explain the fallback route with one of `not_in_cache`, `assumptions_failed`, `draft_incomplete`, `low_reuse`, `unclear_verification`, or another equally concrete reason
- if overlap disappears, speculation should be disabled rather than rationalized

Default disable rules:
- hit rate below `0.30` over the last `5` rounds
- `primary_ms >= executor_ms` for `2` consecutive rounds
- `reuse_ratio < 0.25` on `2` matched-key rounds
