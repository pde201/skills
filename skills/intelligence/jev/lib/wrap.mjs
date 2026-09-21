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
import config from "./config.mjs";

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

export function rewrite(command, task) {
  const taskArg = task ? ` --task-b64 ${shellQuote(Buffer.from(task, "utf8").toString("base64"))}` : "";
  return `node ${shellQuote(SLIM_BIN)} exec${taskArg} -- ${shellQuote(command)}`;
}
