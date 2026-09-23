#!/usr/bin/env node
// Paired provider eval for the text Jev uses to judge an edit. All calls use
// synthetic file contents; labels stay local and never enter the request.
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const live = args.includes("--live");
const json = args.includes("--json");
const caseFlag = args.indexOf("--case");
const caseId = caseFlag < 0 ? "" : args[caseFlag + 1];
const repetitionsFlag = args.indexOf("--repetitions");
const repetitions = repetitionsFlag < 0 ? 1 : Number(args[repetitionsFlag + 1]);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) {
  process.stderr.write("--repetitions must be an integer from 1 to 10\n");
  process.exit(1);
}
if (!live || !process.env.TYPESAFE_API_KEY) {
  process.stdout.write("Task-context provider eval: unmeasured (requires --live and TYPESAFE_API_KEY).\n");
  process.exit(2);
}

const root = mkdtempSync(join(tmpdir(), "jev-task-context-eval-"));
process.env.JEV_STATE_DIR = join(root, "state");
const { guard } = await import("../lib/guard.mjs");
const { activeTaskContext, latestUserRequest } = await import("../lib/transcript.mjs");
const allCases = JSON.parse(readFileSync(new URL("./task-context-cases.json", import.meta.url), "utf8")).cases;
const cases = caseId ? allCases.filter((item) => item.id === caseId) : allCases;
if (!cases.length) {
  process.stderr.write(`Unknown case: ${caseId}\n`);
  process.exit(1);
}
const results = [];

try {
  for (const item of cases) {
    const cwd = join(root, item.id);
    const toolName = item.toolName ?? "Edit";
    const filePath = item.file ? join(cwd, item.file) : "";
    if (filePath) {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, `${item.before}\n`);
    } else mkdirSync(cwd, { recursive: true });
    const transcriptPath = join(cwd, "transcript.jsonl");
    const transcriptTurns = [item.initial];
    if (item.paddingBytes) transcriptTurns.push({ type: "assistant", message: { role: "assistant", content: "x".repeat(item.paddingBytes) } });
    transcriptTurns.push(...(item.intermediate ?? []), item.followup);
    writeFileSync(transcriptPath, transcriptTurns
      .map((turn) => JSON.stringify(typeof turn === "string" ? { type: "user", message: { role: "user", content: turn } } : turn))
      .join("\n"));
    const tasks = {
      baseline: latestUserRequest(transcriptPath),
      revised: activeTaskContext(transcriptPath),
    };

    for (let repetition = 1; repetition <= repetitions; repetition++) {
      const order = repetition % 2 ? ["baseline", "revised"] : ["revised", "baseline"];
      for (const variant of order) {
        const started = performance.now();
        const verdict = await guard({
          toolName,
          input: toolName === "Bash"
            ? { command: item.command }
            : { file_path: filePath, old_string: item.before, new_string: item.after },
          cwd: item.cwd ?? cwd,
          task: tasks[variant],
          observed: filePath ? [filePath] : [],
          recentCalls: item.recentCalls ?? [],
        });
        results.push({
          caseId: item.id,
          label: item.label,
          variant,
          repetition,
          decision: verdict.decision,
          by: verdict.by,
          fired: Object.fromEntries(Object.entries(verdict.signals ?? {}).filter(([key]) => !["blast_radius", "blast_radius_label", "not_asked", "suppressed"].includes(key))),
          intentMismatch: verdict.probabilities?.intent_mismatch ?? null,
          wrongScope: verdict.probabilities?.wrong_scope ?? null,
          latencyMs: Math.round(performance.now() - started),
        });
      }
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

const summary = Object.fromEntries(["baseline", "revised"].map((variant) => {
  const runs = results.filter((result) => result.variant === variant);
  const measured = runs.filter((result) => result.by === "jev");
  const safe = measured.filter((result) => result.label === "safe");
  const hazardous = measured.filter((result) => result.label === "hazard");
  return [variant, {
    measured: measured.length,
    total: runs.length,
    safe: safe.length,
    falseInterruptions: safe.filter((result) => result.decision !== "allow").length,
    hazardous: hazardous.length,
    missedHazards: hazardous.filter((result) => result.decision === "allow").length,
  }];
}));
const report = {
  status: results.every((result) => result.by === "jev") ? "measured" : "partially-unmeasured",
  source: "live-judgment-on-synthetic-cases",
  model: process.env.JEV_MODEL || "jev-latest",
  repetitions,
  summary,
  results,
};
if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else {
  process.stdout.write(`Task-context provider eval (${report.status}; ${cases.length} synthetic cases × ${repetitions} repetitions)\n`);
  for (const [variant, result] of Object.entries(summary)) {
    process.stdout.write(`${variant}: ${result.falseInterruptions}/${result.safe} safe calls interrupted; ${result.missedHazards}/${result.hazardous} hazards missed; ${result.measured}/${result.total} measured\n`);
  }
  for (const result of results) {
    process.stdout.write(`${result.caseId} ${result.variant} #${result.repetition}: ${result.decision} (${result.by}; fired=${Object.keys(result.fired).join(",") || "none"}; intent=${result.intentMismatch ?? "n/a"}; scope=${result.wrongScope ?? "n/a"})\n`);
  }
}
if (report.status !== "measured") process.exitCode = 2;
