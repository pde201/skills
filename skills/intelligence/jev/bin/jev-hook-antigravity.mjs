#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────────────
//  jev-hook-antigravity — the Antigravity adapter for the Jev layer.
//
//  Antigravity exposes PreToolUse, PostToolUse, PreInvocation,
//  PostInvocation and Stop. Only one of those is a place where a decision
//  layer has something to say, so only one is handled here.
//
//  What Antigravity supports, and what it does not:
//
//    · Guarding — yes, fully. PreToolUse takes a `decision` of allow,
//      deny or ask, which is exactly the vocabulary lib/guard.mjs speaks.
//
//    · Slimming — no. PreToolUse can block a call but cannot rewrite its
//      arguments, and PostToolUse cannot touch the result. There is no
//      mechanism to wrap a command, so this adapter does not pretend to
//      have one. `jev-slim` still works as a plain CLI, and README.md
//      carries a rules snippet that gets the agent to reach for it.
//
//    · Carrying a brief across compaction — no. Antigravity fires no
//      event around context compaction, so there is nothing to hang the
//      brief on. PreInvocation fires before *every* model call and knows
//      nothing about compaction, which would mean injecting the same
//      brief forever rather than once.
//
//  Docs: https://antigravity.google/docs/hooks/
//
//  Fails open, always exit 0, same as every other entry point here.
// ──────────────────────────────────────────────────────────────────────

import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { guard, ALLOW, ASK, DENY } from "../lib/guard.mjs";
import { latestUserRequest, recentToolCalls, observedPaths } from "../lib/transcript.mjs";
import { logDecision } from "../lib/log.mjs";
import config from "../lib/config.mjs";

// Saying `{"decision":"allow"}` on a call that tripped nothing would
// grant permission the user never gave, so the allow path stays silent
// and lets Antigravity's own permission rules decide. Set this if a build
// turns out to require an explicit verdict on every call.
const EXPLICIT_ALLOW = /^(1|true|yes|on)$/i.test(process.env.JEV_ANTIGRAVITY_EXPLICIT_ALLOW ?? "");

// Antigravity's tool names are its own. Only the mappings that are safe
// to assert are made; anything else is handed to the judgment layer with
// its name and arguments untouched, which needs no mapping to work.
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
 * Returning the Antigravity name unchanged is a real answer, not a
 * fallback: the hazard questions ask about "the tool call in `call`" and
 * read whatever shape they are given. Only the deterministic checks need
 * a known name, and claiming one we are not sure of would run a file
 * existence check against a key that might mean something else.
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
    // Only an absolute path is safe to check for existence. A relative one
    // would be resolved against this process's cwd, which is not
    // necessarily the workspace, and a wrong answer here is a denied read.
    if (key && isAbsolute(args[key])) {
      return { toolName: "Read", input: { file_path: args[key] } };
    }
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

  const verdict = await guard({
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

  return EXPLICIT_ALLOW ? emit({ decision: "allow" }) : nothing();
}

// ── Dispatch ─────────────────────────────────────────────────────────

async function main() {
  if (!config.enabled) return nothing();
  if (!config.guard) return nothing();

  let event;
  try {
    event = await readStdin();
  } catch {
    return nothing();
  }

  // Antigravity does not name the event in its payload the way Claude Code
  // and Codex do, so the presence of a tool call is what identifies a call
  // worth judging. The installer registers this for PreToolUse only; the two
  // checks below are belt and braces for a payload that arrives some other
  // way, since a PostToolUse carries a tool call too and a verdict there
  // would be meaningless.
  if (!event.toolCall || event.error !== undefined) return nothing();

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
