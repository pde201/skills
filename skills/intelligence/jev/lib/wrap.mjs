// ──────────────────────────────────────────────────────────────────────
//  Decide whether a Bash command is worth routing through the slimmer,
//  and build the rewritten command if so.
//
//  This is pure code on purpose. Which binaries produce bloated output is
//  a fact about the world that does not need a model, and a wrong answer
//  here costs a wrapped interactive command — worth keeping boring.
// ──────────────────────────────────────────────────────────────────────

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import config from "./config.mjs";
import { stateDir } from "./log.mjs";
import { writePrivateFile } from "./privacy.mjs";

export const SLIM_BIN = join(dirname(dirname(fileURLToPath(import.meta.url))), "bin", "jev-slim.mjs");

/** POSIX single-quote: the only escaping that is safe for arbitrary text. */
export const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Markers that mean the command wants a terminal, streams, or runs forever.
const INTERACTIVE = [
  /(^|\s)-it(\s|$)/, /--interactive\b/, /(^|\s)--tty\b/,
  /\bless\b|\bmore\b/, /\|\s*(less|more|fzf|vipe)\b/,
  /(^|\s)-f(\s|$)/,            // tail -f, kubectl logs -f, docker logs -f
  /--follow\b/, /--watch\b/, /(^|\s)-w(\s|$)/,
  /&\s*$/,                      // backgrounded
];

const head = (command) => {
  // First real word, skipping env assignments and sudo.
  const tokens = command.trim().split(/\s+/);
  for (const token of tokens) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    if (token === "sudo" || token === "command" || token === "env") continue;
    return token.replace(/^.*\//, "");
  }
  return "";
};

/** Every binary the command invokes, not just the first — pipelines matter. */
const heads = (command) =>
  command
    .split(/\|\||&&|;|\|/)
    .map((segment) => head(segment))
    .filter(Boolean);

/**
 * @returns {{wrap: boolean, why: string}}
 */
export function shouldWrap(command) {
  if (!config.slim) return { wrap: false, why: "slim disabled" };
  if (typeof command !== "string" || !command.trim()) return { wrap: false, why: "empty" };
  if (command.includes("jev-slim")) return { wrap: false, why: "already wrapped" };

  const invoked = heads(command);
  if (!invoked.length) return { wrap: false, why: "no command found" };

  for (const binary of invoked) {
    if (config.neverWrap.includes(binary)) return { wrap: false, why: `${binary} is never wrapped` };
  }
  for (const pattern of INTERACTIVE) {
    if (pattern.test(command)) return { wrap: false, why: "streams or needs a terminal" };
  }
  // Heredocs carry their own stdin; re-quoting them through another layer
  // is not worth the risk for a bit less output.
  if (/<<-?\s*['"]?\w+/.test(command)) return { wrap: false, why: "contains a heredoc" };

  const match = invoked.find((binary) => config.slimCommands.includes(binary));
  if (!match) return { wrap: false, why: "not a known bloat source" };

  return { wrap: true, why: match };
}

// ── The task file ────────────────────────────────────────────────────
//
// The slimmer needs the user's request to judge relevance. Passing it
// inline as base64 put ~2 KB of opaque text into every rewritten command,
// which the host then shows and stores in its transcript — the layer
// meant to save context was spending it. So the task goes to a small
// private file, one per session, and the command carries only its path.

const TASK_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const taskId = (task, key) =>
  createHash("sha256").update(key ? `session:${key}` : `task:${task}`).digest("hex").slice(0, 32);

const taskPath = (task, key) => join(stateDir(), `task-${taskId(task, key)}.txt`);

function sweepTaskFiles(dir) {
  try {
    const now = Date.now();
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("task-") || !name.endsWith(".txt")) continue;
      const path = join(dir, name);
      try {
        if (now - statSync(path).mtimeMs > TASK_FILE_MAX_AGE_MS) unlinkSync(path);
      } catch { /* raced with another hook */ }
    }
  } catch { /* the sweep is housekeeping, never a failure */ }
}

/**
 * Write the task where jev-slim can read it and return the path. Keyed by
 * session when one is known, so a session overwrites one file as its
 * requests change; by content otherwise.
 */
export function stashTask(task, key) {
  const path = taskPath(task, key);
  try {
    if (readFileSync(path, "utf8") === task) return path;
  } catch { /* not written yet */ }
  writePrivateFile(path, task);
  sweepTaskFiles(dirname(path));
  return path;
}

/** Remove a session's task file, for hosts that announce session end. */
export function dropTask(key) {
  if (!key) return;
  try { unlinkSync(taskPath("", key)); } catch { /* nothing stashed */ }
}

/**
 * @param {string} command
 * @param {string} task      the latest user request, or ""
 * @param {{key?: string}} [opts]  session id, when the host provides one
 */
export function rewrite(command, task, { key } = {}) {
  let taskArg = "";
  if (task) {
    try {
      taskArg = ` --task-file ${shellQuote(stashTask(task, key))}`;
    } catch {
      // A state directory that cannot be written is not a reason to lose
      // the task; the inline form still works, it is just bulkier.
      taskArg = ` --task-b64 ${shellQuote(Buffer.from(task, "utf8").toString("base64"))}`;
    }
  }
  return `node ${shellQuote(SLIM_BIN)} exec${taskArg} -- ${shellQuote(command)}`;
}
