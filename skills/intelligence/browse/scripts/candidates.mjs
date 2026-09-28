// ──────────────────────────────────────────────────────────────────────
//  From a page snapshot to the Candidates the Driver may choose from.
//
//  Everything here is code, not judgment: what a Candidate is allowed to
//  be must not depend on the model that page text can steer. On an
//  untrusted origin a Consequential control is never offered, so no
//  amount of injected text can make the Driver press it.
// ──────────────────────────────────────────────────────────────────────

import { originOf } from "./origins.mjs";

// `- role "name" [k=v, flag]: value`, indented by nesting.
const LINE = /^\s*- ([\w-]+)(?: "((?:[^"\\]|\\.)*)")?(?: \[([^\]]*)\])?(?::\s*(.*))?$/;

/** Parse agent-browser's `snapshot -i` text into elements that carry a ref. */
export function parseSnapshot(text = "") {
  const elements = [];
  for (const line of String(text).split("\n")) {
    const m = LINE.exec(line);
    if (!m) continue;
    const attrs = {};
    for (const part of (m[3] ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
      const eq = part.indexOf("=");
      if (eq === -1) attrs[part] = true;
      else attrs[part.slice(0, eq)] = part.slice(eq + 1);
    }
    if (!attrs.ref) continue;
    elements.push({
      ref: attrs.ref,
      role: m[1],
      name: (m[2] ?? "").replace(/\\(.)/g, "$1").trim(),
      attrs,
      value: m[4]?.trim(),
    });
  }
  return elements;
}

const CLICKABLE = new Set(["link", "button", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "treeitem"]);
const TOGGLES = new Set(["checkbox", "radio", "switch"]);
const TYPEABLE = new Set(["textbox", "searchbox"]);

// Labels whose effect usually outlasts the page. Deliberately broad: on an
// untrusted origin a false positive costs one Handback, a false negative
// costs whatever the button does.
const CONSEQUENTIAL_LABEL = /\b(buy|purchase|pay|payment|checkout|check out|order|subscribe|donate|send|post|publish|tweet|reply|comment|submit|delete|remove|destroy|erase|discard|archive|sign ?out|log ?out|transfer|withdraw|confirm|approve|authori[sz]e|grant|agree|accept|install|uninstall|upgrade|downgrade|cancel|deactivate|share|invite|follow|unfollow|like|upload|download|save|merge|deploy|revoke)\b/i;

// Driver controls. Handback controls end the Run and need no confidence
// floor: returning control is always safe.
export const CONTROLS = {
  DONE: "The goal's result is visibly present on the page now.",
  BLOCKED: "No offered action can make progress toward the goal.",
  WAIT: "The page is still loading; wait briefly.",
  SCROLL_DOWN: "Scroll down to reveal more of the page.",
  SCROLL_UP: "Scroll up.",
  ESCAPE: "Press Escape to dismiss a dialog or menu.",
};
export const HANDBACK_CONTROLS = new Set(["DONE", "BLOCKED", "NEEDS_INPUT", "CONSEQUENTIAL"]);

const quote = (s) => `"${s}"`;

/**
 * Why an element is a Consequential control on an untrusted origin, or
 * null. `formRefs` are refs inside a <form>; `types` maps ref → the
 * element's `type` attribute (null when absent).
 */
export function consequentialReason(element, { pageOrigin, formRefs, types }) {
  if (CONSEQUENTIAL_LABEL.test(element.name)) return "label";
  if (element.role === "link" && element.attrs.url) {
    if (/^javascript:/i.test(element.attrs.url)) return "script link";
    let target = null;
    try {
      target = originOf(new URL(element.attrs.url, pageOrigin || undefined).href);
    } catch {
      return "unclear destination";
    }
    if (target !== pageOrigin) return "leads to another origin";
  }
  if (element.role === "button" && formRefs.has(element.ref)) {
    // A <button> in a form submits it unless it says otherwise.
    const type = types.get(element.ref);
    if (type !== "button" && type !== "reset") return "submits a form";
  }
  return null;
}

/**
 * Build one step's Candidates.
 *
 * @param {object} page
 * @param {string} page.snapshot   `snapshot -i --urls` text
 * @param {string} page.origin
 * @param {Set<string>} page.formRefs
 * @param {Map<string, string|null>} page.types
 * @param {object} opts
 * @param {boolean} opts.trusted          the page's origin is a Trusted origin
 * @param {boolean} opts.secretsAllowed   Secret values may be typed on this origin
 * @param {{name: string, secret: boolean}[]} opts.values  Named values (names only)
 * @param {number} opts.limit             most options one question may carry
 * @returns {{options: Record<string, string>, actions: Record<string, object>, withheld: string[], omitted: number}}
 */
export function buildCandidates(page, { trusted, secretsAllowed, values = [], limit = 255 }) {
  const elements = parseSnapshot(page.snapshot);
  const withheld = [];
  const actions = [];
  const unfillable = [];

  for (const element of elements) {
    if (!element.name) continue;
    const isClick = CLICKABLE.has(element.role);
    const isToggle = TOGGLES.has(element.role);
    const isType = TYPEABLE.has(element.role);
    if (!isClick && !isToggle && !isType) continue;

    if (!trusted && (isClick || isToggle)) {
      const why = consequentialReason(element, { pageOrigin: page.origin, formRefs: page.formRefs, types: page.types });
      if (why) {
        withheld.push(`${element.role} ${quote(element.name)} (${why})`);
        continue;
      }
    }

    if (isClick) {
      actions.push({ label: `Click ${element.role} ${quote(element.name)}`, kind: "click", ref: element.ref });
    } else if (isToggle) {
      const state = element.attrs.checked === "true" || element.attrs.checked === true ? "on" : "off";
      actions.push({ label: `Toggle ${element.role} ${quote(element.name)} (now ${state})`, kind: "click", ref: element.ref });
    } else {
      const password = page.types.get(element.ref) === "password";
      const before = actions.length;
      for (const value of values) {
        // A Secret value goes only into a password field, and only where
        // secrets are allowed; an ordinary value never goes into one.
        if (value.secret !== password) continue;
        if (value.secret && !secretsAllowed) continue;
        actions.push({
          label: `Type value ${quote(value.name)} into ${element.role} ${quote(element.name)}`,
          kind: "type",
          ref: element.ref,
          value: value.name,
        });
      }
      if (actions.length === before) unfillable.push(`${element.role} ${quote(element.name)}`);
    }
  }

  // Two identical labels cannot be told apart by the Driver: offer neither.
  const counts = new Map();
  for (const a of actions) counts.set(a.label, (counts.get(a.label) ?? 0) + 1);
  const distinct = actions.filter((a) => counts.get(a.label) === 1);

  const controls = { ...CONTROLS };
  if (trusted) controls.ENTER = "Press Enter.";
  // Whether a field has a value to type is known here, so the Driver is
  // only offered NEEDS_INPUT when it can be true.
  if (unfillable.length) {
    controls.NEEDS_INPUT = `The goal needs text in one of these fields, for which the agent gave no value: ${unfillable.slice(0, 12).join("; ")}.`;
  }
  if (withheld.length) {
    controls.CONSEQUENTIAL = `Every useful next action is one of these controls, which only the agent may use: ${withheld.slice(0, 12).join("; ")}.`;
  }

  const room = Math.max(0, limit - Object.keys(controls).length);
  const kept = distinct.slice(0, room);
  const omitted = distinct.length - kept.length;
  if (omitted) controls.SCROLL_DOWN = `${CONTROLS.SCROLL_DOWN} ${omitted} further actions were not offered this step.`;

  const options = {};
  const byId = {};
  kept.forEach((action, i) => {
    options[`a${i}`] = action.label;
    byId[`a${i}`] = action;
  });
  Object.assign(options, controls);
  return { options, actions: byId, withheld, omitted };
}
