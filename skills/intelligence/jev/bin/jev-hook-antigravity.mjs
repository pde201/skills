#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────────────
//  jev-hook-antigravity — the Antigravity adapter for the Jev layer.
//
//  Antigravity exposes PreToolUse, PostToolUse, PreInvocation,
//  PostInvocation and Stop.
//
//  What Antigravity supports:
//
//    · Guarding — yes, fully. PreToolUse returns `decision` ("deny" or
//      "ask") with `reason`.
//
//    · Slimming — yes. PreToolUse supports argument rewriting via
//      `overwrite: { CommandLine: ... }`. Bloated commands (e.g. npm,
//      pytest, cargo, kubectl) are wrapped through `jev-slim exec`.
//
//    · Carrying a brief across compaction — yes. PreInvocation injects
//      context via `injectSteps: [ { ephemeralMessage: ... } ]`.
//
//  Fails open, always exit 0, same as every other entry point here.
// ──────────────────────────────────────────────────────────────────────

import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { guard, ALLOW, ASK, DENY } from "../lib/guard.mjs";
import { shouldWrap, rewrite } from "../lib/wrap.mjs";
import { consumeBrief } from "../lib/carryforward.mjs";
import { latestUserRequest, recentToolCalls, observedPaths } from "../lib/transcript.mjs";
import { logDecision } from "../lib/log.mjs";
import config from "../lib/config.mjs";

// Saying `{"decision":"allow"}` on a call that tripped nothing would
// grant permission the user never gave, so the allow path stays silent
// and lets Antigravity's own permission rules decide. Set this if a build
// turns out to require an explicit verdict on every call.
const EXPLICIT_ALLOW = /^(1|true|yes|on)$/i.test(process.env.JEV_ANTIGRAVITY_EXPLICIT_ALLOW ?? "");

// Antigravity native tool mappings.
const SHELL_TOOLS = new Set(["run_command"]);
const READ_TOOLS = new Set(["view_file", "read_file"]);
const PATH_KEYS = ["AbsolutePath", "Path", "FilePath", "TargetFile", "File"];

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

/**
 * Translate an Antigravity tool call into the shape lib/guard.mjs checks.
 *
 * @returns {{toolName: string, input: object}}
 */
export function translate(toolCall) {
  const name = toolCall?.name ?? "";
  const args = toolCall?.args ?? {};

  if (SHELL_TOOLS.has(name) && typeof args.CommandLine === "string") {
    return { toolName: "Bash", input: { command: args.CommandLine } };
  }

  if (READ_TOOLS.has(name)) {
    const key = PATH_KEYS.find((k) => typeof args[k] === "string" && args[k]);
    if (key && isAbsolute(args[key])) {
      return { toolName: "Read", input: { file_path: args[key] } };
    }
  }

  if ((name === "replace_file_content" || name === "edit_file") && typeof args.TargetFile === "string") {
    return {
      toolName: "Edit",
      input: {
        file_path: args.TargetFile,
        old_string: args.TargetContent,
        new_string: args.ReplacementContent,
        allow_multiple: args.AllowMultiple,
      },
    };
  }

  if ((name === "write_to_file" || name === "create_file") && typeof args.TargetFile === "string") {
    return {
      toolName: "Write",
      input: {
        file_path: args.TargetFile,
        content: args.CodeContent,
        overwrite: args.Overwrite,
      },
    };
  }

  return { toolName: name, input: args };
}

// ── PreToolUse ───────────────────────────────────────────────────────

async function preToolUse(event) {
  const { toolCall, workspacePaths, transcriptPath } = event;
  const { toolName, input } = translate(toolCall);
  const cwd = toolCall?.args?.Cwd || workspacePaths?.[0] || process.cwd();
  const task = latestUserRequest(transcriptPath);
  const started = Date.now();

  let verdict = { decision: ALLOW, reason: "not guarded", by: "code" };
  if (config.guard) {
    verdict = await guard({
      toolName,
      input,
      cwd,
      task,
      recentCalls: recentToolCalls(transcriptPath),
      observed: observedPaths(transcriptPath),
    });

    logDecision({
      agent: "antigravity",
      hook: "PreToolUse",
      tool: toolCall?.name,
      mapped_to: toolName,
      decision: verdict.decision,
      by: verdict.by,
      reason: verdict.reason,
      signals: verdict.signals,
      probabilities: verdict.probabilities,
      ms: Date.now() - started,
      cost_usd: verdict.cost,
    });

    if (verdict.decision === DENY) return emit({ decision: "deny", reason: verdict.reason });
    if (verdict.decision === ASK) return emit({ decision: "ask", reason: verdict.reason });
  }

  // Allowed. Check if this is a command whose output is going to be bloat.
  if (config.slim && toolCall?.name === "run_command" && typeof toolCall?.args?.CommandLine === "string") {
    const command = toolCall.args.CommandLine;
    const { wrap, why } = shouldWrap(command);
    if (wrap) {
      const updated = rewrite(command, task);
      logDecision({
        agent: "antigravity",
        hook: "PreToolUse",
        tool: "run_command",
        wrapped: true,
        matched: why,
        command: command.slice(0, 200),
      });
      return EXPLICIT_ALLOW
        ? emit({ decision: "allow", overwrite: { CommandLine: updated } })
        : emit({ overwrite: { CommandLine: updated } });
    }
  }

  return EXPLICIT_ALLOW ? emit({ decision: "allow" }) : nothing();
}

// ── PreInvocation ────────────────────────────────────────────────────

async function preInvocation(event) {
  if (!config.carryForward) return nothing();
  const conversationId = event.conversationId || event.session_id || "unknown";
  const brief = consumeBrief(conversationId);
  if (brief) {
    logDecision({ agent: "antigravity", hook: "PreInvocation", injected: true, conversationId });
    return emit({
      injectSteps: [
        {
          ephemeralMessage: `[Jev carry-forward brief]\n${brief}`,
        },
      ],
    });
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

  // PreInvocation: fires before model calls, receives invocationNum/initialNumSteps
  if (event.invocationNum !== undefined || event.initialNumSteps !== undefined) {
    return await preInvocation(event);
  }

  if (!event.toolCall || event.error !== undefined) return nothing();
  if (!config.guard && !config.slim) return nothing();

  return await preToolUse(event);
}

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
      logDecision({ agent: "antigravity", hook: "error", message: String(err?.message ?? err) });
    } catch {}
    process.exit(0);
  });
}
