# Data handling

`lib/client.mjs` sends judgments to TypeSafe (`api.typesafe.ai` by default;
`TYPESAFE_BASE_URL` overrides the endpoint). Guard state includes task, working
directory, workspace roots (the cwd, host workspace folders, directories the
session has written to, the temp directory, `JEV_WORKSPACE_ROOTS`), tool input,
recent calls, confirmed user-run push outcomes, and observed paths. Slimming includes task, command, and output
blocks. Compaction includes candidate history and current
task. These can contain source code, personal data, and business information.

Outbound state and decision logs pass through common-secret/PII redaction:
sensitive object keys, PEM blocks, bearer and URL credentials, `name=value`
assignments whose name contains key/token/secret/password (including
upper-case environment names such as `AWS_SECRET_ACCESS_KEY`), tokens that
identify themselves by prefix (GitHub, GitLab, OpenAI/Anthropic, Stripe, AWS,
Slack, Google, TypeSafe, JWT), and nine-digit SSN shapes. The contiguous SSN
form also redacts other nine-digit identifiers; that is accepted. This is
pattern-based risk reduction, not a complete content classifier or a promise
that all secrets, names, or personal data are removed. Confirm the endpoint
and data category are permitted before enabling remote judgments. Provider
retention and account policies are not established by this repository.

Full original output is saved locally for recovery; local briefs and stashed
prompts may also contain sensitive text. Files use owner-only permissions and
private directories. Existing copies created by older versions are not
retroactively scrubbed. OS permissions do not protect against other processes
running as the same user.

State defaults to `~/.local/state/jev-hooks`, overridden by `JEV_STATE_DIR`.
`JEV_LOG` can select a separate log file. Slim output uses private temporary
storage; use the footer path as authoritative. A consumed compaction brief is
removed when it was injected whole; one that exceeded the host's context cap
is kept as `carry-forward-<hash>.full.md` so the bounded injection can point
at it. Stashed Codex prompts are removed at SessionEnd and persist if that
event never fires. The latest user request is also written to a per-session
`task-<hash>.txt` for the slimmer (so it no longer travels inline in every
rewritten command); files older than seven days are swept whenever a new one
is written, and Codex removes its own at SessionEnd. `breaker.json` holds
only failure counts, a timestamp and a redacted error message. Text that hosts inject into user turns (system reminders,
hook notifications, terminal relays) is stripped before harvesting and is not
carried into briefs or task strings. A successful user-run `git push` is reduced
to its remote, branch, short commit SHA when available, and success state for guard judgment; the raw terminal
relay is not sent. Logs and saved output have no automatic
retention guarantee; review and delete specific artifacts when no longer
needed. Removing hooks does not remove these artifacts. Never delete an entire
user-selected state directory without checking its contents and authorized
scope.

Offline tests use synthetic data and mocked requests. Live evals must use
approved fixtures and an inherited key; exclude raw payloads and credentials
from published results. Disabling remote judgments does not sanitize original
stdout or the local historical transcript.
