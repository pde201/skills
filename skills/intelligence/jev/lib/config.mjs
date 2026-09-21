// ──────────────────────────────────────────────────────────────────────
//  Every knob in one place, all overridable by environment variable so a
//  machine can dial this down in ~/.zshrc.local without editing the repo.
// ──────────────────────────────────────────────────────────────────────

const num = (name, fallback) => {
  const raw = process.env[name];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

const bool = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return !/^(0|false|no|off)$/i.test(raw);
};

const list = (name, fallback) => {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
};

export const config = {
  // Master switch. Unset JEV_HOOKS=0 disables every judgment; hooks then
  // return an empty decision and Claude Code behaves exactly as before.
  enabled: bool("JEV_HOOKS", true),

  // Per-feature switches, so a feature that misbehaves can be dropped
  // without losing the other two.
  slim: bool("JEV_HOOKS_SLIM", true),
  guard: bool("JEV_HOOKS_GUARD", true),
  carryForward: bool("JEV_HOOKS_CARRY_FORWARD", true),
  supervision: bool("JEV_HOOKS_SUPERVISION", true),
  dodGate: bool("JEV_DOD_GATE", true),
  // How many times the Stop gate may send the agent back before standing
  // down for that conversation. Claude Code caps its own Stop hooks at 8.
  dodMaxContinues: num("JEV_DOD_MAX_CONTINUES", 2),
  gitSafety: bool("JEV_GIT_SAFETY", true),
  thrashingThreshold: num("JEV_THRASHING_THRESHOLD", 0.75),

  // Hooks sit in the critical path of every tool call. A judgment that has
  // not returned in this long is worth less than the latency it costs.
  timeoutMs: num("JEV_TIMEOUT_MS", 4000),
  retries: num("JEV_RETRIES", 1),
  model: process.env.JEV_MODEL || "jev-latest",

  // After this many consecutive provider failures (5xx, 429, timeout,
  // network — never a 4xx or a malformed answer, which are our bugs) remote
  // judgments are skipped for the cooldown and fail open at once. 0 disables.
  breakerFailures: num("JEV_BREAKER_FAILURES", 3),
  breakerCooldownMs: num("JEV_BREAKER_COOLDOWN_MS", 60_000),

  // Output below this many lines is not worth a round trip.
  slimMinLines: num("JEV_SLIM_MIN_LINES", 60),

  // Guard thresholds. Deliberately conservative: `ask` is cheap, `deny` is
  // not. Tune these against jev-log.jsonl on real sessions before trusting
  // the defaults — they are a starting point, not a measured result.
  guardAskAt: num("JEV_GUARD_ASK_AT", 0.45),
  guardDenyAt: num("JEV_GUARD_DENY_AT", 0.85),
  guardBlastRadiusBlock: num("JEV_GUARD_BLAST_RADIUS_BLOCK", 3),

  // Extra directories that count as the workspace for `wrong_scope`, on top
  // of the cwd, the host's workspace folders, the directories this session
  // has already written to, and the temp directory. Comma-separated; `~` ok.
  workspaceRoots: list("JEV_WORKSPACE_ROOTS", []),

  // A Read changes nothing, so by default it gets the deterministic checks
  // only (existence, directory, credential-shaped path) and no model call.
  // On real sessions 26 of 26 Read judgments were allowed at ~300 ms each.
  guardReadsWithModel: bool("JEV_GUARD_READ_MODEL", false),

  // Commands whose output is reliably bloated. Only these get wrapped;
  // anything else runs exactly as the model wrote it. git, gh, grep and ls
  // are deliberately absent: on real sessions they were 53 of 59 wrapped
  // commands and not one of them produced a slimmer output.
  slimCommands: list("JEV_SLIM_COMMANDS", [
    "npm", "pnpm", "yarn", "bun", "npx",
    "pytest", "python", "python3", "tox", "uv",
    "jest", "vitest", "mocha",
    "cargo", "go", "gradle", "mvn", "dotnet", "make", "just",
    "kubectl", "docker", "helm", "terraform", "aws", "gcloud",
    "tsc", "eslint", "ruff", "mypy", "pylint",
    "find", "tree", "rg", "du", "df",
    "curl", "xh", "http",
  ]),

  // Never wrap these, whatever else matches: they stream, need a terminal,
  // or are the user watching something happen.
  neverWrap: list("JEV_NEVER_WRAP", [
    "vim", "vi", "nano", "emacs", "less", "more", "top", "htop", "btm",
    "watch", "tail", "ssh", "tmux", "screen", "fzf", "gitui", "atuin",
    "claude", "codex", "pi",
  ]),

  logPath: process.env.JEV_LOG || null, // null → <state dir>/jev-log.jsonl
};

export default config;
