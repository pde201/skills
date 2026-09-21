# Data handling

`lib/client.mjs` sends judgments to TypeSafe (`api.typesafe.ai` by default;
`TYPESAFE_BASE_URL` overrides the endpoint). Guard state includes task, working
directory, tool input, recent calls, and observed paths. Slimming includes task,
command, and output blocks. Compaction includes candidate history and current
task. These can contain source code, personal data, and business information.

Outbound state and decision logs pass through common-secret/PII redaction.
This is pattern-based risk reduction, not a complete content classifier or a
promise that all secrets, names, or personal data are removed. Confirm the
endpoint and data category are permitted before enabling remote judgments.
Provider retention and account policies are not established by this repository.

Full original output is saved locally for recovery; local briefs and stashed
prompts may also contain sensitive text. Files use owner-only permissions and
private directories. Existing copies created by older versions are not
retroactively scrubbed. OS permissions do not protect against other processes
running as the same user.

State defaults to `~/.local/state/jev-hooks`, overridden by `JEV_STATE_DIR`.
`JEV_LOG` can select a separate log file. Slim output uses private temporary
storage; use the footer path as authoritative. Consumed compaction briefs are
removed. Logs and saved output have no automatic retention guarantee; review
and delete specific artifacts when no longer needed. Removing hooks does not
remove these artifacts. Never delete an entire user-selected state directory
without checking its contents and authorized scope.

Offline tests use synthetic data and mocked requests. Live evals must use
approved fixtures and an inherited key; exclude raw payloads and credentials
from published results. Disabling remote judgments does not sanitize original
stdout or the local historical transcript.
