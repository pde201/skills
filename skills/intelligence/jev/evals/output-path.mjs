#!/usr/bin/env node
// Replay logged slimmer decisions against today's narrow wrapper exclusions.
// Output is aggregate only: no command text, paths, or captured output.

import { readFileSync } from "node:fs";
import { shouldWrap } from "../lib/wrap.mjs";

const args = process.argv.slice(2);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i < 0 ? null : args[i + 1] ?? null;
};
const logPath = valueOf("--log");
const since = valueOf("--since");
if (args.includes("--help")) {
  process.stdout.write("Usage: node evals/output-path.mjs --log PATH [--since ISO_DATE]\nReports aggregate replay only. Missing or empty input exits 2; a historically trimmed output selected for skipping exits 1.\n");
  process.exit(0);
}
if (!logPath || (args.includes("--since") && !since)) {
  process.stderr.write("--log PATH is required; --since needs a date\n");
  process.exit(2);
}

let raw;
try { raw = readFileSync(logPath, "utf8"); }
catch { process.stderr.write("Cannot read the Jev decision log\n"); process.exit(2); }

const report = {
  source: "historical-local-replay",
  rows: 0,
  completeCommands: 0,
  truncatedCommands: 0,
  candidateSkips: 0,
  missedTrims: 0,
  byReason: {},
};
const candidateReasons = new Set(["bounded inspection output", "stdout capped below slimming threshold", "may print credentials"]);

for (const line of raw.split("\n")) {
  let row;
  try { row = JSON.parse(line); } catch { continue; }
  if (row?.hook !== "jev-slim" || typeof row.command !== "string") continue;
  if (since && String(row.at ?? "") < since) continue;
  report.rows++;
  // Legacy records retained at most 200 command characters. A 200-character
  // record could be a partial shell expression and is not safe to replay.
  if (row.command.length >= 200) {
    report.truncatedCommands++;
    continue;
  }
  report.completeCommands++;
  const verdict = shouldWrap(row.command);
  if (!candidateReasons.has(verdict.why)) continue;
  report.candidateSkips++;
  report.missedTrims += Number(row.changed === true);
  const bucket = report.byReason[verdict.why] ??= { skipped: 0, previouslyTrimmed: 0 };
  bucket.skipped++;
  bucket.previouslyTrimmed += Number(row.changed === true);
}

process.stdout.write(JSON.stringify(report, null, 2) + "\n");
if (report.rows === 0) process.exitCode = 2;
else if (report.missedTrims > 0) process.exitCode = 1;
