// ──────────────────────────────────────────────────────────────────────
//  The part of a PreToolUse hook every host shares: git safety, then the
//  guard, then one log record for the verdict. Adapters in bin/ keep what
//  differs — reading the host's event, finding the task, the response
//  envelope, command slimming and every other hook event.
// ──────────────────────────────────────────────────────────────────────

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { guard, ALLOW, ASK, DENY } from "./guard.mjs";
import { checkGitSafety } from "./supervision.mjs";
import { logDecision } from "./log.mjs";
import config from "./config.mjs";

export { ALLOW, ASK, DENY };

export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

export const emit = (payload) => {
  if (payload) process.stdout.write(JSON.stringify(payload));
  process.exit(0);
};

export const nothing = () => process.exit(0);

/**
 * Is the module at `url` the process entry point? Compared through realpath
 * because the installer may register a symlink. Lets tests import an adapter
 * without it reading stdin.
 */
export function isEntryPoint(url) {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}

/**
 * Judge one tool call.
 *
 * @param {object} call
 * @param {string} [call.agent]    host name for the log; Claude records none
 * @param {string} [call.tool]     tool name as the host spells it, for the log
 * @param {object} [call.logFields] extra fields for the verdict record
 * @param {string} [call.command]  the shell command, when the call runs one
 * @param {boolean} call.guarded   whether the guard runs on this call
 * @param {object} call.transcript transcriptContext() of the session
 * @param {number} call.hookStarted when the hook began, for `hook_ms`
 * @returns {Promise<{decision: string, reason: string, advisory?: string, log: (extra?: object) => void}>}
 *   `log` writes the verdict record; a git-safety stop is logged already.
 */
export async function judge({ agent, tool, toolName, input, cwd, command, guarded, hostRoots, transcript, logFields, hookStarted }) {
  const started = Date.now();
  const base = { ...(agent ? { agent } : {}), hook: "PreToolUse", tool: tool ?? toolName };
  if (config.gitSafety && typeof command === "string") {
    const gitCheck = checkGitSafety({ command, cwd });
    if (gitCheck) {
      logDecision({ ...base, gitSafety: true, ...gitCheck, hook_ms: Date.now() - hookStarted });
      return { ...gitCheck, log: () => {} };
    }
  }

  const { task, recentCalls, recentUserActions, userCommands, observed, writtenDirs } = transcript;
  let verdict = { decision: ALLOW, reason: "not guarded", by: "code" };
  if (guarded) {
    verdict = await guard({
      toolName,
      input,
      cwd,
      task,
      recentCalls,
      recentUserActions,
      userCommands,
      observed,
      ...(hostRoots ? { hostRoots } : {}),
      writtenDirs,
    });
  }
  const guardMs = Date.now() - started;
  const log = (extra = {}) => logDecision({
    ...base,
    ...logFields,
    decision: verdict.decision,
    by: verdict.by,
    reason: verdict.reason,
    signals: verdict.signals,
    probabilities: verdict.probabilities,
    // `ms` keeps its historical meaning: time after transcript/task parsing.
    ms: guardMs,
    // `hook_ms` is taken when the adapter logs, so it covers the complete
    // PreToolUse path, including supervision and command rewriting.
    hook_ms: Date.now() - hookStarted,
    cost_usd: verdict.cost,
    ...extra,
  });
  return { decision: verdict.decision, reason: verdict.reason, advisory: verdict.advisory, log };
}
