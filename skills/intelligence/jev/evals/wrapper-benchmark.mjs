#!/usr/bin/env node
// Synthetic process overhead only. No provider call or user command is run.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const rounds = Number(process.argv[2] ?? 12);
if (!Number.isInteger(rounds) || rounds < 3 || rounds > 100) {
  process.stderr.write("Usage: node evals/wrapper-benchmark.mjs [rounds: 3-100]\n");
  process.exit(2);
}

const bin = new URL("../bin/jev-slim.mjs", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "jev-wrapper-benchmark-"));
const env = { ...process.env, JEV_STATE_DIR: dir, JEV_LOG: join(dir, "log.jsonl"), JEV_SLIM_FAILURES: "0" };
delete env.TYPESAFE_API_KEY;
const shell = env.SHELL && /bash|zsh/.test(env.SHELL) ? env.SHELL : "/bin/bash";
const scenarios = {
  direct: [shell, "-c", ":"],
  wrapped: [process.execPath, bin, "exec", "--", ":"],
};
const samples = { direct: [], wrapped: [] };
const measure = (name) => {
  const [executable, ...args] = scenarios[name];
  const start = performance.now();
  const result = spawnSync(executable, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const elapsed = performance.now() - start;
  if (result.status !== 0) throw new Error(`${name} no-op failed`);
  return elapsed;
};
const percentile = (values, fraction) => {
  const ordered = [...values].sort((a, b) => a - b);
  return Math.round(ordered[Math.ceil(ordered.length * fraction) - 1] * 10) / 10;
};

try {
  measure("direct");
  measure("wrapped");
  for (let i = 0; i < rounds; i++) {
    for (const name of i % 2 ? ["wrapped", "direct"] : ["direct", "wrapped"]) {
      samples[name].push(measure(name));
    }
  }
  const directP50 = percentile(samples.direct, 0.5);
  const wrappedP50 = percentile(samples.wrapped, 0.5);
  process.stdout.write(JSON.stringify({
    source: "synthetic-noop",
    rounds,
    direct: { p50Ms: directP50, p95Ms: percentile(samples.direct, 0.95) },
    wrapped: { p50Ms: wrappedP50, p95Ms: percentile(samples.wrapped, 0.95) },
    medianOverheadMs: Math.round((wrappedP50 - directP50) * 10) / 10,
  }, null, 2) + "\n");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
