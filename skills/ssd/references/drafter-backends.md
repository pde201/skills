# Speculative Decoding Runtime Matrix

Use explicit runtime roles. This protocol always has three named roles:
- primary drafter: builds the initial branch-skeleton cache for step N+1
- backup drafter: regenerates one realized branch after a cache miss or low-value partial reuse
- executor: performs the real step N work, emits the actual `OUTCOME_KEY`, and decides whether reuse is safe

This is an agentic analogue of SSD. The model split is therefore a latency policy, not a claim of paper-equivalent verifier/speculator hardware.

## Runtime Matrix

| Runtime | Primary drafter | Backup ladder | Executor | Why this split |
|---|---|---|---|---|
| Claude Code | `@ssd-drafter-haiku` | `@ssd-drafter-haiku` | `@ssd-executor-opus` | Keep speculation inside the Claude family. Since there is no cheaper built-in fallback in this skill, respond to misses by shrinking cache budget before widening fan-out. |
| Pi / OMP / GitHub Copilot | `gpt-5.4-mini` | `gpt-5.4-mini` -> `gpt-5.4-nano` when available and miss latency dominates | `gpt-5.4` | Use mini for better branch skeletons while overlap exists. Step down only when faster fallback is worth lower draft quality. |
| Codex | `gpt-5.4-mini` | `gpt-5.4-mini` -> `gpt-5.4-nano` when available and misses are on the critical path | `gpt-5.4` | Keep fallback on mini unless telemetry shows a faster backup would recover more time than it loses in branch quality. |
| DeepSeek V4 | `deepseek-v4-flash` | `deepseek-v4-flash` -> no cheaper fallback in family; respond to misses by shrinking cache budget before widening fan-out | `deepseek-v4-pro` | Flash drafts fast skeleton branches while Pro executes the real work. Since there is no cheaper built-in fallback, respond to misses by shrinking cache budget before widening fan-out. |

## Role Rules

### Primary drafter
Use the primary drafter to:
- build the first speculation cache for step N+1
- emit one lightweight branch skeleton per selected `OUTCOME_KEY`
- stay within the overlap budget defined in [Outcome Cache](outcome-cache.md)

Do not use the primary drafter to:
- execute the current step
- choose the winning branch
- speculate more than one step ahead
- emit oversized full-file drafts by default

### Backup drafter
Use the backup drafter only when:
- the executor emits an `OUTCOME_KEY` that was not cached
- the cached branch exists but its assumptions no longer hold
- the key matched but reuse depth is too low for the cached branch to have been worthwhile

The backup drafter drafts exactly one branch for the realized outcome. It does not rebuild the whole cache.

Choose the backup model adaptively:
- if misses are rare and the executor can tolerate a richer fallback, keep the backup equal to the primary
- if misses are frequent and fallback latency is dominating, step down to the fastest model that still produces usable branch skeletons
- if the faster backup causes poor reuse or unsafe drafts, step back up or stop speculating

### Executor
The executor is fixed per runtime:
- Claude Code: `@ssd-executor-opus`
- Pi / OMP / GitHub Copilot: `gpt-5.4` (direct model selection)
- Codex: `gpt-5.4` (direct model selection)
- DeepSeek V4: `deepseek-v4-pro` (direct model selection)

The executor:
- performs the real reads, writes, and verification work
- emits the actual `OUTCOME_KEY` and verification outcome
- labels the result as `cache_hit`, `cache_miss`, `partial_branch_reuse`, or `no_speculation`
- may reject any drafted branch whose assumptions do not match the workspace
- remains authoritative even when a cached branch exists

## Selection Rules

1. Determine which runtime is actually doing the speculative work.
2. Pick the matching primary drafter and executor from the matrix.
3. Start with the highest-quality drafter that can still finish useful branch skeletons inside the executor overlap window.
4. Launch the primary drafter in parallel with the executor.
5. Keep the backup equal to the primary until telemetry shows that misses are common enough for fallback latency to matter materially.
6. When fallback latency dominates and a cheaper model exists, step down the backup model.
7. If branch quality or reuse drops after stepping down, step back up or disable speculation.
8. Keep the executor fixed for the entire run.
