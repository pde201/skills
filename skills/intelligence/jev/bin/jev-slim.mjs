#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────────────
//  jev-slim — run a command and print a slimmer version of its output.
//
//    jev-slim exec [--task-b64 B64] -- '<command>'
//    jev-slim filter [--task TEXT] [--cmd TEXT] < output
//
//  Usable on its own in any shell or any agent that can wrap a command,
//  which is the point: Claude Code hooks are one caller, not the only one.
//
//  Rules it will not break:
//    · a non-zero exit prints everything, verbatim
//    · stderr is never slimmed
//    · the child's exit code is the exit code
//    · any failure inside this script prints the original output
// ──────────────────────────────────────────────────────────────────────

import { spawn } from "node:child_process";
import { slim } from "../lib/slim.mjs";
import config from "../lib/config.mjs";
import { logDecision } from "../lib/log.mjs";

const argv = process.argv.slice(2);
const mode = argv.shift();

function flag(name) {
  const i = argv.indexOf(name);
  if (i === -1 || i + 1 >= argv.length) return null;
  const value = argv[i + 1];
  argv.splice(i, 2);
  return value;
}

function rest() {
  const i = argv.indexOf("--");
  return i === -1 ? argv.join(" ") : argv.slice(i + 1).join(" ");
}

const decodeTask = () => {
  const b64 = flag("--task-b64");
  if (b64) {
    try {
      return Buffer.from(b64, "base64").toString("utf8");
    } catch {
      return "";
    }
  }
  return flag("--task") || process.env.JEV_TASK || "";
};

async function runExec() {
  const task = decodeTask();
  const command = rest();
  if (!command) {
    process.stderr.write("jev-slim: nothing to run\n");
    process.exit(2);
  }

  const shell = process.env.SHELL && /bash|zsh/.test(process.env.SHELL) ? process.env.SHELL : "/bin/bash";
  const child = spawn(shell, ["-c", command], { stdio: ["inherit", "pipe", "pipe"] });

  // Collected as buffers and decoded once: appending chunks as strings
  // splits multi-byte characters at chunk boundaries and turns `─` into `��`.
  const outChunks = [];
  const errChunks = [];
  child.stdout.on("data", (chunk) => outChunks.push(chunk));
  child.stderr.on("data", (chunk) => errChunks.push(chunk));

  const code = await new Promise((resolve) => {
    child.on("error", () => resolve(127));
    child.on("close", (c, signal) => resolve(signal ? 128 : (c ?? 0)));
  });

  const rawOut = Buffer.concat(outChunks);
  const rawErr = Buffer.concat(errChunks);

  // A command that failed is the one whose output you must not touch.
  if (code !== 0) {
    process.stdout.write(rawOut);
    if (rawErr.length) process.stderr.write(rawErr);
    process.exit(code);
  }

  const out = rawOut.toString("utf8");
  const err = rawErr.toString("utf8");

  const started = Date.now();
  let result;
  try {
    result = await slim(out, { task, command, minLines: config.slimMinLines, model: config.model });
  } catch (error) {
    process.stdout.write(out);
    if (err) process.stderr.write(err);
    process.exit(code);
  }

  logDecision({
    hook: "jev-slim",
    command: command.slice(0, 200),
    changed: result.changed,
    reason: result.reason,
    lines_in: out.split("\n").length,
    lines_out: result.text.split("\n").length,
    ms: Date.now() - started,
    cost_usd: result.cost,
  });

  process.stdout.write(result.text);
  if (err) process.stderr.write(err);
  process.exit(code);
}

async function runFilter() {
  const task = decodeTask();
  const command = flag("--cmd") || "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = Buffer.concat(chunks).toString("utf8");

  try {
    const result = await slim(input, { task, command, minLines: config.slimMinLines, model: config.model });
    process.stdout.write(result.text);
  } catch {
    process.stdout.write(input);
  }
}

const usage = `jev-slim — trim tool output down to what the task needs

  jev-slim exec [--task-b64 B64 | --task TEXT] -- '<command>'
  jev-slim filter [--task TEXT] [--cmd TEXT] < output

Environment:
  TYPESAFE_API_KEY      required; without it output passes through unchanged
  JEV_HOOKS=0           disable entirely
  JEV_SLIM_MIN_LINES    output shorter than this is never touched (default 60)
  JEV_TIMEOUT_MS        per-request timeout (default 4000)
`;

if (mode === "exec") await runExec();
else if (mode === "filter") await runFilter();
else {
  process.stdout.write(usage);
  process.exit(mode ? 2 : 0);
}
