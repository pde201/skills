#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────────────
//  jev-hook-codex — the Codex adapter for the Jev decision layer.
//
//  Codex's hook contract is close enough to Claude Code's that lib/ is
//  reused verbatim; everything Codex-specific lives in this one file.
//  What differs, and why each difference needs code:
//
//    · Tool names.  Shell is `Bash`, edits arrive as `apply_patch` with a
//      patch envelope rather than file_path/old_string. The deterministic
//      Edit checks in lib/guard.mjs simply do not match that shape, so
//      they stand down and the judgment layer takes it — which is the
//      right outcome, not a gap.
//
//    · Command shape.  Codex has shipped `command` both as a string and
//      as an argv array (`["bash","-lc","…"]`). Rewriting the wrong one
//      silently turns slimming off, so both are handled and the shape is
//      recorded in the log.
//
//    · Task text.  PreToolUse carries no prompt, and the transcript
//      format is not one this repo can promise to parse. Codex has a
//      `UserPromptSubmit` event, so the prompt is stashed when it is
//      stated and read back when it is needed. The transcript stays as
//      the fallback.
//
//  Docs: https://learn.chatgpt.com/docs/hooks
//
//  The rule the Claude Code adapter set holds here too: every path ends
//  in exit 0. A hook is never the reason a session fails.
// ──────────────────────────────────────────────────────────────────────

import { writeFileSync, readFileSync, unlinkSync, existsSync, realpathSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { guard, ALLOW, ASK, DENY } from "../lib/guard.mjs";
import { shouldWrap, rewrite, dropTask } from "../lib/wrap.mjs";
import { buildBrief, consumeBrief } from "../lib/carryforward.mjs";
import {
  checkGoalDriftAndThrashing,
  checkDefinitionOfDone,
  triageToolError,
  checkGitSafety,
} from "../lib/supervision.mjs";
import { activeTaskContext, recentToolCalls, recentUserActions, observedPaths, writtenDirs } from "../lib/transcript.mjs";
import { logDecision, stateDir } from "../lib/log.mjs";
import config from "../lib/config.mjs";

// Codex reports `Bash` and `apply_patch`; its matcher aliases mean Edit
// and Write can arrive too, so all four are accepted.
const GUARDED_TOOLS = new Set(["Bash", "apply_patch", "Edit", "Write", "Read"]);

// Pairing `updatedInput` with `permissionDecision: "allow"` is how the
// Codex docs spell the rewrite, but `allow` also skips the approval
// prompt — quietly widening what runs is not this layer's job. So the
// rewrite goes out on its own, and anyone whose Codex build ignores an
// unpaired `updatedInput` can opt into the pairing knowingly.
const SLIM_SELF_APPROVES = /^(1|true|yes|on)$/i.test(process.env.JEV_CODEX_SLIM_ALLOW ?? "");

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

const emit = (payload) => {
  if (payload) process.stdout.write(JSON.stringify(payload));
  process.exit(0);
};

const nothing = () => process.exit(0);

// ── The prompt stash ─────────────────────────────────────────────────

const promptPath = (sessionId) => join(stateDir(), `codex-prompt-${createHash("sha256").update(String(sessionId || "unknown")).digest("hex")}.txt`);

function stashPrompt(sessionId, prompt) {
  if (typeof prompt !== "string" || !prompt.trim()) return false;
  let temporary;
  try {
    const path = promptPath(sessionId);
    temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, prompt, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
    return true;
  } catch {
    return false;
  } finally {
    if (temporary) {
      try { unlinkSync(temporary); } catch { /* Already renamed or never created. */ }
    }
  }
}

function readStashedPrompt(sessionId) {
  try {
    const path = promptPath(sessionId);
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

function dropPrompt(sessionId) {
  try {
    const path = promptPath(sessionId);
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // Losing a stale stash file is not worth a failure.
  }
}

/** The stash supplies the newest prompt; the transcript supplies its task anchor. */
const taskFor = (event) =>
  activeTaskContext(event.transcript_path, { latestPrompt: readStashedPrompt(event.session_id) });

// ── Command shape ────────────────────────────────────────────────────

/**
 * Pull the shell command out of a tool input whose shape Codex has not
 * frozen. Returns the shape alongside it so the rewrite can put the
 * command back the way it came.
 *
 * @returns {{command: string, shape: string, index?: number} | null}
 */
export function readCommand(input) {
  if (!input || typeof input !== "object") return null;
  const raw = input.command;

  if (typeof raw === "string") return { command: raw, shape: "string" };

  if (Array.isArray(raw) && raw.length && raw.every((part) => typeof part === "string")) {
    // `["bash", "-lc", "<command>"]` — the script is the last element, and
    // only that element is ours to rewrite. A bare argv vector with no
    // shell in front of it is not a shell command at all; joining it would
    // invent quoting that was never there.
    const index = raw.length - 1;
    const isShellForm = raw.length >= 2 && /(^|\/)(ba|z|k)?sh$/.test(raw[0]) && /^-.*c/.test(raw[1]);
    if (!isShellForm) return null;
    return { command: raw[index], shape: "argv", index };
  }

  return null;
}

/** Put a rewritten command back into a copy of the input it came from. */
export function writeCommand(input, rewritten, found) {
  if (found.shape === "argv") {
    const command = [...input.command];
    command[found.index] = rewritten;
    return { ...input, command };
  }
  return { ...input, command: rewritten };
}

// ── PreToolUse ───────────────────────────────────────────────────────

async function preToolUse(event) {
  const { tool_name: toolName, tool_input: input, cwd } = event;
  const task = taskFor(event);
  const started = Date.now();

  // Git safety check on commits and pushes
  if (toolName === "Bash" && config.gitSafety) {
    const foundCmd = readCommand(input);
    if (foundCmd) {
      const gitCheck = checkGitSafety({ command: foundCmd.command, cwd });
      if (gitCheck) {
        logDecision({
          agent: "codex",
          hook: "PreToolUse",
          tool: "Bash",
          gitSafety: true,
          decision: gitCheck.decision,
          reason: gitCheck.reason,
        });
        if (gitCheck.decision === "deny" || gitCheck.decision === "ask") {
          return emit({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: gitCheck.decision,
              permissionDecisionReason: gitCheck.reason,
            },
          });
        }
      }
    }
  }

  let verdict = { decision: ALLOW, reason: "not guarded", by: "code" };
  if (GUARDED_TOOLS.has(toolName)) {
    verdict = await guard({
      toolName,
      input,
      cwd,
      task,
      recentCalls: recentToolCalls(event.transcript_path),
      recentUserActions: recentUserActions(event.transcript_path),
      observed: observedPaths(event.transcript_path),
      writtenDirs: writtenDirs(event.transcript_path),
    });
  }

  logDecision({
    agent: "codex",
    hook: "PreToolUse",
    tool: toolName,
    decision: verdict.decision,
    by: verdict.by,
    reason: verdict.reason,
    signals: verdict.signals,
    probabilities: verdict.probabilities,
    ms: Date.now() - started,
    cost_usd: verdict.cost,
  });

  if (verdict.decision === DENY || verdict.decision === ASK) {
    return emit({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: verdict.decision,
        permissionDecisionReason: verdict.reason,
      },
    });
  }

  if (toolName !== "Bash") return nothing();

  const found = readCommand(input);
  if (!found) {
    // Worth a line in the log rather than silence: if Codex ever changes
    // the shape again, this is the entry that says slimming stopped.
    logDecision({
      agent: "codex",
      hook: "PreToolUse",
      tool: "Bash",
      wrapped: false,
      reason: "no command found in tool_input",
      input_keys: Object.keys(input ?? {}),
    });
    return nothing();
  }

  const { wrap, why } = shouldWrap(found.command);
  if (!wrap) {
    logDecision({ agent: "codex", hook: "PreToolUse", tool: "Bash", wrapped: false, reason: why });
    return nothing();
  }

  logDecision({
    agent: "codex",
    hook: "PreToolUse",
    tool: "Bash",
    wrapped: true,
    matched: why,
    shape: found.shape,
    self_approved: SLIM_SELF_APPROVES,
    command: found.command.slice(0, 200),
  });

  const hookSpecificOutput = {
    hookEventName: "PreToolUse",
    updatedInput: writeCommand(input, rewrite(found.command, task, { key: event.session_id }), found),
  };
  if (SLIM_SELF_APPROVES) {
    hookSpecificOutput.permissionDecision = "allow";
    hookSpecificOutput.permissionDecisionReason = "jev: command rewritten to slim its output";
  }

  return emit({
    hookSpecificOutput,
    systemMessage: `jev: routing ${why} output through the slimmer`,
  });
}

// ── UserPromptSubmit ─────────────────────────────────────────────────

function userPromptSubmit(event) {
  const stashed = stashPrompt(event.session_id, event.prompt);
  logDecision({ agent: "codex", hook: "UserPromptSubmit", stashed });
  // Nothing is emitted: this hook exists to remember, not to interfere.
  return nothing();
}

// ── PreCompact ───────────────────────────────────────────────────────

async function preCompact(event) {
  const started = Date.now();
  const result = await buildBrief({
    transcriptPath: event.transcript_path,
    sessionId: event.session_id,
  });
  logDecision({ agent: "codex", hook: "PreCompact", trigger: event.trigger, ...result, ms: Date.now() - started });
  return nothing();
}

// ── SessionStart ─────────────────────────────────────────────────────

function sessionStart(event) {
  if (event.source !== "compact") return nothing();
  const brief = consumeBrief(event.session_id);
  if (!brief) return nothing();

  logDecision({ agent: "codex", hook: "SessionStart", source: event.source, injected_chars: brief.length });
  return emit({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: brief,
    },
  });
}

// ── SessionEnd ───────────────────────────────────────────────────────

async function sessionEnd(event) {
  dropPrompt(event.session_id);
  dropTask(event.session_id);
  if (config.dodGate && event.transcript_path) {
    try {
      // Codex gives this event three seconds. One attempt, well inside it.
      const dod = await checkDefinitionOfDone({ transcriptPath: event.transcript_path, timeoutMs: 1500, retries: 0 });
      if (!dod.allow) {
        logDecision({ agent: "codex", hook: "SessionEnd", unverified: true, reason: dod.reason });
      }
    } catch {}
  }
  return nothing();
}

// ── PostToolUse / PostToolUseFailure ─────────────────────────────────
//
// Codex's failure event shape is not pinned down by documentation this repo
// can cite, so both names are accepted and both error spellings are read.

async function postToolUse(event) {
  const error = event.error || (event.tool_result?.is_error ? event.tool_result?.content : null);
  if (error && !event.is_interrupt) {
    try {
      await triageToolError({
        toolName: event.tool_name,
        input: event.tool_input,
        error,
        agent: "codex",
      });
    } catch {}
  }
  return nothing();
}

// ── Dispatch ─────────────────────────────────────────────────────────

async function main() {
  if (!config.enabled) return nothing();

  let event;
  try {
    event = await readStdin();
  } catch {
    return nothing();
  }

  switch (event.hook_event_name) {
    case "PreToolUse":
      return await preToolUse(event);
    case "PostToolUse":
    case "PostToolUseFailure":
      return await postToolUse(event);
    case "UserPromptSubmit":
      return userPromptSubmit(event);
    case "PreCompact":
      return await preCompact(event);
    case "SessionStart":
      return sessionStart(event);
    case "SessionEnd":
      return await sessionEnd(event);
    default:
      return nothing();
  }
}

// Only run the dispatcher when this file is the entry point, so the tests
// can import readCommand/writeCommand without the hook reading stdin.
// Compared through realpath because the installer may register a symlink.
const runningAsHook = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (runningAsHook) {
  main().catch((err) => {
    try {
      logDecision({ agent: "codex", hook: "error", message: String(err?.message ?? err) });
    } catch {}
    process.exit(0);
  });
}
