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
import { latestUserRequest, recentToolCalls, observedPaths } from "../lib/transcript.mjs";
import { logDecision } from "../lib/log.mjs";
import config from "../lib/config.mjs";

const GUARDED_TOOLS = new Set(["Bash", "Edit", "Write", "NotebookEdit", "Read"]);

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
  const task = latestUserRequest(transcriptPath);
  const started = Date.now();

  // Git safety check on commits and pushes
  if (config.gitSafety && toolName === "Bash" && typeof input?.command === "string") {
    const gitCheck = checkGitSafety({ command: input.command, cwd });
    if (gitCheck) {
      logDecision({ hook: "PreToolUse", tool: "Bash", gitSafety: true, ...gitCheck });
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
      recentCalls: recentToolCalls(transcriptPath),
      observed: observedPaths(transcriptPath),
    });
  }

  logDecision({
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

  // Thrashing and goal drift check
  let thrashingWarning = null;
  if (config.supervision && transcriptPath) {
    try {
      const { warning } = await checkGoalDriftAndThrashing({ transcriptPath, latestRequest: task });
      if (warning) {
        thrashingWarning = warning;
        logDecision({ hook: "PreToolUse", thrashingWarning: true });
      }
    } catch {}
  }

  // Allowed. Now: is this a command whose output is going to be bloat?
  if (toolName !== "Bash") {
    return thrashingWarning ? emit({ systemMessage: thrashingWarning }) : nothing();
  }

  const command = input?.command;
  const { wrap, why } = shouldWrap(command);
  if (!wrap) {
    logDecision({ hook: "PreToolUse", tool: "Bash", wrapped: false, reason: why });
    return thrashingWarning ? emit({ systemMessage: thrashingWarning }) : nothing();
  }

  const updated = rewrite(command, task);
  logDecision({ hook: "PreToolUse", tool: "Bash", wrapped: true, matched: why, command: command.slice(0, 200) });

  const msg = [thrashingWarning, `jev: routing ${why} output through the slimmer`].filter(Boolean).join("\n");
  return emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: { ...input, command: updated },
    },
    systemMessage: msg,
  });
}

// ── PostToolUse ──────────────────────────────────────────────────────

async function postToolUse(event) {
  if (event.error || event.tool_result?.is_error) {
    try {
      await triageToolError({
        toolName: event.tool_name,
        input: event.tool_input,
        error: event.error || event.tool_result?.content,
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
