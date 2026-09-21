// ──────────────────────────────────────────────────────────────────────
//  Read what the session has been doing, from the transcript JSONL that
//  every hook receives a path to.
//
//  Judgments are only as good as the state behind them: "is this command
//  right?" is unanswerable without knowing what was asked for.
// ──────────────────────────────────────────────────────────────────────

import { readFileSync, statSync } from "node:fs";

const MAX_BYTES = 4_000_000;

function readEntries(path) {
  if (!path) return [];
  let raw;
  try {
    const size = statSync(path).size;
    raw = readFileSync(path, "utf8");
    // Transcripts grow without bound; only the tail is ever relevant.
    if (size > MAX_BYTES) raw = raw.slice(-MAX_BYTES);
  } catch {
    return [];
  }
  const entries = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A truncated first line after slicing, or a partial final write.
    }
  }
  return entries;
}

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
};

const extractUserText = (raw) => {
  if (!raw || typeof raw !== "string") return "";
  const match = raw.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  if (match) return match[1].trim();
  // Claude/Codex tool results arrive shaped as user turns; skip them
  if (raw.startsWith("<") && !raw.startsWith("<USER_REQUEST>")) return "";
  return raw.trim();
};

const isUserTurn = (entry) =>
  entry?.type === "user" ||
  entry?.role === "user" ||
  entry?.message?.role === "user" ||
  entry?.type === "USER_INPUT" ||
  entry?.source === "USER_EXPLICIT";

/** The most recent thing the human actually asked for. */
export function latestUserRequest(path, { maxChars = 1500 } = {}) {
  const entries = readEntries(path);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (!isUserTurn(entries[i])) continue;
    const raw = textOf(entries[i].message?.content ?? entries[i].content);
    const text = extractUserText(raw);
    if (!text) continue;
    return text.slice(0, maxChars);
  }
  return "";
}

/** Recent tool calls and whether they failed — the context for "is this a repeat?". */
export function recentToolCalls(path, { limit = 12 } = {}) {
  const entries = readEntries(path);
  const calls = [];
  for (const entry of entries) {
    // Claude Code / Codex format
    const content = entry?.message?.content ?? entry?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === "tool_use") {
          calls.push({ tool: part.name, input: summarizeInput(part.input), failed: false, id: part.id });
        } else if (part?.type === "tool_result") {
          const call = calls.find((c) => c.id === part.tool_use_id);
          if (call) {
            call.failed = Boolean(part.is_error);
            call.result = textOf(part.content).slice(0, 300);
          }
        }
      }
    }

    // Antigravity format
    if (Array.isArray(entry?.tool_calls)) {
      for (const call of entry.tool_calls) {
        const id = call.id ?? String(entry.step_index ?? Math.random());
        calls.push({ tool: call.name, input: summarizeInput(call.args ?? call.input), failed: false, id });
      }
    } else if (entry?.source === "MODEL" && entry?.type === "GENERIC" && calls.length > 0) {
      const lastCall = calls[calls.length - 1];
      if (lastCall && !lastCall.result) {
        lastCall.failed = Boolean(entry.status === "ERROR");
        lastCall.result = (typeof entry.content === "string" ? entry.content : "").slice(0, 300);
      }
    }
  }
  return calls.slice(-limit).map(({ id, ...rest }) => rest);
}

function summarizeInput(input) {
  if (!input || typeof input !== "object") return String(input ?? "");
  if (typeof input.command === "string") return input.command.slice(0, 300);
  if (typeof input.CommandLine === "string") return input.CommandLine.slice(0, 300);
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.AbsolutePath === "string") return input.AbsolutePath;
  if (typeof input.TargetFile === "string") return input.TargetFile;
  if (typeof input.pattern === "string") return input.pattern;
  if (typeof input.Pattern === "string") return input.Pattern;
  return JSON.stringify(input).slice(0, 300);
}

/** Every file path this session has successfully touched — used to spot invented paths. */
export function observedPaths(path) {
  const seen = new Set();
  for (const call of recentToolCalls(path, { limit: 400 })) {
    if (call.failed) continue;
    const match = call.input.match(/(?:^|\s)((?:~|\.{0,2}\/)[\w.\-/@]+)/g);
    for (const m of match ?? []) seen.add(m.trim());
    if (/^\/|^\.\//.test(call.input)) seen.add(call.input);
  }
  return [...seen].slice(0, 200);
}

export { readEntries };
