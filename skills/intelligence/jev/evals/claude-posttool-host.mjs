#!/usr/bin/env node
// Opt-in live Claude Code host smoke test. The task and Jev provider response
// are synthetic; Claude Code itself still makes a model call.

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

if (process.argv[2] !== "--run") {
  process.stdout.write("Usage: node evals/claude-posttool-host.mjs --run\nMakes one paid Claude Code model call with a synthetic command and a local mock Jev provider.\n");
  process.exit(0);
}

const hook = new URL("../bin/jev-hook.mjs", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "jev-claude-posttool-"));
const project = join(dir, "project");
const temp = join(dir, "tmp");
const bin = join(dir, "bin");
mkdirSync(project);
mkdirSync(temp);
mkdirSync(bin);
const executions = join(dir, "command-executions.txt");
const fakeMaven = join(bin, "mvn");
writeFileSync(fakeMaven, `#!/usr/bin/env node\nconst fs = require("node:fs");\nfs.appendFileSync(${JSON.stringify(executions)}, "ran\\n");\nfor (let i = 0; i < 120; i++) console.log("synthetic line " + i);\n`);
chmodSync(fakeMaven, 0o700);

const responseFor = (body) => {
  const answers = {};
  for (const [name, question] of Object.entries(body.questions ?? {})) {
    if (question.type === "noul") {
      answers[name] = { type: "noul", noul: 0 };
    } else if (question.type === "score") {
      const levels = question.criteria;
      answers[name] = { type: "score", score: 0,
        legend: Object.fromEntries(levels.map((level, i) => [String(i), level])),
        probabilities: Object.fromEntries(levels.map((_, i) => [String(i), i === 0 ? 1 : 0])),
        confidence: 1 };
    } else if (question.type === "choice") {
      const options = Object.keys(question.criteria);
      const chosen = name === "shape" ? "test_results" : options[Math.floor(options.length / 2)];
      answers[name] = { type: "choice", choice: chosen,
        probabilities: Object.fromEntries(options.map((option) => [option, option === chosen ? 1 : 0])),
        confidence: 1 };
    }
  }
  return { model: "jev-host-smoke", answers, usage: { input_tokens: 1, output_tokens: 1 } };
};

let providerRequests = 0;
const server = createServer(async (req, res) => {
  providerRequests++;
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(responseFor(JSON.parse(raw))));
  } catch {
    res.writeHead(400);
    res.end();
  }
});

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const settings = join(dir, "settings.json");
  writeFileSync(settings, JSON.stringify({
    hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: hook,
      args: ["--post-slim"], if: "Bash(mvn *)", timeout: 15 }] }] },
  }));
  const env = { ...process.env, TMPDIR: temp, PATH: `${bin}:${process.env.PATH ?? ""}`,
    JEV_STATE_DIR: join(dir, "state"), JEV_LOG: join(dir, "jev-log.jsonl"),
    TYPESAFE_API_KEY: "synthetic-host-smoke-key", JEV_RETRIES: "0",
    TYPESAFE_BASE_URL: `http://127.0.0.1:${server.address().port}` };
  const command = "mvn test";
  const prompt = `Run this exact Bash command once, then stop: ${command}. Do not modify files or run other commands.`;
  const args = ["-p", prompt, "--model", "haiku", "--max-turns", "2", "--max-budget-usd", "1",
    "--no-session-persistence", "--setting-sources", "project", "--settings", settings,
    "--tools", "Bash", "--allowedTools", "Bash(mvn *)", "--permission-prompts", "none",
    "--output-format", "stream-json", "--verbose"];
  const started = performance.now();
  const child = spawn("claude", args, { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderrBytes = 0;
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 120_000);
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  clearTimeout(timeout);
  const events = stdout.split("\n").flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const toolResults = events.flatMap((event) => event.type === "user" && Array.isArray(event.message?.content)
    ? event.message.content.filter((part) => part.type === "tool_result") : []);
  const resultText = toolResults.map((part) => typeof part.content === "string" ? part.content : JSON.stringify(part.content)).join("\n");
  const log = (() => { try { return readFileSync(env.JEV_LOG, "utf8"); } catch { return ""; } })();
  const decisions = log.split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const changed = decisions.some((row) => row.hook === "PostToolUse" && row.changed === true);
  const commandExecutions = (() => { try { return readFileSync(executions, "utf8").trim().split("\n").length; } catch { return 0; } })();
  const report = {
    source: "live-claude-host-synthetic-task-local-jev-mock",
    hostVersion: (spawnSync("claude", ["--version"], { encoding: "utf8" }).stdout ?? "").trim(),
    platform: process.platform,
    settingsSources: "temporary project only",
    claudeExitCode: exitCode,
    wallMs: Math.round(performance.now() - started),
    providerRequests,
    commandExecutions,
    hookChanged: changed,
    toolResults: toolResults.length,
    modelVisibleFooter: resultText.includes("[jev:"),
    originalLastLineVisible: resultText.includes("synthetic line 119"),
    stderrBytes,
  };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (exitCode !== 0 || !changed || !report.modelVisibleFooter || toolResults.length !== 1 || commandExecutions !== 1) process.exitCode = 1;
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}
