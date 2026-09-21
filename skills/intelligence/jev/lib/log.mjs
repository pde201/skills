// ──────────────────────────────────────────────────────────────────────
//  A decision log. Thresholds picked in the abstract are guesses; this is
//  what turns them into something you can tune against your own sessions.
//  One JSON object per line, appended, never read by the hooks themselves.
// ──────────────────────────────────────────────────────────────────────

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import config from "./config.mjs";

export function stateDir() {
  const dir = process.env.JEV_STATE_DIR || join(homedir(), ".local", "state", "jev-hooks");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function logDecision(record) {
  try {
    const path = config.logPath || join(stateDir(), "jev-log.jsonl");
    appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n", "utf8");
  } catch {
    // A hook must never fail because it could not write its own log.
  }
}
