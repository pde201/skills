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

import { judge, readStdin, emit, nothing, ASK, DENY } from "../lib/hook-core.mjs";
import { shouldWrap, rewrite } from "../lib/wrap.mjs";
import { slim } from "../lib/slim.mjs";
import { haveKey } from "../lib/client.mjs";
import { buildBrief, consumeBrief } from "../lib/carryforward.mjs";
import {
  checkGoalDriftAndThrashing,
  triageToolError,
} from "../lib/supervision.mjs";
import { createTranscriptSnapshot, transcriptContext } from "../lib/transcript.mjs";
import { logDecision } from "../lib/log.mjs";
import { createHash } from "node:crypto";
import config from "../lib/config.mjs";

const GUARDED_TOOLS = new Set(["Bash", "Edit", "Write", "NotebookEdit", "Read"]);
// Installed explicitly by `JEV_CLAUDE_POST_SLIM=1 ./install.sh claude`.
// The pilot covers Maven only; other commands retain the wrapper. This keeps
// the extra PostToolUse process off the path of unrelated Bash calls.
const POST_SLIM = process.argv.includes("--post-slim");

/** One line naming what a call did: a command's head, or the file it targets. */
function callSummary(toolName, input) {
  if (typeof input?.command === "string") return input.command.replace(/\s+/g, " ").trim().slice(0, 160);
  const path = input?.file_path ?? input?.notebook_path;
  return typeof path === "string" ? path : undefined;
}

// ── PreToolUse ───────────────────────────────────────────────────────

async function preToolUse(event) {
  const { tool_name: toolName, tool_input: input, cwd, transcript_path: transcriptPath } = event;
  const hookStarted = Date.now();
  const transcript = transcriptContext(createTranscriptSnapshot(transcriptPath));
  const { snapshot: transcriptSnapshot, task } = transcript;

  const verdict = await judge({
    toolName,
    input,
    cwd,
    command: toolName === "Bash" ? input?.command : undefined,
    guarded: GUARDED_TOOLS.has(toolName),
    transcript,
    hookStarted,
    // Enough to tie a decision back to its call and the request in force,
    // without a transcript: the log is otherwise unauditable after the fact.
    logFields: {
      session_id: event.session_id,
      cwd,
      call: callSummary(toolName, input),
      task_hash: task ? createHash("sha256").update(task).digest("hex").slice(0, 12) : undefined,
    },
  });
  const logVerdict = verdict.log;

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
    logVerdict({ tool: "Bash", wrapped: false, wrap_reason: why });
    return warningOnly();
  }

  if (POST_SLIM && why === "mvn") {
    logVerdict({ tool: "Bash", wrapped: false, postSlimCandidate: true, matched: why });
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

// ── PostToolUse (opt-in Claude Code output replacement) ─────────────

async function postToolUse(event) {
  if (!POST_SLIM || !config.slim || !haveKey() || event.tool_name !== "Bash") return nothing();
  const command = event.tool_input?.command;
  const response = event.tool_response;
  const candidate = shouldWrap(command);
  if (!candidate.wrap || candidate.why !== "mvn" || !response || typeof response !== "object" ||
      typeof response.stdout !== "string" || response.interrupted || response.isImage ||
      (typeof response.exitCode === "number" && response.exitCode !== 0)) return nothing();

  const output = response.stdout;
  // A host-truncated response is not a recoverable "full output". Leave it
  // unchanged; the command wrapper remains available for that workload.
  if (/\.\.\. \[\d+ characters truncated\] \.\.\./.test(output)) return nothing();
  if (output.split("\n").length < config.slimMinLines) return nothing();

  const started = Date.now();
  let result;
  try {
    const task = transcriptContext(createTranscriptSnapshot(event.transcript_path)).task;
    result = await slim(output, { task, command, minLines: config.slimMinLines, model: config.model });
  } catch {
    return nothing();
  }
  logDecision({
    hook: "PostToolUse",
    tool: "Bash",
    changed: result.changed,
    reason: result.reason,
    lines_in: output.split("\n").length,
    lines_out: result.text.split("\n").length,
    post_ms: Date.now() - started,
    cost_usd: result.cost,
  });
  if (!result.changed || result.text === output) return nothing();
  return emit({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      updatedToolOutput: { ...response, stdout: result.text },
    },
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
    case "PostToolUse":
      return await postToolUse(event);
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
