import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SHAPES } from "../lib/slim.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const HOOK = join(ROOT, "bin/jev-hook.mjs");
const INSTALL = join(ROOT, "install.sh");

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "jev-posttool-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, HOME: dir, JEV_STATE_DIR: join(dir, "state"),
    JEV_LOG: join(dir, "log.jsonl"), JEV_RETRIES: "0", JEV_HOOKS_SLIM: "1" };
  delete env.TYPESAFE_API_KEY;
  return { dir, env };
}

function invoke(event, env, pilot = true) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK, ...(pilot ? ["--post-slim"] : [])], { env });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }));
    child.stdin.end(JSON.stringify(event));
  });
}

test("the Claude pilot preserves the command and does not approve it", async (t) => {
  const { env } = fixture(t);
  const event = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "mvn test" } };
  const pilot = await invoke(event, env);
  assert.equal(pilot.code, 0);
  assert.equal(pilot.stdout, "", "no command rewrite or permission grant");
  const defaultMode = await invoke(event, env, false);
  assert.match(JSON.parse(defaultMode.stdout).hookSpecificOutput.updatedInput.command, /jev-slim\.mjs/);
  const other = await invoke({ ...event, tool_input: { command: "npm test" } }, env);
  assert.match(JSON.parse(other.stdout).hookSpecificOutput.updatedInput.command, /jev-slim\.mjs/);
  const noKey = await invoke({ ...event, hook_event_name: "PostToolUse",
    tool_response: { stdout: "line\n".repeat(120), stderr: "", interrupted: false, isImage: false } }, env);
  assert.equal(noKey.stdout, "", "missing provider key leaves output intact");
});

test("the Claude pilot replaces only successful long stdout and keeps its full copy", async (t) => {
  const { env } = fixture(t);
  const ids = Array.from({ length: 120 }, (_, i) => `B${String(i).padStart(3, "0")}`);
  const weights = (selected) => Object.fromEntries(ids.map((id) => [id, id === selected ? 1 : 0]));
  const answer = {
    model: "jev-test",
    answers: {
      shape: { type: "choice", choice: "test_results", probabilities: Object.fromEntries(Object.keys(SHAPES).map((key) => [key, key === "test_results" ? 1 : 0])), confidence: 1 },
      failed: { type: "noul", noul: 0 },
      actionable: { type: "noul", noul: 0 },
      detail_needed: { type: "score", score: 0, legend: { "0": "short", "1": "some", "2": "diagnostic", "3": "full" }, probabilities: { "0": 1, "1": 0, "2": 0, "3": 0 }, confidence: 1 },
      relevance: { type: "choice", choice: "B060", probabilities: weights("B060"), confidence: 1 },
      second_relevance: { type: "choice", choice: "B070", probabilities: weights("B070"), confidence: 1 },
    },
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(answer));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  env.TYPESAFE_API_KEY = "synthetic-test-key";
  env.TYPESAFE_BASE_URL = `http://127.0.0.1:${server.address().port}`;

  const original = Array.from({ length: 120 }, (_, i) => `routine test line ${i}`).join("\n");
  const response = { stdout: original, stderr: "warning stays intact", interrupted: false, isImage: false };
  const event = { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "mvn test" }, tool_response: response };
  const result = await invoke(event, env);
  assert.equal(result.code, 0, result.stderr);
  const updated = JSON.parse(result.stdout).hookSpecificOutput.updatedToolOutput;
  assert.equal(updated.stderr, response.stderr);
  assert.equal(updated.interrupted, false);
  assert.equal(updated.isImage, false);
  assert.ok(updated.stdout.length < original.length / 2);
  const fullPath = updated.stdout.match(/Full output: ([^\]]+)\]/)?.[1];
  assert.ok(fullPath);
  t.after(() => rmSync(dirname(fullPath), { recursive: true, force: true }));
  assert.equal(readFileSync(fullPath, "utf8"), original);
  assert.equal(statSync(fullPath).mode & 0o777, 0o600);
  assert.equal(requests, 1);

  for (const changed of [
    { ...event, tool_response: { ...response, stdout: "one line" } },
    { ...event, tool_response: { ...response, interrupted: true } },
    { ...event, tool_response: { ...response, exitCode: 1 } },
    { ...event, tool_input: { command: "aws secretsmanager get-secret-value --secret-id example" } },
    { ...event, tool_input: { command: "npm test" } },
    { ...event, tool_response: { ...response, stdout: `${original}\n... [10 characters truncated] ...` } },
  ]) {
    assert.equal((await invoke(changed, env)).stdout, "");
  }
  assert.equal(requests, 1, "excluded results must not call the provider");
  assert.equal((await invoke(event, env, false)).stdout, "", "the old adapter ignores PostToolUse");
});

test("Claude installation registers the pilot only when explicitly selected", (t) => {
  const { dir, env } = fixture(t);
  const settings = join(dir, "settings.json");
  writeFileSync(settings, "{}");
  env.CLAUDE_SETTINGS = settings;
  const run = (pilot) => {
    const installEnv = { ...env, JEV_CLAUDE_POST_SLIM: pilot ? "1" : "0" };
    const result = spawnSync("bash", [INSTALL, "claude"], { env: installEnv });
    assert.equal(result.status, 0, result.stderr.toString());
    return JSON.parse(readFileSync(settings, "utf8"));
  };
  const pilot = run(true);
  assert.equal(pilot.hooks.PostToolUse[0].matcher, "Bash");
  assert.equal(pilot.hooks.PostToolUse[0].hooks[0].if, "Bash(mvn *)");
  assert.match(pilot.hooks.PreToolUse.at(-1).hooks[0].command, /--post-slim$/);
  assert.match(pilot.hooks.PostToolUse[0].hooks[0].command, /jev-hook\.mjs$/);
  assert.deepEqual(pilot.hooks.PostToolUse[0].hooks[0].args, ["--post-slim"]);
  const standard = run(false);
  assert.equal(standard.hooks.PostToolUse, undefined);
  assert.doesNotMatch(standard.hooks.PreToolUse.at(-1).hooks[0].command, /--post-slim/);
});
