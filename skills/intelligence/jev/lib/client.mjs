// ──────────────────────────────────────────────────────────────────────
//  Minimal TypeSafe (Jev) client — no dependencies, Node 18+ built-in fetch.
//
//  Deliberately not the official SDK: these hooks run on every tool call in
//  every Claude Code session, so they must work on a fresh machine with
//  nothing but `node` on PATH. One file you can read end to end.
//
//  Docs: https://docs.typesafe.ai/api.md
// ──────────────────────────────────────────────────────────────────────

export const ENDPOINT = process.env.TYPESAFE_BASE_URL
  ? `${process.env.TYPESAFE_BASE_URL.replace(/\/+$/, "")}/v1/systemone`
  : "https://api.typesafe.ai/v1/systemone";

export const DEFAULT_MODEL = process.env.JEV_MODEL || "jev-latest";

/** Thrown for anything that should make a hook fail open rather than block. */
export class JevUnavailable extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "JevUnavailable";
    this.cause = cause;
  }
}

export function apiKey() {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new JevUnavailable("TYPESAFE_API_KEY is not set");
  return key;
}

export function haveKey() {
  return Boolean(process.env.TYPESAFE_API_KEY);
}

// ── Question constructors ────────────────────────────────────────────
// Mirrors the HTTP contract exactly. `criteria` is optional for noul,
// required for choice (option -> description|null) and score (ordered array).

export const noul = (instructions, criteria) =>
  criteria ? { type: "noul", instructions, criteria } : { type: "noul", instructions };

export const choice = (instructions, criteria) => ({ type: "choice", instructions, criteria });

export const score = (instructions, criteria) => ({ type: "score", instructions, criteria });

// ── The one call ─────────────────────────────────────────────────────

/**
 * Ask a batch of independent judgments about one state.
 *
 * Every question is scored on its own against the state, so batching costs
 * one request instead of N and does not change any answer. Batching is the
 * default here for exactly that reason.
 *
 * @param {object} opts
 * @param {string|object|Array} opts.state
 * @param {Record<string, object>} opts.questions
 * @param {string}  [opts.model]
 * @param {number}  [opts.timeoutMs]
 * @param {number}  [opts.retries]  retries on timeout / 5xx / 429 only
 * @returns {Promise<{model: string, answers: object, usage: object}>}
 */
export async function systemOne({
  state,
  questions,
  model = DEFAULT_MODEL,
  timeoutMs = Number(process.env.JEV_TIMEOUT_MS || 4000),
  retries = Number(process.env.JEV_RETRIES || 1),
} = {}) {
  if (!questions || Object.keys(questions).length === 0) {
    return { model, answers: {}, usage: { input_tokens: 0, output_tokens: 0 } };
  }

  const key = apiKey();
  const body = JSON.stringify({ state, model, questions });
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body,
        signal: controller.signal,
      });

      if (res.ok) return await res.json();

      const detail = (await res.text().catch(() => "")).slice(0, 400);
      // 4xx other than 429 is our bug — a bad question or oversized state.
      // Retrying cannot help, so surface it immediately.
      if (res.status !== 429 && res.status < 500) {
        throw new JevUnavailable(`TypeSafe ${res.status}: ${detail}`);
      }
      lastError = new JevUnavailable(`TypeSafe ${res.status}: ${detail}`);
    } catch (err) {
      if (err instanceof JevUnavailable && !/^TypeSafe 5|429/.test(err.message)) throw err;
      lastError = err;
    } finally {
      clearTimeout(timer);
    }

    if (attempt < retries) await sleep(120 * 2 ** attempt);
  }

  throw new JevUnavailable("TypeSafe request failed", lastError);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Answer accessors ─────────────────────────────────────────────────
// Answers are typed; reading the wrong field silently yields undefined,
// so go through these and get a clear failure instead.

export function nouls(response, ids) {
  const out = {};
  for (const id of ids) {
    const a = response.answers?.[id];
    if (a && typeof a.noul === "number") out[id] = a.noul;
  }
  return out;
}

export function pickChoice(response, id) {
  const a = response.answers?.[id];
  if (!a || a.type !== "choice") return null;
  return { choice: a.choice, confidence: a.confidence ?? 0, probabilities: a.probabilities ?? {} };
}

export function pickScore(response, id) {
  const a = response.answers?.[id];
  if (!a || a.type !== "score") return null;
  return {
    score: a.score ?? 0,
    confidence: a.confidence ?? 0,
    legend: a.legend ?? {},
    probabilities: a.probabilities ?? {},
  };
}

/** Options sorted by probability, highest first. */
export function ranked(response, id) {
  const a = response.answers?.[id];
  if (!a?.probabilities) return [];
  return Object.entries(a.probabilities)
    .sort((x, y) => y[1] - x[1])
    .map(([option, probability]) => ({ option, probability }));
}

export function costUsd(usage) {
  // $0.042 per million input tokens; output is free.
  return ((usage?.input_tokens ?? 0) / 1e6) * 0.042;
}
