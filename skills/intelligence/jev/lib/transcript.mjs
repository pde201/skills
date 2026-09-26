// ──────────────────────────────────────────────────────────────────────
//  Read what the session has been doing, from the transcript JSONL that
//  every hook receives a path to.
//
//  Judgments are only as good as the state behind them: "is this command
//  right?" is unanswerable without knowing what was asked for.
// ──────────────────────────────────────────────────────────────────────

import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

const MAX_BYTES = 4_000_000;
const ANCHOR_BYTES = 500_000;

function readEntries(path) {
  if (!path) return [];
  let raw;
  try {
    const size = statSync(path).size;
    raw = readFileSync(path, "utf8");
    // Keep the first request as well as recent activity: a short follow-up
    // can refer back to work that has fallen outside the transcript tail.
    if (size > MAX_BYTES) {
      const headSize = Math.min(ANCHOR_BYTES, size - MAX_BYTES);
      raw = `${raw.slice(0, headSize)}\n${raw.slice(-MAX_BYTES)}`;
    }
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

// A hook can need several views of the same transcript. Keep the parsed
// entries, and the derived tool calls, together so those views never reopen
// or reparse a multi-megabyte JSONL file. The marker is private so an ordinary
// path-like value cannot accidentally be treated as a snapshot.
const SNAPSHOT_MARKER = Symbol("jev transcript snapshot");

export function createTranscriptSnapshot(path) {
  return {
    [SNAPSHOT_MARKER]: true,
    path,
    entries: readEntries(path),
    calls: null,
    userActions: null,
  };
}

const isTranscriptSnapshot = (value) => Boolean(value && value[SNAPSHOT_MARKER] === true);
const entriesFor = (source) => isTranscriptSnapshot(source) ? source.entries : readEntries(source);
const snapshotFor = (source) => isTranscriptSnapshot(source) ? source : createTranscriptSnapshot(source);

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
};

// Text a host injects into user turns that the human never typed: Claude
// Code's system reminders and hook notifications, the desktop app's terminal
// relays, slash-command wrappers. It is not a request, and it is exactly the
// kind of bulk that a task string or a carry-forward brief must not carry.
const INJECTED_TAGS = [
  "system-reminder", "task-notification", "ci-monitor-event",
  "bash-input", "bash-stdout", "bash-stderr",
  "local-command-stdout", "local-command-stderr", "local-command-caveat",
  "command-name", "command-message", "command-args",
  "user-prompt-submit-hook", "ide_opened_file", "ide_selection",
];
const INJECTED_BLOCK = new RegExp(`<(${INJECTED_TAGS.join("|")})>[\\s\\S]*?</\\1>`, "g");
const INJECTED_OPENING = new RegExp(`^\\s*<(${INJECTED_TAGS.join("|")})>`);

/** Remove host-injected blocks from a user turn, leaving what the human wrote. */
export function stripInjectedBlocks(text) {
  if (typeof text !== "string") return "";
  const stripped = text.replace(INJECTED_BLOCK, "");
  // An unterminated block (truncated turn) still starts with its tag.
  return INJECTED_OPENING.test(stripped) ? "" : stripped.trim();
}

const extractUserText = (raw) => {
  if (!raw || typeof raw !== "string") return "";
  const match = raw.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  if (match) return match[1].trim();
  const text = stripInjectedBlocks(raw);
  if (/^\[Request interrupted by user(?: for tool use)?\]$/.test(text)) return "";
  if (/^This session is being continued from a previous conversation that ran out of context\./.test(text)) return "";
  if (/^The app was quit while you were working\. Please continue from where you left off\./.test(text)) return "";
  // Claude/Codex tool results arrive shaped as user turns; skip them
  if (text.startsWith("<") && !text.startsWith("<USER_REQUEST>")) return "";
  return text;
};

const isUserTurn = (entry) =>
  entry?.isMeta !== true && (
    entry?.type === "user" ||
    entry?.role === "user" ||
    entry?.message?.role === "user" ||
    entry?.type === "USER_INPUT" ||
    entry?.source === "USER_EXPLICIT"
  );

/** The most recent thing the human actually asked for. */
export function latestUserRequest(path, { maxChars = 1500 } = {}) {
  const entries = entriesFor(path);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (!isUserTurn(entries[i])) continue;
    const raw = textOf(entries[i].message?.content ?? entries[i].content);
    const text = extractUserText(raw);
    if (!text) continue;
    return text.slice(0, maxChars);
  }
  return "";
}

// Short steering and selection replies depend on the preceding task. An
// independent request stands alone so old work cannot silently widen it.
const FOLLOWUP = /^(?:please\s+)?(?:continue|resume|proceed|keep going|go on|carry on|go ahead|do it|retry|try again|(?:signed|logged) in[,;:]?\s+(?:go ahead|continue|proceed)|option\s+[a-z0-9]+|yes\b|yeah\b|yep\b|sure\b|okay\b|ok\b|agreed\b|approved\b|confirm(?:ed)?\b|confirm all\b|let'?s park\b|park\b|once\b|also\b|but\b|and\b|stop after\b|stop when\b)\b/i;
const RESET_TASK = /^(?:instead\b|forget\b|new task\b|switch to\b|stop(?:[.!?]?\s*$| working on\b))/i;
const SHORT_APPROVAL = /^(?:yes|yeah|yep|sure|okay|ok|agreed|approved|confirm(?:ed)?|go ahead|do it|proceed|option\s+[a-z0-9]+)(?:[.!?])?$/i;
const APPROVAL_PREFIX = /^(?:yes|yeah|yep|sure|okay|ok|agreed|approved|confirm(?:ed)?|go ahead|do it|proceed|option\s+[a-z0-9]+)\b/i;
const PROPOSAL_QUESTION = /\b(?:do you want me(?: to)?|would you like me(?: to)?|should i\b|shall i\b|can i\b|may i\b|want me to\b|which (?:option|one)\b|(?:needs?|requires?) your (?:ok|okay|approval)\b)\b/i;
const PROPOSAL_ACTION = /\b(?:i['’]ll|i['’]d|i would|i can|i will|we can|we should|let me|switch|update|change|edit|add|remove|run|commit|push|regenerate|make|apply|implement|fix|keep|leave|park)\b/i;
const MAX_PROPOSAL_CHARS = 800;
const REFERENCE_STOPWORDS = new Set([
  "after", "again", "agreed", "before", "change", "changes", "commit", "commits",
  "confirm", "continue", "files", "final", "going", "option", "please",
  "proceed", "related", "resume", "review", "should", "start", "tests",
  "their", "there", "these", "those", "three", "through", "update", "with",
  "work", "would",
]);

function relatedEarlierTurn(turns, latest) {
  const words = [...new Set((latest.toLowerCase().match(/[a-z][a-z0-9-]{4,}/g) ?? [])
    .filter((word) => !REFERENCE_STOPWORDS.has(word)))];
  if (!words.length) return "";
  for (let i = turns.length - 1; i >= 0; i--) {
    const candidate = turns[i];
    if (words.some((word) => new RegExp(`\\b${word}\\b`, "i").test(candidate))) return candidate;
  }
  return "";
}

const isAssistantTurn = (entry) =>
  entry?.isMeta !== true && (
    entry?.type === "assistant" ||
    entry?.role === "assistant" ||
    entry?.message?.role === "assistant"
  );

function shortApproval(text) {
  const value = text.trim();
  if (!value || value.length > 160) return false;
  if (SHORT_APPROVAL.test(value)) return true;
  // Keep short replies with a small qualifier (for example, "yes, please")
  // in the approval path while leaving explicit scope changes in the user
  // text for the normal follow-up handling below.
  return APPROVAL_PREFIX.test(value) && !/\b(?:instead|only|except|without|keep|don't|do not|never)\b/i.test(value);
}

function assistantText(entry) {
  return stripInjectedBlocks(textOf(entry?.message?.content ?? entry?.content));
}

/**
 * A short approval can answer an assistant's plan rather than restating the
 * user's task. Carry only the immediately preceding assistant text when it
 * contains an explicit approval question. Tool calls and tool results are
 * deliberately not considered proposal text.
 */
function precedingAssistantProposal(entries, latestEntryIndex) {
  if (latestEntryIndex < 0) return "";
  for (let index = latestEntryIndex - 1; index >= 0; index--) {
    const entry = entries[index];
    // Tool results are encoded as user turns by Claude. Only a new human
    // direction can supersede the proposal the short reply refers to.
    if (isUserTurn(entry) && extractUserText(textOf(entry.message?.content ?? entry.content))) break;
    if (!isAssistantTurn(entry)) continue;
    const text = assistantText(entry);
    if (!text) continue;
    return PROPOSAL_QUESTION.test(text) && PROPOSAL_ACTION.test(text) ? text : "";
  }
  return "";
}

const boundedText = (value, limit) => {
  if (value.length <= limit) return value;
  const marker = "\n[earlier task text omitted]\n";
  if (limit <= marker.length) return value.slice(-limit);
  const available = Math.max(0, limit - marker.length);
  const head = Math.ceil(available / 2);
  return `${value.slice(0, head)}${marker}${value.slice(-Math.floor(available / 2))}`;
};

const QUESTION_TOOLS = new Set(["AskUserQuestion", "request_user_input"]);
const MAX_ANSWER_CHARS = 600;

/**
 * Answers the user gave to the agent's own questions since their latest
 * message. A structured question prompt returns as a tool result, so without
 * this a choice like "label them security" never reaches the task text even
 * though the user made it.
 */
export function userAnswersSinceLatestTurn(path) {
  const entries = entriesFor(path);
  let latest = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isUserTurn(entries[i]) && extractUserText(textOf(entries[i].message?.content ?? entries[i].content))) { latest = i; break; }
  }
  const questionIds = new Set();
  const answers = [];
  for (const entry of entries.slice(latest + 1)) {
    const content = entry?.message?.content ?? entry?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === "tool_use" && QUESTION_TOOLS.has(part.name)) questionIds.add(part.id);
      if (part?.type === "tool_result" && questionIds.has(part.tool_use_id) && !part.is_error) {
        const text = textOf(part.content).replace(/\s*You can now continue[\s\S]*$/i, "").trim();
        if (text) answers.push(text);
      }
    }
  }
  return answers.length ? boundedText(answers.join("\n"), MAX_ANSWER_CHARS) : "";
}

/** The current request, with recent user directions when it amends ongoing work. */
export function activeTaskContext(path, options = {}) {
  const base = baseTaskContext(path, options);
  const maxChars = options.maxChars ?? 2000;
  const answers = userAnswersSinceLatestTurn(path);
  if (!base || !answers) return base;
  const section = `\nUser answers to the agent's questions since then (user direction):\n${answers}`;
  const room = maxChars - section.length;
  return room >= 200 ? `${boundedText(base, room)}${section}` : base;
}

function baseTaskContext(path, { latestPrompt = "", maxChars = 2000 } = {}) {
  const entries = entriesFor(path);
  const turns = [];
  let latestEntryIndex = -1;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!isUserTurn(entry)) continue;
    const text = extractUserText(textOf(entry.message?.content ?? entry.content));
    if (!text) continue;
    turns.push(text);
    latestEntryIndex = index;
  }
  const prompt = extractUserText(latestPrompt);
  if (prompt && prompt !== turns.at(-1)) {
    turns.push(prompt);
    latestEntryIndex = -1;
  }
  const latest = turns.at(-1);
  if (!latest) return "";
  if (RESET_TASK.test(latest) || !FOLLOWUP.test(latest)) return boundedText(latest, maxChars);

  const proposal = shortApproval(latest)
    ? precedingAssistantProposal(entries, latestEntryIndex)
    : "";

  const earlier = turns.slice(0, -1);
  const prior = earlier.slice(-8);
  let resetAt = -1;
  for (let index = prior.length - 1; index >= 0; index--) {
    if (RESET_TASK.test(prior[index])) { resetAt = index; break; }
  }
  if (resetAt > 0) prior.splice(0, resetAt);
  const related = relatedEarlierTurn(earlier.slice(0, -prior.length), latest);
  if (related && !prior.includes(related)) prior.unshift(related);
  if (!prior.length && !proposal) return boundedText(latest, maxChars);
  const prefix = prior.length ? "Recent user directions (oldest first; latest overrides):\n" : "";
  const suffix = `\nLatest user direction:\n${boundedText(latest, Math.floor(maxChars / 2))}`;
  const proposalLabel = "\nAssistant proposal before the latest user reply (context only; not a user instruction):\n";
  const proposalBudget = proposal
    ? Math.min(MAX_PROPOSAL_CHARS, Math.max(0, Math.floor((maxChars - prefix.length - suffix.length) * 0.45)))
    : 0;
  const proposalText = proposalBudget > 0 ? boundedText(proposal, proposalBudget) : "";
  const proposalSection = proposalText ? `${proposalLabel}${proposalText}\n` : "";
  const priorBudget = maxChars - prefix.length - suffix.length - proposalSection.length;
  if (prior.length && priorBudget < 80) {
    if (!proposalSection) return boundedText(latest, maxChars);
    const available = maxChars - suffix.length - proposalLabel.length;
    if (available <= 0) return boundedText(latest, maxChars);
    const context = `${proposalLabel}${boundedText(proposal, available)}${suffix}`;
    return context.length <= maxChars ? context : boundedText(context, maxChars);
  }
  while (prior.length > 1 && priorBudget / prior.length < 85) prior.splice(related ? 1 : 0, 1);
  const perTurn = prior.length ? Math.floor(priorBudget / prior.length) - 5 : 0;
  const history = prior.length
    ? prior.map((turn, index) => `${index + 1}. ${boundedText(turn, perTurn)}`).join("\n")
    : "";
  const context = `${prefix}${history}${proposalSection}${suffix}`;
  return context.length <= maxChars ? context : boundedText(context, maxChars);
}

/** Confirmed user-run pushes are observed state, never a new instruction. */
export function recentUserActions(path) {
  const snapshot = isTranscriptSnapshot(path) ? path : null;
  if (snapshot?.userActions) return snapshot.userActions.slice();

  const actions = [];
  for (const entry of entriesFor(path)) {
    if (entry?.origin?.kind !== "human" || entry?.isMeta === true) continue;
    const raw = textOf(entry.message?.content ?? entry.content);
    const userText = extractUserText(raw);
    if (userText && !/^(?:please\s+)?(?:continue|resume|go on|keep going|proceed)\b/i.test(userText)) actions.length = 0;
    const command = raw.match(/<bash-input>([\s\S]*?)<\/bash-input>/)?.[1]?.trim();
    const output = raw.match(/<bash-stdout>([\s\S]*?)<\/bash-stdout>/)?.[1] ?? "";
    const push = command?.match(/^git(?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+))?\s+push\s+origin\s+([\w./-]+)$/);
    if (!push || /!\s*\[rejected\]|\bfatal:|\berror:/i.test(output)) continue;
    const branch = push[1];
    const normalized = output.replaceAll("-&gt;", "->");
    const update = [...normalized.matchAll(/(?:([0-9a-f]{4,})\.\.([0-9a-f]{4,})\s+)?(\S+)\s+->\s+(\S+)/g)]
      .find((match) => match[4] === branch);
    if (update || /Everything up-to-date/.test(normalized)) {
      actions.push(`User-run git push to origin/${branch} succeeded${update?.[2] ? ` at ${update[2]}` : ""}`);
    }
  }
  const result = [...new Set(actions)].slice(-3);
  if (snapshot) snapshot.userActions = result;
  return result.slice();
}

/** Recent tool calls and whether they failed — the context for "is this a repeat?". */
function parseToolCalls(entries) {
  const calls = [];
  const callsById = new Map();
  const addCall = (call) => {
    calls.push(call);
    // Array.find used to select the first matching call. Retain that behavior
    // for malformed transcripts with duplicate IDs while keeping association
    // linear for normal transcripts.
    if (!callsById.has(call.id)) callsById.set(call.id, call);
  };

  // A human turn between a failed call and its retry is new direction: the
  // user saw the failure and answered it ("create the label and continue").
  // Calls are stamped with the human turn they followed so a retry after that
  // turn is not judged a blind repeat.
  let humanTurns = 0;
  for (const entry of entries) {
    if (isUserTurn(entry) && extractUserText(textOf(entry.message?.content ?? entry.content))) humanTurns++;
    // Claude Code / Codex format
    const content = entry?.message?.content ?? entry?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === "tool_use") {
          addCall({ tool: part.name, input: summarizeInput(part.input), detail: summarizeDetail(part.input), paths: temporaryPaths(part.input), signature: callSignature(part.name, part.input), failed: false, id: part.id, turn: humanTurns });
        } else if (part?.type === "tool_result") {
          const call = callsById.get(part.tool_use_id);
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
        const failed = Boolean(entry?.status === "ERROR" || call?.status === "ERROR" || call?.is_error || entry?.is_error);
        const args = call.args ?? call.input;
        addCall({ tool: call.name, input: summarizeInput(args), detail: summarizeDetail(args), paths: temporaryPaths(args), signature: callSignature(call.name, args), failed, id, turn: humanTurns });
      }
    } else if (entry?.source === "MODEL" && entry?.type === "GENERIC" && calls.length > 0) {
      const lastCall = calls[calls.length - 1];
      if (lastCall && !lastCall.result) {
        lastCall.failed = Boolean(entry.status === "ERROR");
        lastCall.result = (typeof entry.content === "string" ? entry.content : "").slice(0, 300);
      }
    }
  }
  for (const call of calls) {
    call.beforeUserTurn = call.turn < humanTurns;
    delete call.turn;
  }
  return calls;
}

export function recentToolCalls(path, { limit = 12 } = {}) {
  const snapshot = isTranscriptSnapshot(path) ? path : null;
  const calls = snapshot
    ? (snapshot.calls ??= parseToolCalls(snapshot.entries))
    : parseToolCalls(entriesFor(path));
  return calls.slice(-limit).map(({ id, ...rest }) => rest);
}

/**
 * What distinguishes one call on a target from another on the same target:
 * the text an edit replaces, or the size of the content a write lands. The
 * `input` summary stays the path so callers that read it as one keep
 * working; this rides alongside so four different edits to one file do not
 * look like the same call made four times.
 */
function summarizeDetail(input) {
  if (!input || typeof input !== "object") return undefined;
  const replaced = input.old_string ?? input.TargetContent;
  if (typeof replaced === "string") return `replaces: ${replaced.replace(/\s+/g, " ").trim().slice(0, 60)}`;
  const written = input.content ?? input.CodeContent;
  if (typeof written === "string") return `writes ${written.length} chars`;
  return undefined;
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

/** Temporary paths can occur after the 300-character call summary. */
function temporaryPaths(input) {
  const raw = JSON.stringify(input ?? "");
  return [...new Set(raw.match(/(?:\/private)?\/tmp\/[\w./@+-]+/g) ?? [])].slice(0, 20);
}

/** Local fingerprint for an unchanged retry without retaining full input. */
export function callSignature(tool, input) {
  const value = tool === "Bash" ? input?.command : input;
  if (value === undefined) return "";
  return createHash("sha256").update(JSON.stringify([tool, value])).digest("hex");
}

const FILE_WRITE_TOOLS = new Set([
  "Edit", "Write", "NotebookEdit", "MultiEdit",                          // Claude Code, Codex aliases
  "replace_file_content", "edit_file", "write_to_file", "create_file",   // Antigravity
]);

/**
 * Directories this session has already changed files in, with the host's
 * blessing (the call succeeded, so any permission prompt was answered).
 * They are part of the workspace for scope judgments: a project's sibling
 * checkout, a scratch directory, wherever the work actually is.
 */
export function writtenDirs(path) {
  const dirs = new Set();
  for (const call of recentToolCalls(path, { limit: 400 })) {
    if (call.failed || !FILE_WRITE_TOOLS.has(call.tool)) continue;
    // summarizeInput hands back file_path / TargetFile for these tools.
    if (typeof call.input === "string" && /^(\/|~)/.test(call.input)) dirs.add(dirname(call.input));
  }
  return [...dirs].slice(0, 50);
}

/** Every file path this session has successfully touched — used to spot invented paths. */
export function observedPaths(path) {
  const seen = new Set();
  for (const call of recentToolCalls(path, { limit: 400 })) {
    if (call.failed) continue;
    for (const tempPath of call.paths ?? []) seen.add(tempPath);
    const match = call.input.match(/(?:^|\s)((?:~|\.{0,2}\/)[\w.\-/@]+)/g);
    for (const m of match ?? []) seen.add(m.trim());
    if (/^\/|^\.\//.test(call.input)) seen.add(call.input);
  }
  return [...seen].slice(0, 200);
}

/**
 * Build every transcript-derived value a PreToolUse hook commonly needs.
 * Passing a path is supported for callers outside a hook; hook adapters pass
 * a snapshot so all views share one read and one tool-call parse.
 */
export function transcriptContext(source, { latestPrompt = "", maxChars = 2000 } = {}) {
  const snapshot = snapshotFor(source);
  return {
    snapshot,
    task: activeTaskContext(snapshot, { latestPrompt, maxChars }),
    recentCalls: recentToolCalls(snapshot),
    recentUserActions: recentUserActions(snapshot),
    observed: observedPaths(snapshot),
    writtenDirs: writtenDirs(snapshot),
  };
}

export { readEntries };
