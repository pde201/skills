// ──────────────────────────────────────────────────────────────────────
//  Catch tool calls that are about to go wrong, before they run.
//
//  Two layers, in this order:
//
//    1. Code, for everything that is knowable. Does the file exist? Is the
//       string being replaced actually in it? Is this `rm -rf /`? These are
//       lookups and rules, not judgments, and a model should never be asked
//       a question that `existsSync` already answers.
//
//    2. Jev, for the rest. Whether a command matches what was actually
//       asked for, whether it is the same thing that just failed, whether
//       it destroys something nobody asked to destroy — these need semantic
//       understanding of the session, and no amount of pattern matching
//       gets there.
//
//  Fails open: no key, no network, bad response — the call proceeds.
// ──────────────────────────────────────────────────────────────────────

import { costUsd, haveKey, nouls, pickScore, systemOne } from "./client.mjs";
import { looksLikeSecretFile } from "./privacy.mjs";
import { shellSegments, readOnlyCommand, namesSecretFile } from "./shell.mjs";
import { callSignature } from "./transcript.mjs";
import { ALLOW, ASK, DENY, HAZARDS, BLAST_RADIUS_QUESTION, PHRASING } from "./guard-questions.mjs";
import { deterministicCheck } from "./guard-local.mjs";
import { workspaceRoots, changesOnlyInsideWorkspace, changesOnlyAgentOwned, worksOnlyAgentLocal } from "./workspace.mjs";
import { callProject } from "./project.mjs";
import config from "./config.mjs";

// The guard's public surface predates the split into modules; callers and
// tests still import these from here.
export { ALLOW, ASK, DENY, shellSegments, deterministicCheck, changesOnlyAgentOwned, workspaceRoots };
export { insideWorkspace, targetPaths, commandDirs } from "./workspace.mjs";
export { remoteSlug, policyExcerpt, sessionRepoDirs, projectContext, callProject } from "./project.mjs";

// Precedence when several signals fire at once: the strictest wins.
const PRECEDENCE = [DENY, ASK, ALLOW];
const strictest = (decisions) => PRECEDENCE.find((d) => decisions.includes(d)) ?? ALLOW;

// ── Which questions are worth asking ─────────────────────────────────

/** Every string value in a tool input, flattened for a text check. */
const inputText = (input) => {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";
  return Object.values(input).filter((v) => typeof v === "string").join(" ");
};

/**
 * Does this call name something path-shaped at all?
 *
 * `invented_target` asks whether the call "appears to have invented the
 * path it names". Put to a call that names no path — `npm ci`, `git
 * status`, `make` — the question presupposes something that is not there,
 * and an unanswerable question does not come back as a confident no. It
 * comes back near the middle.
 *
 * Observed live on 2026-09-21: `npm ci` scored 0.51, which clears the 0.45
 * ask threshold and interrupts the user over a path the command never
 * mentioned. No threshold fixes that — 0.51 sits below real detections
 * (0.56-0.77) but above conventional ones, so there is nowhere to put the
 * line. The question simply should not have been asked.
 *
 * This is the same lesson as the original `invented_target` rewording, one
 * step earlier: before asking whether a question is worded right, ask
 * whether it applies.
 */
export function namesAPath(input) {
  const text = inputText(input);
  if (!text) return false;
  // A slash, or a bare filename with a letter-initial extension. Digits
  // after the dot are excluded so version and image tags (`ubuntu:20.04`)
  // do not read as filenames.
  return /\//.test(text) || /\b[\w.\-@+]+\.[A-Za-z]\w{0,7}\b/.test(text);
}

/**
 * Is the newest earlier run of this same call a failure? A failure the user
 * has since answered with a new message is not a blind retry: the human turn
 * is the "change that would fix the cause".
 */
function retriesAFailure(call, recentCalls) {
  const signature = callSignature(call.toolName, call.input);
  const lastSameCall = [...(recentCalls ?? [])].reverse().find((recent) => {
    if (recent?.tool !== call.toolName) return false;
    if (recent.signature) return recent.signature === signature;
    // Synthetic and legacy callers may only supply an untruncated Bash command.
    return call.toolName === "Bash" && recent.input === call.input?.command;
  });
  return lastSameCall?.failed === true && !lastSameCall.beforeUserTurn;
}

/**
 * The batch for one call. Questions that do not apply to it are left out
 * rather than asked and filtered afterwards: a question that cannot apply
 * has no right answer to threshold against.
 *
 * Omitting one changes no other answer — questions batched over a single
 * state are scored independently — so this only removes noise.
 *
 * @param {{toolName?: string, input?: any, cwd?: string}} [call] omit to get every question
 * @param {string[]} [roots] the workspace, from workspaceRoots(); omit to always ask about scope
 * @param {object[]} [recentCalls] recent calls with failure status
 */
export function guardQuestions(call, roots, recentCalls) {
  const questions = { blast_radius: BLAST_RADIUS_QUESTION };
  for (const [id, { question, needsPath, needsOutsideWorkspace }] of Object.entries(HAZARDS)) {
    if (id === "repeat_failure" && call && !retriesAFailure(call, recentCalls)) continue;
    if (needsPath && call && !namesAPath(call.input)) continue;
    if (needsOutsideWorkspace && call && roots && changesOnlyInsideWorkspace(call, roots)) continue;
    if (id === "intent_mismatch" && call && changesOnlyAgentOwned(call)) continue;
    if (id === "underspecified_target" && call && worksOnlyAgentLocal(call)) continue;
    questions[id] = question;
  }
  return questions;
}

// Below this reach the call changes nothing — it only looks.
const CHANGES_SOMETHING = 1;

// Hazards whose borderline judgments become advice rather than prompts.
const SOFTENABLE = new Set(["intent_mismatch", "wrong_scope", "invented_target", "repeat_failure"]);

/**
 * Probabilities and reach in, a decision out. Pure and exported so the
 * thresholds can be tested offline: this is the part that a live run was
 * previously the only way to exercise, which is how a false positive got
 * as far as it did.
 *
 * @returns {{decision: string, fired: Record<string, number>}}
 */
export function decide(probabilities, radius) {
  const triggered = [];
  const fired = {};

  for (const [hazard, probability] of Object.entries(probabilities)) {
    const { action, actsOnRead, askEvenWhenWide } = HAZARDS[hazard] ?? {};
    if (!action) continue;
    let level = null;
    if (probability >= config.guardDenyAt) level = action;
    else if (probability >= config.guardAskAt) level = ASK;
    if (!level) continue;
    triggered.push({ hazard, level, actsOnRead: Boolean(actsOnRead), askEvenWhenWide: Boolean(askEvenWhenWide) });
    fired[hazard] = probability;
  }

  // A call that changes nothing is cheap to be wrong about. A read of the
  // wrong file, or of a path that was guessed, fails or wastes a few
  // tokens and the model corrects itself without anyone being asked. The
  // cost of prompting anyway is not the one prompt: it is that being
  // interrupted over things that did not matter teaches you to wave
  // through the one that does.
  //
  // So on a read-only call, only hazards marked `actsOnRead` speak, and
  // there are exactly two reasons to earn that mark:
  //
  //   · the damage is done by reading — `secret_exposure`, because a
  //     printed key has already been printed by the time a prompt could
  //     be answered; and
  //   · the hazard is itself evidence that the premise above is false —
  //     `repeat_failure`, because a call repeating one that just failed
  //     is the model not correcting itself.
  //
  // The rest cannot honestly fire on a read at all — a call that changes
  // nothing has destroyed nothing, and reading outside the project is
  // explicitly not `wrong_scope` — so suppressing them removes false
  // positives rather than coverage.
  //
  // This gate only ever sees calls that reached the judgment layer. The
  // deterministic checks run first and return early, so `rm -rf /`, a
  // force push and the rest of CATASTROPHIC still ask no matter what
  // reach Jev assigned.
  if ((radius?.score ?? 0) < CHANGES_SOMETHING) {
    const speaking = triggered.filter((t) => t.actsOnRead);

    // Allowed — but hand back what was set aside rather than dropping it.
    // A hazard suppressed silently is a hazard nobody can tune: the log is
    // the only trace of a judgment that never became a prompt, and a
    // suppression that turns out to be wrong is invisible without it.
    if (!speaking.length) return { decision: ALLOW, fired: {}, suppressed: { ...fired } };

    const kept = {};
    const setAside = {};
    for (const [hazard, probability] of Object.entries(fired)) {
      if (speaking.some((t) => t.hazard === hazard)) kept[hazard] = probability;
      else setAside[hazard] = probability;
    }
    return {
      decision: strictest(speaking.map((t) => t.level)),
      fired: kept,
      ...(Object.keys(setAside).length ? { suppressed: setAside } : {}),
    };
  }

  // Reach is a multiplier, not a hazard of its own: something already
  // suspicious that also touches shared state is not a question to wave
  // through, but a wide-reaching call that trips nothing is just a deploy.
  // A hazard marked `askEvenWhenWide` is the exception: its fix is an answer
  // from the user, which a refusal never asks for.
  const wideReaching = (radius?.score ?? 0) >= config.guardBlastRadiusBlock;

  // Just over the ask line, a judgment is a lean, not a finding: two thirds
  // of asks on real sessions sat below 0.60, and most were the task itself.
  // An ask there costs a prompt — and in auto mode, where asks become
  // refusals, a blocked step. So a borderline call on hazards that cannot
  // lose work goes through with the concern handed to the model instead.
  // Never for destruction or exposure, and never for wide-reaching calls.
  const soft = triggered.length > 0 && !wideReaching && triggered.every((t) =>
    t.level === ASK && SOFTENABLE.has(t.hazard) && fired[t.hazard] < config.guardSoftUntil);
  if (soft) return { decision: ALLOW, fired: {}, advisory: { ...fired } };
  const decision = strictest(triggered.map((t) =>
    (wideReaching && t.level === ASK && !t.askEvenWhenWide ? DENY : t.level)));

  return { decision, fired };
}

/**
 * @returns {Promise<{decision: string, reason: string, by: string, signals?: object, cost?: number}>}
 */
export async function guard({ toolName, input, cwd, task, recentCalls, recentUserActions, userCommands, observed, hostRoots, writtenDirs, model } = {}) {
  const pass = (reason) => ({ decision: ALLOW, reason, by: "code" });
  const promptLabel = (decision, source) =>
    `Jev ${decision === ASK ? "approval request" : "blocked call"} (${source}):`;

  const deterministic = deterministicCheck(toolName, input);
  if (deterministic) return { ...deterministic, reason: `${promptLabel(deterministic.decision, "local check")} ${deterministic.reason}` };

  if (!config.guard) return pass("guard disabled");

  // A Read changes nothing, and the read-only gate below would suppress
  // every hazard but two anyway. The one that lands on read — exposing a
  // credential — is a fact about the path, so code asks it: a model round
  // trip on every file the agent looks at bought nothing on real sessions
  // (26 of 26 allowed) and cost ~300 ms each.
  if (toolName === "Read" && !config.guardReadsWithModel) {
    const path = input?.file_path;
    if (looksLikeSecretFile(path)) {
      return { decision: ASK, reason: `${promptLabel(ASK, "local check")} ${path} usually holds credentials. Confirm before it is read.`, by: "code" };
    }
    return pass("read-only tool: deterministic checks only");
  }

  // The same trade for a shell command that only reads, as long as neither
  // hazard that speaks on a read could: a credential file sends it to the
  // model, and so does a rerun of the same command that just failed.
  if (toolName === "Bash" && !config.guardReadsWithModel && readOnlyCommand(input?.command)
    && !namesSecretFile(input.command) && !retriesAFailure({ toolName, input }, recentCalls)) {
    return pass("read-only shell command: deterministic checks only");
  }

  if (!haveKey()) return pass("no api key");

  const agentMemoryDirs = (observed ?? [])
    .map((path) => typeof path === "string" ? path.match(/^(.*\/\.claude\/projects\/[^/]+\/memory)(?:\/.*)?$/)?.[1] : null)
    .filter(Boolean);
  const roots = workspaceRoots({ cwd, hostRoots, writtenDirs: [...(writtenDirs ?? []), ...agentMemoryDirs] });
  const questions = guardQuestions({ toolName, input, cwd }, roots, recentCalls);
  // A question that was never asked is not a hazard that stayed quiet, and
  // the log has to be able to tell those apart — otherwise a question this
  // gate has silently stopped asking looks exactly like one that is asking
  // and finding nothing.
  const skippedQuestions = Object.keys(HAZARDS).filter((id) => !(id in questions));

  const project = callProject({ toolName, input, cwd }, recentCalls, userCommands);
  const segments = toolName === "Bash" ? shellSegments(input?.command) : [];

  let res;
  try {
    res = await systemOne({
      model: model ?? config.model,
      state: {
        task: task || "(not stated)",
        cwd: cwd || process.cwd(),
        workspace_roots: roots,
        ...(project.remotes.length ? { project_remotes: project.remotes } : {}),
        ...(project.policy ? { project_policy: project.policy } : {}),
        call: { tool: toolName, input },
        ...(segments.length ? { call_segments: segments } : {}),
        recent_calls: (recentCalls ?? []).map(({ signature: _signature, paths: _paths, beforeUserTurn: _turn, ...recent }) => recent),
        recent_user_actions: recentUserActions ?? [],
        paths_seen_this_session: observed ?? [],
      },
      questions,
    });
  } catch (err) {
    return pass(`jev unavailable: ${err.message}`);
  }

  const probabilities = nouls(res, Object.keys(HAZARDS));
  const radius = pickScore(res, "blast_radius");
  const { decision, fired, suppressed, advisory } = decide(probabilities, radius);
  const hasAdvisory = advisory && Object.keys(advisory).length > 0;

  return {
    decision,
    reason: decision === ALLOW ? "" : `${promptLabel(decision, "model estimate")} ${explain(fired, radius, decision)}`,
    // A borderline concern that did not become a prompt, worded for the
    // model: it proceeds, but should check the step against the request.
    ...(hasAdvisory ? { advisory: `Jev note (borderline, not blocked): ${explain(advisory, radius, ASK)} If this step is not what the user asked for, stop and check with them.` } : {}),
    by: "jev",
    // Everything Jev said, including what fell below the thresholds. The
    // signals below carry only what fired, which is right for explaining a
    // decision to someone and wrong for tuning: a log that records only
    // what crossed the line can justify raising a threshold and can never
    // justify lowering one, so a hazard that is quietly missing everything
    // stays missing.
    probabilities,
    signals: {
      ...fired,
      ...(suppressed && Object.keys(suppressed).length ? { suppressed } : {}),
      ...(hasAdvisory ? { advisory } : {}),
      ...(skippedQuestions.length ? { not_asked: skippedQuestions } : {}),
      blast_radius: radius?.score,
      blast_radius_label: radius?.legend?.[String(Math.round(radius?.score ?? 0))],
    },
    usage: res.usage,
    cost: costUsd(res.usage),
  };
}

function explain(fired, radius, decision) {
  if (decision === ALLOW) return "";
  const parts = Object.entries(fired)
    .sort((a, b) => b[1] - a[1])
    .map(([hazard, p]) => `${PHRASING[hazard]} (${p.toFixed(2)})`);
  const reach = radius?.legend?.[String(Math.round(radius.score))];
  const tail = reach ? ` Reach: ${reach.toLowerCase()}.` : "";
  return `This call ${parts.join("; ")}.${tail}`;
}
