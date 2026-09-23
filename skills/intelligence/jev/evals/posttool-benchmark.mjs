#!/usr/bin/env node
// Process-only comparison. The provider is disabled and Claude Code is not run.

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const rounds = Number(process.argv[2] ?? 20);
if (!Number.isInteger(rounds) || rounds < 3 || rounds > 100) {
  process.stderr.write("Usage: node evals/posttool-benchmark.mjs [rounds: 3-100]\n");
  process.exit(2);
}

const root = new URL("../", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "jev-posttool-benchmark-"));
const bin = join(dir, "bin");
mkdirSync(bin);
const fakeMaven = join(bin, "mvn");
writeFileSync(fakeMaven, "#!/usr/bin/env node\nconsole.log('ok');\n");
chmodSync(fakeMaven, 0o700);
const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`,
  JEV_STATE_DIR: dir, JEV_LOG: join(dir, "log.jsonl"), JEV_HOOKS_GUARD: "0" };
delete env.TYPESAFE_API_KEY;
const command = "mvn test";
const direct = ["bash", "-c", command];
const wrapped = [process.execPath, join(root, "bin/jev-slim.mjs"), "exec", "--", command];
const post = [process.execPath, join(root, "bin/jev-hook.mjs"), "--post-slim"];
const event = JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Bash",
  tool_input: { command }, tool_response: { stdout: "ok\n", stderr: "", interrupted: false, isImage: false } });

const measure = (scenario) => {
  const started = performance.now();
  const args = scenario === "wrapped" ? wrapped : direct;
  const child = spawnSync(args[0], args.slice(1), { env, stdio: ["ignore", "pipe", "pipe"] });
  if (child.status !== 0 || child.stdout.toString() !== "ok\n") throw new Error(`${scenario} command failed`);
  if (scenario === "posttool") {
    const hook = spawnSync(post[0], post.slice(1), { env, input: event, encoding: "utf8" });
    if (hook.status !== 0 || hook.stdout) throw new Error("PostToolUse no-op failed");
  }
  return performance.now() - started;
};
const percentile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.ceil(sorted.length * fraction) - 1] * 10) / 10;
};

try {
  const names = ["direct", "wrapped", "posttool"];
  const samples = Object.fromEntries(names.map((name) => [name, []]));
  for (const name of names) measure(name);
  for (let i = 0; i < rounds; i++) {
    for (const name of [...names.slice(i % 3), ...names.slice(0, i % 3)]) samples[name].push(measure(name));
  }
  const report = Object.fromEntries(names.map((name) => [name, {
    p50Ms: percentile(samples[name], 0.5), p95Ms: percentile(samples[name], 0.95),
  }]));
  process.stdout.write(JSON.stringify({ source: "synthetic-short-command-no-provider-no-host", rounds, ...report,
    posttoolMinusWrappedP50Ms: Math.round((report.posttool.p50Ms - report.wrapped.p50Ms) * 10) / 10 }, null, 2) + "\n");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
