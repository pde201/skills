import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { shouldWrap } from "../lib/wrap.mjs";

const BIN = new URL("../bin/jev-slim.mjs", import.meta.url).pathname;
const ANTIGRAVITY_HOOK = new URL("../bin/jev-hook-antigravity.mjs", import.meta.url).pathname;
const OUTPUT_EVAL = new URL("../evals/output-path.mjs", import.meta.url).pathname;

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "jev-output-path-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = {
    ...process.env,
    JEV_STATE_DIR: dir,
    JEV_LOG: join(dir, "decisions.jsonl"),
    JEV_HOOKS_SLIM: "1",
    JEV_SLIM_FAILURES: "0",
  };
  delete env.TYPESAFE_API_KEY;
  return { dir, env };
}

test("bounded metadata avoids a wrapper, while compound and high-output commands retain it", () => {
  for (const command of [
    "kubectl config current-context",
    "kubectl config get-contexts",
    "aws sts get-caller-identity --output json",
    "aws configure list-profiles",
  ]) {
    assert.deepEqual(shouldWrap(command), { wrap: false, why: "bounded inspection output" }, command);
  }
  for (const command of [
    "kubectl get pods -A",
    "aws ssm get-command-invocation --command-id 123",
    "kubectl config current-context && mvn test",
  ]) {
    assert.equal(shouldWrap(command).wrap, true, command);
  }
});

test("a final head below the line threshold bypasses the wrapper", () => {
  for (const command of [
    "kubectl get pods | head -n 20",
  ]) {
    assert.deepEqual(shouldWrap(command), { wrap: false, why: "stdout capped below slimming threshold" }, command);
  }
  assert.equal(shouldWrap("aws s3 ls s3://example | tail -n 10").wrap, false);
  for (const command of [
    "kubectl get pods",
    "kubectl get pods | head -n 59",
    "kubectl get pods | head -n 20 && mvn test",
    "kubectl get pods | head -n 20; mvn test",
    "kubectl get pods | head -n 20 > out.txt",
    "kubectl get pods || mvn test | head -n 20",
    "mvn test 'literal | head -n 20'",
  ]) {
    assert.equal(shouldWrap(command).wrap, true, command);
  }
});

test("credential-bearing output stays out of remote slimming", () => {
  for (const command of [
    "aws secretsmanager get-secret-value --secret-id example",
    "aws --profile demo secretsmanager get-secret-value --secret-id example",
    "aws secretsmanager batch-get-secret-value --secret-id-list example",
    "aws ssm get-parameter --name example --with-decryption",
    "aws ssm get-parameters-by-path --path example --with-decryption",
    "aws ecr get-login-password",
    "aws sts assume-role --role-arn example --role-session-name demo",
    "kubectl config view --raw",
    "kubectl --context demo get secret/example",
    "kubectl describe secret example",
    "gcloud secrets versions access latest --secret example",
    "gcloud auth print-access-token",
    "kubectl get pods && aws secretsmanager get-secret-value --secret-id example",
  ]) {
    assert.deepEqual(shouldWrap(command), { wrap: false, why: "may print credentials" }, command);
  }
});

test("an unwrapped Antigravity inspection leaves host permissions in charge", (t) => {
  const { env } = fixture(t);
  env.JEV_ANTIGRAVITY_EXPLICIT_ALLOW = "0";
  const event = {
    toolCall: { name: "run_command", args: { CommandLine: "aws sts get-caller-identity", Cwd: process.cwd() } },
    workspacePaths: [process.cwd()],
    conversationId: "bounded-inspection",
  };
  const result = spawnSync(process.execPath, [ANTIGRAVITY_HOOK], { env, input: JSON.stringify(event) });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.toString(), "", "Jev must not grant permission when it skips wrapping");
});

test("the default failure path preserves bytes, stderr, exit code, and records full-path timing", (t) => {
  const { env } = fixture(t);
  const command = "printf 'plain\\n'; printf 'diagnostic\\n' >&2; exit 7";
  const result = spawnSync(process.execPath, [BIN, "exec", "--", command], { env });
  assert.equal(result.status, 7);
  assert.equal(result.stdout.toString(), "plain\n");
  assert.equal(result.stderr.toString(), "diagnostic\n");

  const record = JSON.parse(readFileSync(env.JEV_LOG, "utf8").trim());
  assert.equal(record.exit_code, 7);
  assert.equal(record.changed, false);
  assert.equal(record.stdout_bytes, 6);
  assert.equal(record.stderr_bytes, 11);
  assert.ok(record.wrapper_ms >= record.command_ms);
  assert.ok(record.wrapper_ms >= record.ms);
  assert.equal(record.command, undefined, "failure metrics do not persist the command");
});

test("stderr is visible before a long-running child finishes", async (t) => {
  const { env } = fixture(t);
  const child = spawn(process.execPath, [BIN, "exec", "--", "printf 'early\\n' >&2; sleep 0.35; printf 'late\\n'"], { env });
  const out = [];
  child.stdout.on("data", (chunk) => out.push(chunk));
  const firstStderr = await new Promise((resolve, reject) => {
    child.stderr.once("data", resolve);
    child.once("error", reject);
    child.once("close", () => reject(new Error("child finished before stderr arrived")));
  });
  assert.equal(firstStderr.toString(), "early\n");
  assert.equal(child.exitCode, null, "stderr arrived while the command was still running");
  const code = await new Promise((resolve) => child.once("close", resolve));
  assert.equal(code, 0);
  assert.equal(Buffer.concat(out).toString(), "late\n");
});

test("opt-in failure summary keeps exact diagnostics and a private full copy", (t) => {
  const { dir, env } = fixture(t);
  env.JEV_SLIM_FAILURES = "1";
  const script = join(dir, "failed-test.cjs");
  const lines = Array.from({ length: 240 }, (_, i) => i === 110 ? "AssertionError: expected 2 but got 3" : `routine progress ${i}`);
  writeFileSync(script, `process.stdout.write(${JSON.stringify(lines.join("\n"))}); process.exit(7);`);

  const result = spawnSync(process.execPath, [BIN, "exec", "--", `${process.execPath} '${script}'`], { env });
  assert.equal(result.status, 7);
  const output = result.stdout.toString();
  assert.match(output, /AssertionError: expected 2 but got 3/);
  assert.ok(output.split("\n").length < lines.length / 2);
  const fullPath = output.match(/full stdout: ([^\]]+)\]/)?.[1];
  assert.ok(fullPath);
  t.after(() => rmSync(dirname(fullPath), { recursive: true, force: true }));
  assert.equal(readFileSync(fullPath, "utf8"), lines.join("\n"));
  assert.equal(statSync(fullPath).mode & 0o777, 0o600);
  const record = JSON.parse(readFileSync(env.JEV_LOG, "utf8").trim());
  assert.equal(record.changed, true);
  assert.equal(record.exit_code, 7);
});

test("opt-in failure summary leaves unrecognised diagnostics whole", (t) => {
  const { dir, env } = fixture(t);
  env.JEV_SLIM_FAILURES = "1";
  const script = join(dir, "unknown-failure.cjs");
  const output = Array.from({ length: 200 }, (_, i) => `opaque line ${i}`).join("\n");
  writeFileSync(script, `process.stdout.write(${JSON.stringify(output)}); process.exit(9);`);
  const result = spawnSync(process.execPath, [BIN, "exec", "--", `${process.execPath} '${script}'`], { env });
  assert.equal(result.status, 9);
  assert.equal(result.stdout.toString(), output);
});

test("opt-in failure summary preserves non-UTF-8 stdout byte for byte", (t) => {
  const { dir, env } = fixture(t);
  env.JEV_SLIM_FAILURES = "1";
  const script = join(dir, "binary-failure.cjs");
  const payload = Buffer.concat([
    Buffer.from("AssertionError: first line\n" + "routine progress\n".repeat(200)),
    Buffer.from([0xff, 0xfe]),
  ]);
  writeFileSync(script, `process.stdout.write(Buffer.from('${payload.toString("base64")}', 'base64')); process.exit(6);`);
  const result = spawnSync(process.execPath, [BIN, "exec", "--", `${process.execPath} '${script}'`], { env });
  assert.equal(result.status, 6);
  assert.deepEqual(result.stdout, payload);
  const record = JSON.parse(readFileSync(env.JEV_LOG, "utf8").trim());
  assert.equal(record.changed, false);
  assert.equal(record.reason, "non-UTF-8 stdout preserved");
});

test("output-path replay reports skip coverage without exposing command text", (t) => {
  const { dir, env } = fixture(t);
  const log = join(dir, "replay.jsonl");
  writeFileSync(log, [
    { at: "2026-09-21T00:00:00Z", hook: "jev-slim", command: "aws sts get-caller-identity", changed: false },
    { at: "2026-09-22T00:00:00Z", hook: "jev-slim", command: "mvn test", changed: true },
    { at: "2026-09-22T00:00:00Z", hook: "jev-slim", command: "kubectl config view --raw", changed: false },
  ].map((row) => JSON.stringify(row)).join("\n"));

  const result = spawnSync(process.execPath, [OUTPUT_EVAL, "--log", log], { env });
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout.toString());
  assert.equal(report.candidateSkips, 2);
  assert.equal(report.missedTrims, 0);
  assert.doesNotMatch(result.stdout.toString(), /get-caller-identity|config view|mvn test/);

  const later = spawnSync(process.execPath, [OUTPUT_EVAL, "--log", log, "--since", "2026-09-22"], { env });
  assert.equal(JSON.parse(later.stdout.toString()).candidateSkips, 1);

  writeFileSync(log, JSON.stringify({ hook: "jev-slim", command: "aws sts get-caller-identity", changed: true }));
  const missed = spawnSync(process.execPath, [OUTPUT_EVAL, "--log", log], { env });
  assert.equal(missed.status, 1);
  assert.equal(JSON.parse(missed.stdout.toString()).missedTrims, 1);
});
