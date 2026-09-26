#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────────────
//  jev-hook — one entry point for every Claude Code hook event.
//
//  Reads the event JSON on stdin, dispatches on hook_event_name, writes
//  the decision JSON on stdout.
//
//  The first rule of a hook that runs on every tool call is that it must
//  never be the reason something fails. Every path here ends in exit 0
//  with either a decision or nothing at all; an internal error means the
//  session carries on exactly as if these hooks were not installed.
// ──────────────────────────────────────────────────────────────────────

import { guard, ALLOW, ASK, DENY } from "../lib/guard.mjs";
import { shouldWrap, rewrite } from "../lib/wrap.mjs";
import { buildBrief, consumeBrief } from "../lib/carryforward.mjs";
import {
  checkGoalDriftAndThrashing,
  triageToolError,
  checkGitSafety,
} from "../lib/supervision.mjs";
import { createTranscriptSnapshot, transcriptContext } from "../lib/transcript.mjs";
import { logDecision } from "../lib/log.mjs";
import { createHash } from "node:crypto";
import config from "../lib/config.mjs";

const GUARDED_TOOLS = new Set(["Bash", "Edit", "Write", "NotebookEdit", "Read"]);

/** One line naming what a call did: a command's head, or the file it targets. */
function callSummary(toolName, input) {
  if (typeof input?.command === "string") return input.command.replace(/\s+/g, " ").trim().slice(0, 160);
  const path = input?.file_path ?? input?.notebook_path;
  return typeof path === "string" ? path : undefined;
}

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

// ── PreToolUse ───────────────────────────────────────────────────────

async function preToolUse(event) {
  const { tool_name: toolName, tool_input: input, cwd, transcript_path: transcriptPath } = event;
  const hookStarted = Date.now();
  const transcript = transcriptContext(createTranscriptSnapshot(transcriptPath));
  const { snapshot: transcriptSnapshot, task, recentCalls, recentUserActions, observed, writtenDirs } = transcript;
  const started = Date.now();

  // Git safety check on commits and pushes
  if (config.gitSafety && toolName === "Bash" && typeof input?.command === "string") {
    const gitCheck = checkGitSafety({ command: input.command, cwd });
    if (gitCheck) {
      logDecision({ hook: "PreToolUse", tool: "Bash", gitSafety: true, ...gitCheck, hook_ms: Date.now() - hookStarted });
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

  let verdict = { decision: ALLOW, reason: "not guarded", by: "code" };
  if (GUARDED_TOOLS.has(toolName)) {
    verdict = await guard({
      toolName,
      input,
      cwd,
      task,
      recentCalls,
      recentUserActions,
      observed,
      writtenDirs,
    });
  }
  const guardMs = Date.now() - started;
  const logVerdict = (extra = {}) => logDecision({
    hook: "PreToolUse",
    tool: toolName,
    // Enough to tie a decision back to its call and the request in force,
    // without a transcript: the log is otherwise unauditable after the fact.
    session_id: event.session_id,
    cwd,
    call: callSummary(toolName, input),
    task_hash: task ? createHash("sha256").update(task).digest("hex").slice(0, 12) : undefined,
    decision: verdict.decision,
    by: verdict.by,
    reason: verdict.reason,
    signals: verdict.signals,
    probabilities: verdict.probabilities,
    // `ms` keeps its historical meaning: time after transcript/task parsing.
    ms: guardMs,
    // `hook_ms` is recorded at the final branch so it covers the complete
    // PreToolUse path, including transcript parsing, supervision, and rewrite.
    hook_ms: Date.now() - hookStarted,
    cost_usd: verdict.cost,
    ...extra,
  });

  if (verdict.decision === DENY || verdict.decision === ASK) {
    logVerdict();
    return emit({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: verdict.decision,
        permissionDecisionReason: verdict.reason,
      },
    });
  }

  // Thrashing and goal drift check. The warning is for the model, so it goes
  // out as additionalContext — `systemMessage` is shown to the user only.
  let thrashingWarning = null;
  if (config.supervision && transcriptPath) {
    try {
      const { warning } = await checkGoalDriftAndThrashing({ transcriptPath, transcriptSnapshot, latestRequest: task });
      if (warning) {
        thrashingWarning = warning;
        logDecision({ hook: "PreToolUse", thrashingWarning: true });
      }
    } catch {}
  }
  const contextNote = [verdict.advisory, thrashingWarning].filter(Boolean).join("\n\n");
  const withWarning = (hookSpecificOutput = {}) =>
    contextNote ? { ...hookSpecificOutput, additionalContext: contextNote } : hookSpecificOutput;
  const warningOnly = () =>
    contextNote
      ? emit({ hookSpecificOutput: { hookEventName: "PreToolUse", ...withWarning() } })
      : nothing();

  // Allowed. Now: is this a command whose output is going to be bloat?
  if (toolName !== "Bash") {
    logVerdict();
    return warningOnly();
  }

  const command = input?.command;
  const { wrap, why } = shouldWrap(command);
  if (!wrap) {
    logVerdict({ tool: "Bash", wrapped: false, reason: why });
    return warningOnly();
  }

  const updated = rewrite(command, task, { key: event.session_id });
  logVerdict({ tool: "Bash", wrapped: true, matched: why, command: command.slice(0, 200) });

  return emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      ...withWarning({ updatedInput: { ...input, command: updated } }),
    },
    systemMessage: `jev: routing ${why} output through the slimmer`,
  });
}

// ── PostToolUseFailure ───────────────────────────────────────────────
//
// PostToolUse fires only after a tool succeeds and carries no error; the
// failures this triage exists for arrive as PostToolUseFailure with `error`.

async function postToolUseFailure(event) {
  if (typeof event.error === "string" && event.error && !event.is_interrupt) {
    try {
      await triageToolError({
        toolName: event.tool_name,
        input: event.tool_input,
        error: event.error,
        agent: "claude",
      });
    } catch {}
  }
  return nothing();
}

// ── PreCompact ───────────────────────────────────────────────────────

async function preCompact(event) {
  const started = Date.now();
  const result = await buildBrief({
    transcriptPath: event.transcript_path,
    sessionId: event.session_id,
  });
  logDecision({ hook: "PreCompact", trigger: event.trigger, ...result, ms: Date.now() - started });
  // Compaction always proceeds; this hook exists to prepare for it, not to veto it.
  return nothing();
}

// ── SessionStart ─────────────────────────────────────────────────────

function sessionStart(event) {
  if (event.source !== "compact") return nothing();
  const brief = consumeBrief(event.session_id);
  if (!brief) return nothing();

  logDecision({ hook: "SessionStart", source: event.source, injected_chars: brief.length });
  return emit({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: brief,
    },
  });
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
    case "PostToolUseFailure":
      return await postToolUseFailure(event);
    case "PreCompact":
      return await preCompact(event);
    case "SessionStart":
      return sessionStart(event);
    default:
      return nothing();
  }
}

// A hook that throws is a hook that breaks someone's session.
main().catch((err) => {
  try {
    logDecision({ hook: "error", message: String(err?.message ?? err) });
  } catch {}
  process.exit(0);
});
