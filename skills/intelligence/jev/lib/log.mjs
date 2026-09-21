// ──────────────────────────────────────────────────────────────────────
//  A decision log. Thresholds picked in the abstract are guesses; this is
//  what turns them into something you can tune against your own sessions.
//  One JSON object per line, appended, never read by the hooks themselves.
// ──────────────────────────────────────────────────────────────────────

import { join } from "node:path";
import { homedir } from "node:os";
import config from "./config.mjs";
import { appendPrivateFile, ensurePrivateDir, redactLogRecord } from "./privacy.mjs";

export function stateDir() {
  const dir = process.env.JEV_STATE_DIR || join(homedir(), ".local", "state", "jev-hooks");
  return ensurePrivateDir(dir);
}

export function logDecision(record) {
  try {
    const path = config.logPath || join(stateDir(), "jev-log.jsonl");
    const safeRecord = redactLogRecord({ at: new Date().toISOString(), ...record });
    appendPrivateFile(path, JSON.stringify(safeRecord) + "\n");
  } catch {
    // A hook must never fail because it could not write its own log.
  }
}
