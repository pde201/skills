// ──────────────────────────────────────────────────────────────────────
//  supervision.mjs — Advanced agent quality & safety supervision for Jev.
//
//  Powers Antigravity-specific lifecycle hooks:
//    - PreInvocation: Goal drift and thrashing detection
//    - Stop: Definition of Done (DoD) verification gate
//    - PostToolUse: Structured error triage and diagnostic logging
//    - PreToolUse: Git pre-commit & diff hygiene
// ──────────────────────────────────────────────────────────────────────

import { execSync } from "node:child_process";
import { recentToolCalls, latestUserRequest } from "./transcript.mjs";
import { systemOne, noul, choice, score, haveKey } from "./client.mjs";
import { logDecision } from "./log.mjs";
import { looksLikeSecretFile } from "./privacy.mjs";
import config from "./config.mjs";

// `--force` and `-f`, but not `--force-with-lease` or `--force-if-includes`,
// which is the same line lib/guard.mjs draws.
const FORCE_PUSH = /\bgit\s+push\b[^|;&]*\s(--force|-f)(\s|$)/;
// `git commit -a` / `--all` / `-am` stages every modified tracked file at
// commit time, so the worktree column of `git status` counts as staged too.
const STAGES_ALL = /\s(--all|-[a-zA-Z]*a[a-zA-Z]*)(\s|$)/;

// Which tools change files, by the names each host reports them under.
const EDIT_TOOLS = new Set([
  "replace_file_content", "edit_file", "write_to_file", "create_file", // Antigravity
  "apply_patch",                                                        // Codex
  "edit", "write", "multiedit", "notebookedit",                         // Claude Code, Codex aliases
]);

const TEST_COMMAND_PATTERNS = [
  /\b(npm|pnpm|yarn|bun)\s+(test|run\s+test)/,
  /\b(mvn|gradle)\s+(test|verify)/,
  /\bpytest\b/,
  /\bcargo\s+test\b/,
  /\bgo\s+test\b/,
  /\b(vitest|jest)\b/,
  /\bpython[0-9.]*\s+-m\s+(unittest|pytest)\b/,
  /\bnode\s+--test\b/,
];

/**
 * Detect repeated failures (thrashing) or deviation from the user's task.
 * Runs in PreInvocation.
 *
 * @param {object} opts
 * @param {string} opts.transcriptPath
 * @param {object} [opts.transcriptSnapshot] parsed transcript shared by the hook
 * @param {string} [opts.latestRequest]
 * @returns {Promise<{warning: string|null, thrashing?: number, goalDrift?: number}>}
 */
export async function checkGoalDriftAndThrashing({ transcriptPath, transcriptSnapshot, latestRequest } = {}) {
  if (!config.supervision) return { warning: null };

  const source = transcriptSnapshot ?? transcriptPath;
  const calls = recentToolCalls(source, { limit: 8 });
  if (calls.length < 3) return { warning: null };

  const task = latestRequest || latestUserRequest(source);
  if (!task) return { warning: null };

  // Look for repeated errors or identical tool invocations. A call is the
  // same call only when its target and its detail match: four edits to one
  // file that replace different text are four different calls. And a run
  // of identical calls that all succeeded is not a loop — thrashing means
  // repeating what failed — so duplicates only count once something has.
  const failedCalls = calls.filter((c) => c.failed);
  const consecutiveFailures = calls.slice(-3).filter((c) => c.failed).length;
  const recentInputs = calls.slice(-4).map((c) => `${c.tool}:${c.input}:${c.detail ?? ""}`);
  const duplicateInputs = recentInputs.length - new Set(recentInputs).size;

  const showsSignsOfLooping =
    consecutiveFailures >= 2 ||
    (duplicateInputs >= 2 && failedCalls.length >= 1) ||
    failedCalls.length >= 4;
  if (!showsSignsOfLooping) return { warning: null };

  if (haveKey()) {
    try {
      const res = await systemOne({
        model: config.model,
        timeoutMs: 2500,
        state: {
          user_request: task.slice(0, 1000),
          recent_calls: calls.map((c) => `${c.tool}(${c.input.slice(0, 120)}${c.detail ? ` · ${c.detail}` : ""}) => ${c.failed ? "FAILED: " + (c.result || "") : "OK"}`).join("\n"),
        },
        questions: {
          thrashing: noul("Has the agent attempted essentially the same failed action or debugging loop repeatedly without making tangible progress?"),
          goal_drift: noul("Has the agent drifted away from addressing the explicit requirements of the user request?"),
          remedy: choice("What is the most constructive directive for the agent?", {
            re_read_error: "Re-read the exact error message and inspect the failing code directly",
            refocus_task: "Refocus on the user's stated requirements and stop exploring tangents",
            ask_user: "Blocked or uncertain; ask the user for clarification",
            on_track: "Proceed with the current approach",
          }),
        },
      });

      const thrashingProb = res.answers?.thrashing?.noul ?? 0;
      const driftProb = res.answers?.goal_drift?.noul ?? 0;
      const remedy = res.answers?.remedy?.choice ?? "re_read_error";

      if (thrashingProb >= config.thrashingThreshold) {
        const text = remedy === "ask_user"
          ? "Repeated tool failures detected. If you are blocked or unsure of the design, pause and ask the user."
          : "Repetitive failure loop detected. Stop repeating similar edits or commands; re-read the exact error details and inspect the target file carefully.";
        return { warning: `[Jev Supervision] ${text}`, thrashing: thrashingProb };
      }

      if (driftProb >= config.thrashingThreshold) {
        return {
          warning: `[Jev Supervision] Potential goal drift detected. Ensure your next actions directly serve: "${task.slice(0, 120)}"`,
          goalDrift: driftProb,
        };
      }
    } catch {
      // Fall through to deterministic warning
    }
  }

  if (consecutiveFailures >= 3) {
    return {
      warning: "[Jev Supervision] Notice: 3 consecutive tool failures. Take a step back, inspect the exact file contents and error outputs before retrying.",
    };
  }

  return { warning: null };
}

/**
 * Definition of Done (DoD) verification gate.
 * Runs in Stop hook when terminationReason is "model_stop".
 *
 * @param {object} opts
 * @param {string} opts.transcriptPath
 * @param {object} [opts.transcriptSnapshot] parsed transcript shared by the hook
 * @param {string} [opts.latestRequest]
 * @param {number} [opts.timeoutMs]  per-attempt budget for the model call
 * @param {number} [opts.retries]    hosts that cap this event short pass 0
 * @returns {Promise<{allow: boolean, reason?: string}>}
 */
export async function checkDefinitionOfDone({ transcriptPath, transcriptSnapshot, latestRequest, timeoutMs = 2500, retries } = {}) {
  if (!config.dodGate) return { allow: true };

  const source = transcriptSnapshot ?? transcriptPath;
  const calls = recentToolCalls(source, { limit: 50 });
  const task = latestRequest || latestUserRequest(source);

  // Identify if any modification tools were executed
  let lastEditIndex = -1;
  const modifiedTargets = [];

  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];
    if (EDIT_TOOLS.has(String(c.tool ?? "").toLowerCase())) {
      lastEditIndex = i;
      modifiedTargets.push(c.input);
    }
  }

  // If no files were modified in this session, DoD does not block completion
  if (lastEditIndex === -1) {
    return { allow: true };
  }

  // Files were modified. Check what happened after the last modification
  const postEditCalls = calls.slice(lastEditIndex + 1);
  const testCallsAfterEdit = postEditCalls.filter((c) => {
    const isShell = c.tool === "run_command" || c.tool === "Bash";
    if (!isShell) return false;
    return TEST_COMMAND_PATTERNS.some((p) => p.test(c.input));
  });

  // If zero test commands were run after code changes
  if (testCallsAfterEdit.length === 0) {
    const uniqueFiles = [...new Set(modifiedTargets)].slice(0, 3).join(", ");
    return {
      allow: false,
      reason: `Jev Verification Gate: Files were modified (${uniqueFiles || "code files"}), but no test commands were run afterwards. Please run the test suite or verify your changes before completing.`,
    };
  }

  // If the last test command failed
  const lastTest = testCallsAfterEdit[testCallsAfterEdit.length - 1];
  if (lastTest.failed) {
    return {
      allow: false,
      reason: `Jev Verification Gate: The most recent test execution failed (${lastTest.input.slice(0, 80)}). Please fix remaining issues before completing.`,
    };
  }

  // If we have an API key, check task completion against user request
  if (haveKey() && task) {
    try {
      const res = await systemOne({
        model: config.model,
        timeoutMs,
        ...(retries !== undefined ? { retries } : {}),
        state: {
          task: task.slice(0, 1000),
          recent_activity: calls.slice(-6).map((c) => `${c.tool}(${c.input.slice(0, 100)}) => ${c.failed ? "FAILED" : "OK"}`).join("\n"),
        },
        questions: {
          task_complete: noul("Based on the session activity, has the requested task been substantially completed?"),
          verification_quality: score("How thoroughly were the changes verified?", [
            "None: no checks run",
            "Shallow: inspected files or diff only",
            "Tested: unit or integration test executed",
            "Thorough: test suite passed cleanly",
          ]),
        },
      });

      const isComplete = res.answers?.task_complete?.noul ?? 1;
      const verifScore = res.answers?.verification_quality?.score ?? 2;

      if (verifScore === 0 || isComplete < 0.25) {
        return {
          allow: false,
          reason: "Jev Verification Gate: The requested changes have not been verified with automated tests. Please verify your work before concluding.",
        };
      }
    } catch {
      // Fall through to allow on API error
    }
  }

  return { allow: true };
}

/**
 * Classify a tool execution failure into actionable diagnostic categories.
 * Runs in PostToolUse when error is present.
 *
 * @param {object} opts
 * @param {string} opts.toolName
 * @param {string|object} opts.input
 * @param {string} opts.error
 * @param {string} [opts.agent]  which adapter is asking, for the log
 * @returns {Promise<{category: string, confidence?: number, skipped?: boolean}>}
 */
export async function triageToolError({ toolName, input, error, agent = "unknown" } = {}) {
  if (!config.supervision) return { category: "unknown", skipped: true };

  const errStr = typeof error === "string" ? error : JSON.stringify(error || "");
  const inputStr = typeof input === "string" ? input : JSON.stringify(input || "");

  if (haveKey()) {
    try {
      const res = await systemOne({
        model: config.model,
        timeoutMs: 2000,
        state: {
          tool: toolName,
          input: inputStr.slice(0, 300),
          error: errStr.slice(0, 1500),
        },
        questions: {
          category: choice("Classify the technical cause of this tool execution failure", {
            syntax_compile: "Syntax error, type mismatch, or compilation failure",
            test_assertion: "Test assertion failure or expectation mismatch",
            missing_dependency: "Command, library, or package not found",
            permission_or_path: "File not found, path error, or permission denied",
            timeout_or_network: "Network failure, connection reset, or timeout",
            unknown: "Other or unclassifiable error",
          }),
        },
      });

      const cat = res.answers?.category?.choice || "unknown";
      const conf = res.answers?.category?.confidence || 0;
      logDecision({ agent, hook: "PostToolUse", triage: cat, confidence: conf, tool: toolName });
      return { category: cat, confidence: conf };
    } catch {
      // Fall through
    }
  }

  // Deterministic fallback
  let cat = "unknown";
  if (/syntaxerror|compilation error|cannot find symbol|parse error/i.test(errStr)) {
    cat = "syntax_compile";
  } else if (/assertionerror|expected .* but received|test failed/i.test(errStr)) {
    cat = "test_assertion";
  } else if (/not found|command not found|cannot find module|no such file/i.test(errStr)) {
    cat = "missing_dependency";
  } else if (/eacces|permission denied|read-only/i.test(errStr)) {
    cat = "permission_or_path";
  } else if (/etimedout|econnrefused|timeout/i.test(errStr)) {
    cat = "timeout_or_network";
  }

  logDecision({ agent, hook: "PostToolUse", triage: cat, deterministic: true, tool: toolName });
  return { category: cat };
}

/**
 * Inspect git commands for safety and pre-commit diff hygiene.
 * Runs in PreToolUse when toolCall is run_command.
 *
 * @param {object} opts
 * @param {string} opts.command
 * @param {string} [opts.cwd]
 * @returns {{decision: string, reason?: string}|null}
 */
export function checkGitSafety({ command, cwd } = {}) {
  if (!config.gitSafety || typeof command !== "string") return null;

  const isGitCommit = /\bgit\s+commit\b/.test(command);
  const isGitPush = /\bgit\s+push\b/.test(command);

  if (!isGitCommit && !isGitPush) return null;

  // Catastrophic push checks
  if (isGitPush && FORCE_PUSH.test(command) && /\b(main|master|prod|production)\b/.test(command)) {
    return {
      decision: "ask",
      reason: "Jev Git Safety: force push to main/master branches requires explicit confirmation.",
    };
  }

  // For git commit, check staged files if running inside a repo
  if (isGitCommit && cwd) {
    try {
      const statusOutput = execSync("git status --porcelain", { cwd, encoding: "utf8", timeout: 1500 });
      const stagesAll = STAGES_ALL.test(command);
      const stagedFiles = statusOutput
        .split("\n")
        .filter((line) => /^[MADRC]/.test(line) || (stagesAll && /^.[MD]/.test(line)))
        .map((line) => line.slice(3).trim());

      const sensitiveFiles = stagedFiles.filter(looksLikeSecretFile);

      if (sensitiveFiles.length > 0) {
        return {
          decision: "ask",
          reason: `Jev Git Safety: Sensitive file staged for commit (${sensitiveFiles.join(", ")}). Are you sure you want to commit this?`,
        };
      }
    } catch {
      // If git status fails (not a repo or git missing), ignore
    }
  }

  return null;
}
