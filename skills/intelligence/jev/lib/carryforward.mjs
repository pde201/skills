// ──────────────────────────────────────────────────────────────────────
//  Survive compaction.
//
//  `PreCompact` can only allow or deny compaction — it cannot steer what
//  the compactor keeps. So this works in two halves: before compaction we
//  work out what must not be lost and write it to disk; after compaction a
//  SessionStart hook reads that file back in.
//
//  Jev does not write the brief. It ranks candidates that code harvested
//  from the transcript, and code assembles the result — selecting rather
//  than generating is the whole point, and it means every line of the
//  brief is text that actually appeared in the session.
// ──────────────────────────────────────────────────────────────────────

import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { systemOne, choice, noul, ranked, nouls, costUsd, haveKey } from "./client.mjs";
import { readEntries, latestUserRequest } from "./transcript.mjs";
import { stateDir } from "./log.mjs";
import config from "./config.mjs";

const MAX_CANDIDATES = 40;
const KEEP_THRESHOLD = 0.01; // probability mass, not a confidence gate

const briefPath = (sessionId) => join(stateDir(), `carry-forward-${sessionId || "unknown"}.md`);

// ── Harvest ──────────────────────────────────────────────────────────

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((p) => p?.type === "text" && p.text).map((p) => p.text).join("\n");
};

/**
 * Pull candidate facts out of the transcript. Each is verbatim session
 * text, tagged with a kind so code can enforce must-keeps independently of
 * how Jev ranks them.
 */
export function harvest(transcriptPath) {
  const entries = readEntries(transcriptPath);
  const candidates = [];
  const pending = new Map();
  const add = (kind, text, mandatory = false) => {
    const trimmed = (text ?? "").trim().replace(/\s+/g, " ").slice(0, 400);
    if (trimmed.length > 12) candidates.push({ kind, text: trimmed, mandatory });
  };

  for (const entry of entries) {
    const message = entry?.message ?? entry;
    const role = message?.role ?? entry?.type;
    const content = message?.content;

    if (role === "user" && !Array.isArray(content)) {
      // Anything the human said is a standing constraint until it is met.
      add("request", textOf(content), true);
    }

    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === "text" && role === "user" && !part.text.startsWith("<")) {
        add("request", part.text, true);
      }
      if (part?.type === "tool_use") {
        pending.set(part.id, part);
      }
      if (part?.type === "tool_result") {
        const call = pending.get(part.tool_use_id);
        if (!call) continue;
        pending.delete(part.tool_use_id);
        const input = call.input ?? {};
        if (part.is_error) {
          add("failure", `${call.name} failed: ${input.command ?? input.file_path ?? ""} → ${textOf(part.content).slice(0, 200)}`, true);
        } else if (call.name === "Edit" || call.name === "Write") {
          add("change", `${call.name} ${input.file_path ?? ""}`);
        } else if (call.name === "Bash" && typeof input.command === "string") {
          add("action", `ran: ${input.command}`);
        }
      }
    }
  }

  // De-duplicate, then trim to size. Mandatory candidates are never trimmed:
  // dropping a constraint the user stated because forty commands ran after it
  // is exactly the failure this whole hook exists to prevent.
  const unique = new Map();
  for (const c of candidates) unique.set(`${c.kind}:${c.text}`, c);
  const all = [...unique.values()];

  const mandatory = all.filter((c) => c.mandatory);
  const optional = all.filter((c) => !c.mandatory);
  const room = Math.max(0, MAX_CANDIDATES - mandatory.length);

  // Keep the most recent optional ones; older actions are usually superseded.
  const kept = new Set([...mandatory, ...optional.slice(-room)]);
  return all
    .filter((c) => kept.has(c))
    .map((c, i) => ({ ...c, id: `C${String(i).padStart(2, "0")}` }));
}

// ── Judge ────────────────────────────────────────────────────────────

export function carryForwardQuestions(candidates) {
  const ids = Object.fromEntries(candidates.map((c) => [c.id, null]));
  return {
    most_needed: choice(
      "Which entry in `candidates` would be most damaging to forget if the assistant had to carry on with `current_task` from a summary alone?",
      ids,
    ),
    next_needed: choice(
      "Setting aside the single most important one, which entry in `candidates` would be next most damaging to forget while continuing `current_task`?",
      ids,
    ),
    work_unfinished: noul(
      "Is there work in `candidates` that was started and has not been finished or verified?",
      {
        true: "Something was begun, or failed, and has not been resolved",
        false: "Everything attempted was completed or explicitly abandoned",
      },
    ),
    constraint_outstanding: noul(
      "Did the user state a constraint or preference in `candidates` that later work must still honour?",
      {
        true: "A stated requirement, preference or prohibition still applies",
        false: "Nothing the user said constrains what happens next",
      },
    ),
  };
}

// ── Compose ──────────────────────────────────────────────────────────

const HEADINGS = {
  request: "What was asked for",
  failure: "Unresolved failures",
  change: "Files changed this session",
  action: "Relevant commands already run",
};

export function composeBrief(candidates, keepIds, flags, task) {
  const kept = candidates.filter((c) => c.mandatory || keepIds.has(c.id));
  if (!kept.length) return null;

  const groups = new Map();
  for (const c of kept) {
    if (!groups.has(c.kind)) groups.set(c.kind, []);
    groups.get(c.kind).push(c.text);
  }

  const lines = ["# Carried forward past compaction", ""];
  if (task) lines.push(`Current task: ${task}`, "");
  for (const kind of ["request", "failure", "change", "action"]) {
    const items = groups.get(kind);
    if (!items?.length) continue;
    lines.push(`## ${HEADINGS[kind]}`);
    for (const item of items) lines.push(`- ${item}`);
    lines.push("");
  }
  const notes = [];
  if (flags.work_unfinished >= 0.5) notes.push("Work was left unfinished — check the failures above before moving on.");
  if (flags.constraint_outstanding >= 0.5) notes.push("A constraint the user stated still applies; re-read the requests above.");
  if (notes.length) lines.push("## Before continuing", ...notes.map((n) => `- ${n}`), "");

  return lines.join("\n");
}

// ── Entry points ─────────────────────────────────────────────────────

export async function buildBrief({ transcriptPath, sessionId, model } = {}) {
  if (!config.carryForward) return { written: false, reason: "disabled" };

  const candidates = harvest(transcriptPath);
  if (!candidates.length) return { written: false, reason: "nothing to carry" };

  const task = latestUserRequest(transcriptPath);
  let keepIds = new Set();
  let flags = {};
  let usage;

  if (haveKey()) {
    try {
      const res = await systemOne({
        model: model ?? config.model,
        state: {
          current_task: task || "(not stated)",
          candidates: candidates.map((c) => `${c.id}| [${c.kind}] ${c.text}`),
        },
        questions: carryForwardQuestions(candidates),
        timeoutMs: Math.max(config.timeoutMs, 8000), // compaction is not the critical path
      });
      usage = res.usage;
      flags = nouls(res, ["work_unfinished", "constraint_outstanding"]);
      for (const id of ["most_needed", "next_needed"]) {
        for (const { option, probability } of ranked(res, id)) {
          if (probability >= KEEP_THRESHOLD) keepIds.add(option);
        }
      }
    } catch {
      // Fall through: the mandatory candidates alone still beat nothing.
    }
  }

  const brief = composeBrief(candidates, keepIds, flags, task);
  if (!brief) return { written: false, reason: "empty brief" };

  const path = briefPath(sessionId);
  writeFileSync(path, brief, "utf8");
  return { written: true, path, kept: keepIds.size, candidates: candidates.length, usage, cost: costUsd(usage) };
}

/** Read the brief back and remove it, so it is injected exactly once. */
export function consumeBrief(sessionId) {
  const path = briefPath(sessionId);
  if (!existsSync(path)) return null;
  try {
    const brief = readFileSync(path, "utf8");
    unlinkSync(path);
    return brief;
  } catch {
    return null;
  }
}
