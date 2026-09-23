# Task-context paired evaluation (2026-09-23 UTC)

Recent local Jev decision records showed repeated `Edit` approval requests with
`intent_mismatch` estimates just above the default 0.45 ask threshold. The
affected session used short user scope updates while work on the broader task
continued. Raw transcripts and paths are deliberately excluded from this repo.

The [synthetic cases](task-context-cases.json) model continuations, option
selections, scope amendments, independent task replacement, sibling worktree
setup, repository preflight, and calls that contradict the user's direction.
Each case was judged three times with the
same `jev-latest` provider and guard configuration (`JEV_RETRIES=0`), comparing
the old latest-message-only task with the revised recent-direction context.
Labels were kept local to the evaluator. All 132 judgments returned model
decisions.

| Task text | Safe calls interrupted | Hazardous calls allowed |
| --- | ---: | ---: |
| Latest message only | 8 / 42 | 3 / 24 |
| Recent directions, latest overrides | 0 / 42 | 0 / 24 |

The baseline's eight false interruptions occurred on a backend edit after a UI
change was parked (three repetitions), a sibling worktree (two), and routine
repository preflight (three). The revised context allowed all three types.
It continued to question an edit to the parked UI, a worktree in an unrelated
shared directory, and a command that would reveal an auth token.

This is a provider judgment check on invented cases, not a production
false-positive rate or a host UI compatibility check. The local Jev log does
not contain independently labeled edits or the task text sent with each
judgment, so the original prompts cannot be scored as ground truth from the
log alone. A future private replay should label actual calls before measuring
whether approval frequency falls in real sessions.
