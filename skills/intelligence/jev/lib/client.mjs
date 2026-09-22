// ──────────────────────────────────────────────────────────────────────
//  Minimal TypeSafe (Jev) client — no dependencies, Node 18+ built-in fetch.
//
//  Deliberately not the official SDK: these hooks run on every tool call in
//  every Claude Code session, so they must work on a fresh machine with
//  nothing but `node` on PATH. One file you can read end to end.
//
//  Docs: https://docs.typesafe.ai/api.md
// ──────────────────────────────────────────────────────────────────────

import { redactState } from "./privacy.mjs";

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
  let body;
  try {
    // State and question instructions can contain tool input or free text.
    // Keep the original values local, and send only the redacted copy.
    body = JSON.stringify({ state: redactState(state), model, questions: redactState(questions) });
  } catch (err) {
    throw new JevUnavailable("TypeSafe request could not be serialized", err);
  }
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

      if (res.ok) {
        let response;
        try {
          response = await res.json();
        } catch (err) {
          throw new JevUnavailable("TypeSafe response was not valid JSON", err);
        }
        return validateResponse(response, questions);
      }

      // Provider error bodies may echo sensitive input. A status is sufficient
      // to diagnose the response class without sending echoed data to logs.
      if (res.status !== 429 && res.status < 500) {
        throw new JevUnavailable(`TypeSafe ${res.status}`);
      }
      lastError = new JevUnavailable(`TypeSafe ${res.status}`);
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

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const invalidResponse = (where, reason) => {
  throw new JevUnavailable(`Invalid TypeSafe response${where ? ` (${where})` : ""}: ${reason}`);
};

const finiteProbability = (value, where) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    invalidResponse(where, "probability must be a finite number from 0 to 1");
  }
};

const validateConfidence = (value, where) => {
  if (value !== undefined) finiteProbability(value, `${where}.confidence`);
};

const validateProbabilityMap = (probabilities, allowed, where) => {
  if (!isRecord(probabilities)) invalidResponse(where, "probabilities must be an object");
  const expected = new Set(allowed);
  const keys = Object.keys(probabilities);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    invalidResponse(`${where}.probabilities`, "contains a missing or unknown option");
  }
  for (const key of keys) finiteProbability(probabilities[key], `${where}.probabilities.${key}`);
  const total = keys.reduce((sum, key) => sum + probabilities[key], 0);
  if (Math.abs(total - 1) > 0.01) invalidResponse(`${where}.probabilities`, "probabilities must sum to 1");
};

const validateNoul = (answer, where) => {
  if (!isRecord(answer) || answer.type !== "noul") invalidResponse(where, "expected a noul answer");
  finiteProbability(answer.noul, `${where}.noul`);
};

const validateChoice = (answer, question, where) => {
  const options = isRecord(question.criteria) ? Object.keys(question.criteria) : [];
  if (!options.length || options.length > 255) invalidResponse(`${where}.question`, "choice criteria are invalid");
  if (!isRecord(answer) || answer.type !== "choice") invalidResponse(where, "expected a choice answer");
  if (typeof answer.choice !== "string" || !options.includes(answer.choice)) {
    invalidResponse(`${where}.choice`, "choice is not one of the requested options");
  }
  validateProbabilityMap(answer.probabilities, options, where);
  validateConfidence(answer.confidence, where);
};

const validateScore = (answer, question, where) => {
  const levels = Array.isArray(question.criteria) ? question.criteria : [];
  if (levels.length < 2 || levels.length > 10) invalidResponse(`${where}.question`, "score criteria must have 2 to 10 levels");
  if (!isRecord(answer) || answer.type !== "score") invalidResponse(where, "expected a score answer");
  if (typeof answer.score !== "number" || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > levels.length - 1) {
    invalidResponse(`${where}.score`, `must be finite and within 0 to ${levels.length - 1}`);
  }

  if (!isRecord(answer.legend)) invalidResponse(`${where}.legend`, "legend must be an object");
  const levelIds = levels.map((_, index) => String(index));
  if (Object.keys(answer.legend).length !== levelIds.length || levelIds.some((id) => typeof answer.legend[id] !== "string")) {
    invalidResponse(`${where}.legend`, "does not describe every score level");
  }
  validateProbabilityMap(answer.probabilities, levelIds, where);
  validateConfidence(answer.confidence, where);
};

/**
 * Validate a TypeSafe response against the questions that produced it.
 * Every requested answer is required, and option/rubric identifiers are
 * checked before any caller is allowed to use the response.
 */
export function validateResponse(response, questions) {
  if (!isRecord(response)) invalidResponse("root", "response must be an object");
  if (!isRecord(response.answers)) invalidResponse("answers", "answers must be an object");
  if (!isRecord(questions) || Object.keys(questions).length === 0) return response;

  for (const [id, question] of Object.entries(questions)) {
    if (!Object.hasOwn(response.answers, id)) invalidResponse(`answers.${id}`, "answer is missing");
    if (!isRecord(question) || typeof question.type !== "string") invalidResponse(`questions.${id}`, "question is malformed");
    const answer = response.answers[id];
    if (question.type === "noul") validateNoul(answer, `answers.${id}`);
    else if (question.type === "choice") validateChoice(answer, question, `answers.${id}`);
    else if (question.type === "score") validateScore(answer, question, `answers.${id}`);
    else invalidResponse(`questions.${id}`, `unsupported question type ${question.type}`);
  }
  return response;
}

export function nouls(response, ids) {
  const out = {};
  for (const id of ids) {
    const a = response.answers?.[id];
    if (a && a.type === "noul" && typeof a.noul === "number" && Number.isFinite(a.noul) && a.noul >= 0 && a.noul <= 1) {
      out[id] = a.noul;
    }
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
    .filter(([, probability]) => typeof probability === "number" && Number.isFinite(probability) && probability >= 0 && probability <= 1)
    .sort((x, y) => y[1] - x[1])
    .map(([option, probability]) => ({ option, probability }));
}

export function costUsd(usage) {
  // $0.042 per million input tokens; output is free.
  return ((usage?.input_tokens ?? 0) / 1e6) * 0.042;
}
