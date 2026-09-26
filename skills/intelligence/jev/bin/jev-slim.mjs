#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────────────
//  jev-slim — run a command and print a slimmer version of its output.
//
//    jev-slim exec [--task-file PATH | --task-b64 B64 | --task TEXT] -- '<command>'
//    jev-slim filter [--task TEXT] [--cmd TEXT] < output
//
//  Usable on its own in any shell or any agent that can wrap a command,
//  which is the point: Claude Code hooks are one caller, not the only one.
//
//  Rules it will not break:
//    · a non-zero exit prints everything verbatim by default; the optional
//      local failure summary keeps a private full copy
//    · stderr is never slimmed
//    · the child's exit code is the exit code
//    · any failure inside this script prints the original output
// ──────────────────────────────────────────────────────────────────────

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { slim, summarizeFailedStdout } from "../lib/slim.mjs";
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
  // The hooks write the task to a private file and pass its path; a file
  // that has since been swept just means the task is unknown.
  const file = flag("--task-file");
  if (file) {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return "";
    }
  }
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
  const commandStarted = performance.now();
  const child = spawn(shell, ["-c", command], { stdio: ["inherit", "pipe", "pipe"] });

  // Collected as buffers and decoded once: appending chunks as strings
  // splits multi-byte characters at chunk boundaries and turns `─` into `��`.
  const outChunks = [];
  let stderrBytes = 0;
  child.stdout.on("data", (chunk) => outChunks.push(chunk));
  // stderr is never slimmed, so show it immediately. pipe handles backpressure
  // and does not close the host's stderr when the child ends.
  child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; });
  child.stderr.pipe(process.stderr, { end: false });

  const code = await new Promise((resolve) => {
    child.on("error", () => resolve(127));
    child.on("close", (c, signal) => resolve(signal ? 128 : (c ?? 0)));
  });
  const commandMs = performance.now() - commandStarted;

  const rawOut = Buffer.concat(outChunks);
  const out = rawOut.toString("utf8");
  const textRoundTrips = Buffer.from(out, "utf8").equals(rawOut);
  const slimStarted = performance.now();
  let result;
  if (!textRoundTrips) {
    result = { text: out, changed: false, reason: "non-UTF-8 stdout preserved" };
  } else if (code !== 0) {
    try {
      result = config.slimFailures
        ? summarizeFailedStdout(out, { minLines: config.slimMinLines })
        : { text: out, changed: false, reason: "nonzero exit: original stdout preserved" };
    } catch {
      result = { text: out, changed: false, reason: "failure summary error: original stdout preserved" };
    }
  } else {
    try {
      result = await slim(out, { task, command, minLines: config.slimMinLines, model: config.model });
    } catch {
      result = { text: out, changed: false, reason: "slimmer error: original stdout preserved" };
    }
  }
  const slimMs = performance.now() - slimStarted;

  // Preserve the original bytes for every unchanged result, including failed
  // commands. A summary is text and always links to its private full copy.
  process.stdout.write(result.changed ? result.text : rawOut);

  logDecision({
    hook: "jev-slim",
    ...(code === 0 ? { command: command.slice(0, 200) } : {}),
    changed: result.changed,
    reason: result.reason,
    lines_in: out.split("\n").length,
    lines_out: result.text.split("\n").length,
    stdout_bytes: rawOut.length,
    stdout_out_bytes: result.changed ? Buffer.byteLength(result.text) : rawOut.length,
    stderr_bytes: stderrBytes,
    exit_code: code,
    command_ms: Math.round(commandMs),
    ms: Math.round(slimMs),
    wrapper_ms: Math.round(performance.now()),
    cost_usd: result.cost,
  });

  process.exitCode = code;
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

  jev-slim exec [--task-file PATH | --task-b64 B64 | --task TEXT] -- '<command>'
  jev-slim filter [--task TEXT] [--cmd TEXT] < output

Environment:
  TYPESAFE_API_KEY      required; without it output passes through unchanged
  JEV_TASK              the task when no --task* flag is given
  JEV_HOOKS=0           disable entirely
  JEV_SLIM_MIN_LINES    output shorter than this is never touched (default 40)
  JEV_SLIM_FAILURES     opt-in local failed-stdout summary (default off)
  JEV_TIMEOUT_MS        per-request timeout (default 4000)
  JEV_BREAKER_FAILURES  consecutive provider failures before judgments are
                        skipped for JEV_BREAKER_COOLDOWN_MS (default 3 / 60000)
`;

if (mode === "exec") await runExec();
else if (mode === "filter") await runFilter();
else {
  process.stdout.write(usage);
  process.exit(mode ? 2 : 0);
}
