// ──────────────────────────────────────────────────────────────────────
//  Slim bloated tool output.
//
//  Code owns the mechanics: splitting, de-noising, budgeting, and keeping
//  the full text on disk. Jev supplies the one thing code cannot do —
//  judging which parts of this particular output matter for this
//  particular task.
//
//  Fails open. If anything goes wrong the original output is returned
//  untouched; a filter that eats a stack trace is worse than no filter.
// ──────────────────────────────────────────────────────────────────────

import { join } from "node:path";
import { systemOne, choice, noul, score, pickChoice, pickScore, ranked, nouls, costUsd, haveKey } from "./client.mjs";
import { createPrivateTempDir, writePrivateFile } from "./privacy.mjs";

// Choice criteria cap; the docs put the practical ceiling at 255 options.
const MAX_BLOCKS = 200;
// Keep state comfortably inside the 32k-token state budget.
const MAX_STATE_CHARS = 90_000;

export const SHAPES = {
  test_results: "Output of a test run: passes, failures, assertions",
  build_or_compile: "A build, bundle, compile or typecheck log",
  package_manager: "Dependency install, resolution or audit output",
  file_listing: "A listing of files, paths or directory contents",
  structured_data: "JSON, YAML, CSV or another machine-readable payload",
  stack_trace: "An error, exception or stack trace",
  diff_or_patch: "A diff, patch or changeset",
  log_stream: "Timestamped application or service logs",
  status_report: "Status of resources, processes, jobs or containers",
  prose_or_docs: "Documentation, help text or human prose",
  other: null,
};

const DETAIL_LEVELS = [
  "Only the verdict matters: whether it worked, and the single headline number or name",
  "The verdict plus the specific names, paths or identifiers involved",
  "The verdict plus enough surrounding detail to diagnose what went wrong",
  "Nearly all of it: the exact text is the answer and paraphrase would lose it",
];

// ── Deterministic pre-pass ───────────────────────────────────────────

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
/**
 * Strip control noise and collapse runs of identical lines. Pure, lossy
 * only of redraw churn: a carriage return in the middle of a line moves
 * the terminal cursor back to the start, so only the text after the last
 * one was ever visible. Nothing is dropped by content — a spinner or a
 * "100% tests passed" line is kept, because guessing which percent lines
 * are progress bars is exactly how a summary line gets lost.
 */
export function denoise(text) {
  const lines = text.replace(ANSI, "").split("\n");
  const out = [];
  let run = null;
  let runCount = 0;
  for (const raw of lines) {
    const settled = raw.replace(/\r+$/, "");
    const rendered = settled.includes("\r") ? settled.slice(settled.lastIndexOf("\r") + 1) : settled;
    const line = rendered.replace(/\s+$/, "");
    if (line === run) {
      runCount++;
      continue;
    }
    if (runCount > 1) out.push(`      … previous line repeated ${runCount} more times`);
    run = line;
    runCount = 0;
    out.push(line);
  }
  if (runCount > 1) out.push(`      … previous line repeated ${runCount} more times`);
  return out.join("\n");
}

/** Split lines into at most MAX_BLOCKS contiguous blocks. */
export function toBlocks(lines, maxBlocks = MAX_BLOCKS) {
  const size = Math.max(1, Math.ceil(lines.length / maxBlocks));
  const blocks = [];
  for (let i = 0; i < lines.length; i += size) {
    blocks.push({
      id: `B${String(blocks.length).padStart(3, "0")}`,
      start: i,
      end: Math.min(i + size, lines.length) - 1,
      lines: lines.slice(i, i + size),
    });
  }
  return blocks;
}

/** Render blocks for `state`, shrinking to previews if the full text is too large. */
export function renderBlocks(blocks) {
  const full = blocks.map((b) => `${b.id}|\n${b.lines.join("\n")}`).join("\n\n");
  if (full.length <= MAX_STATE_CHARS) return { text: full, previewed: false };

  const preview = blocks
    .map((b) => {
      const head = b.lines.slice(0, 2).join("\n");
      const tail = b.lines.length > 3 ? `\n…\n${b.lines[b.lines.length - 1]}` : "";
      return `${b.id}| (lines ${b.start}-${b.end})\n${head}${tail}`;
    })
    .join("\n\n");
  return { text: preview.slice(0, MAX_STATE_CHARS), previewed: true };
}

// ── The judgments ────────────────────────────────────────────────────

export function slimQuestions(blocks, task, command) {
  // Built fresh for each question that needs it. Sharing one object between
  // two questions is valid JSON but looks like a cycle to a naive redactor,
  // and a criteria map that arrives as "[REDACTED]" is a 422 on every call.
  const blockIds = () => Object.fromEntries(blocks.map((b) => [b.id, null]));
  return {
    shape: choice(
      "What kind of output is `output`? Judge by its own content, not by the command that produced it.",
      SHAPES,
    ),
    failed: noul(
      "Does `output` report that the command did not succeed — a failure, error, non-zero result, or refusal?",
      {
        true: "It reports an error, failure, crash, or work that did not complete",
        false: "It reports success, or simply reports information with nothing failing",
      },
    ),
    actionable: noul(
      "Does `output` contain something the engineer must read in full to act on it, such as an error message, a path, a name, or an exact value?",
      {
        true: "Acting correctly requires reading specific text from this output",
        false: "Knowing whether it succeeded is enough; the body is routine",
      },
    ),
    detail_needed: score(
      `How much of \`output\` does someone need in order to carry on with the task in \`task\`?`,
      DETAIL_LEVELS,
    ),
    relevance: choice(
      `Which block of \`output\` is most important to keep for someone working on \`task\`? The command that produced it was \`command\`.`,
      blockIds(),
    ),
    ...(blocks.length > 1
      ? {
          second_relevance: choice(
            `Setting aside the single most important block, which block of \`output\` carries the next most important information for \`task\`?`,
            blockIds(),
          ),
        }
      : {}),
  };
}

// ── Composition ──────────────────────────────────────────────────────

/** Keep blocks in probability order until the line budget is spent. */
export function selectBlocks(blocks, rankings, budgetLines, alwaysKeep) {
  const weight = new Map(blocks.map((b) => [b.id, 0]));
  for (const rank of rankings) {
    for (const { option, probability } of rank) {
      if (weight.has(option)) weight.set(option, weight.get(option) + probability);
    }
  }

  const keep = new Set(alwaysKeep);
  let used = blocks.filter((b) => keep.has(b.id)).reduce((n, b) => n + b.lines.length, 0);

  for (const [id] of [...weight.entries()].sort((a, b) => b[1] - a[1])) {
    if (keep.has(id)) continue;
    const block = blocks.find((b) => b.id === id);
    if (!block) continue;
    if (used + block.lines.length > budgetLines) continue;
    keep.add(id);
    used += block.lines.length;
  }
  return keep;
}

/** Stitch kept blocks back together with explicit gap markers. */
export function stitch(blocks, keep, fullPath) {
  const parts = [];
  let hidden = 0;
  let gapStart = null;

  const flushGap = (endLine) => {
    if (gapStart === null) return;
    parts.push(`[… ${endLine - gapStart + 1} lines hidden …]`);
    gapStart = null;
  };

  for (const b of blocks) {
    if (keep.has(b.id)) {
      flushGap(b.start - 1);
      parts.push(b.lines.join("\n"));
    } else {
      hidden += b.lines.length;
      if (gapStart === null) gapStart = b.start;
    }
  }
  if (gapStart !== null) parts.push(`[… ${blocks[blocks.length - 1].end - gapStart + 1} lines hidden …]`);

  const body = parts.join("\n");
  const footer = hidden
    ? `\n\n[jev: ${hidden} of ${blocks[blocks.length - 1].end + 1} lines hidden as not relevant to the current task. Full output: ${fullPath}]`
    : "";
  return { text: body + footer, hidden };
}

function stash(text) {
  const path = join(createPrivateTempDir("jev-output-"), "output.txt");
  return writePrivateFile(path, text);
}

const FAILURE_ANCHOR = /\b(?:[a-z]*error|errors|failed|failure|exception|assertion|traceback|caused by)\b|^\s*not ok\b/i;
const MIN_FAILURE_LINES = 120;
const MAX_FAILURE_LINES = 100;

/**
 * An opt-in, local-only failed-stdout trial. Keep exact diagnostic lines with
 * nearby context and the command's tail. If the evidence cannot fit, return
 * the original output. stderr is never passed here and remains verbatim.
 */
export function summarizeFailedStdout(output, { minLines = MIN_FAILURE_LINES } = {}) {
  const unchanged = (reason) => ({ text: output, changed: false, reason });
  if (typeof output !== "string" || !output.trim()) return unchanged("empty failure stdout");

  const lines = output.split("\n");
  if (lines.length < Math.max(MIN_FAILURE_LINES, minLines)) return unchanged("short failure stdout");

  const anchors = [];
  for (let i = 0; i < lines.length; i++) {
    if (FAILURE_ANCHOR.test(lines[i])) anchors.push(i);
  }
  if (!anchors.length) return unchanged("no diagnostic anchor");

  const keep = new Set();
  const addRange = (start, end) => {
    for (let i = Math.max(0, start); i <= Math.min(lines.length - 1, end); i++) keep.add(i);
  };
  addRange(0, 3);
  addRange(lines.length - 30, lines.length - 1);
  for (const anchor of anchors) addRange(anchor - 2, anchor + 2);
  if (keep.size >= lines.length || keep.size > MAX_FAILURE_LINES) {
    return unchanged("diagnostics exceed failure summary budget");
  }

  const selected = [...keep].sort((a, b) => a - b);
  const parts = [];
  let previous = -1;
  for (const i of selected) {
    if (i > previous + 1) parts.push(`[… ${i - previous - 1} lines hidden …]`);
    parts.push(lines[i]);
    previous = i;
  }
  if (previous < lines.length - 1) parts.push(`[… ${lines.length - previous - 1} lines hidden …]`);

  const fullPath = stash(output);
  const hidden = lines.length - selected.length;
  const footer = `[jev: ${hidden} of ${lines.length} failed-output lines hidden; full stdout: ${fullPath}]`;
  return {
    text: `${parts.join("\n")}\n\n${footer}`,
    changed: true,
    hidden,
    reason: `failure diagnostics · kept ${selected.length}/${lines.length} lines`,
  };
}

// ── Entry point ──────────────────────────────────────────────────────

/**
 * @returns {Promise<{text: string, changed: boolean, reason: string, usage?: object, cost?: number}>}
 */
export async function slim(output, { task = "", command = "", minLines = 60, model } = {}) {
  const unchanged = (reason) => ({ text: output, changed: false, reason });

  if (!haveKey()) return unchanged("no api key");
  if (typeof output !== "string" || !output.trim()) return unchanged("empty output");

  const cleaned = denoise(output);
  const lines = cleaned.split("\n");
  if (lines.length < minLines) return unchanged(`under ${minLines} lines`);

  const blocks = toBlocks(lines);
  const rendered = renderBlocks(blocks);

  let res;
  try {
    res = await systemOne({
      model,
      state: {
        task: task || "(not stated)",
        command: command || "(not stated)",
        output: rendered.text,
      },
      questions: slimQuestions(blocks, task, command),
    });
  } catch (err) {
    return unchanged(`jev unavailable: ${err.message}`);
  }

  const shape = pickChoice(res, "shape");
  const detail = pickScore(res, "detail_needed");
  const flags = nouls(res, ["failed", "actionable"]);

  // A failure the engineer has to read is exactly the output you must not cut.
  if (flags.failed >= 0.5 && flags.actionable >= 0.5) {
    return { ...unchanged("failure output kept whole"), usage: res.usage, cost: costUsd(res.usage) };
  }
  // "The exact text is the answer" — leave it alone.
  if ((detail?.score ?? 0) >= 2.5) {
    return { ...unchanged("detail level too high to cut"), usage: res.usage, cost: costUsd(res.usage) };
  }

  // Budget grows with how much detail the task needs.
  const fraction = [0.08, 0.2, 0.45][Math.round(detail?.score ?? 1)] ?? 0.2;
  const budgetLines = Math.max(20, Math.ceil(lines.length * fraction));
  if (budgetLines >= lines.length) {
    return { ...unchanged("budget covers whole output"), usage: res.usage, cost: costUsd(res.usage) };
  }

  // The first and last blocks hold the invocation and the summary line often
  // enough that anchoring them is cheaper than asking.
  const anchors = [blocks[0].id, blocks[blocks.length - 1].id];
  const keep = selectBlocks(
    blocks,
    [ranked(res, "relevance"), ranked(res, "second_relevance")],
    budgetLines,
    anchors,
  );

  const fullPath = stash(output);
  const { text, hidden } = stitch(blocks, keep, fullPath);
  if (!hidden) {
    return { ...unchanged("nothing worth hiding"), usage: res.usage, cost: costUsd(res.usage) };
  }

  return {
    text,
    changed: true,
    reason: `${shape?.choice ?? "unknown"} · kept ${lines.length - hidden}/${lines.length} lines`,
    usage: res.usage,
    cost: costUsd(res.usage),
    fullPath,
  };
}
