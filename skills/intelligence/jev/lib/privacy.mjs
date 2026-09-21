// -----------------------------------------------------------------------------
// Small, dependency-free privacy and private-file helpers used by the Jev
// client, slimmer, and decision log.
//
// Redaction is deliberately best effort. It catches the sensitive shapes this
// layer knows about, but it is not a complete PII detector and must not be
// described as one.
// -----------------------------------------------------------------------------

import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

export const REDACTED = "[REDACTED]";

const SENSITIVE_KEY_NAMES = new Set([
  "accesskey",
  "accesstoken",
  "apikey",
  "authorization",
  "authtoken",
  "bankaccount",
  "clientsecret",
  "cookie",
  "credential",
  "credentials",
  "idtoken",
  "password",
  "passphrase",
  "passwd",
  "privatekey",
  "refreshkey",
  "refreshtoken",
  "routingnumber",
  "secret",
  "secrets",
  "sessiontoken",
  "setcookie",
  "socialsecuritynumber",
  "ssn",
  "taxid",
  "token",
]);

const PEM_PRIVATE_KEY = /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/gi;
const CREDENTIAL_ASSIGNMENT = /((?:^|[^a-z0-9])(?:api[\s_-]?key|access[\s_-]?token|auth(?:orization)?|client[\s_-]?secret|credential|password|passwd|passphrase|private[\s_-]?key|refresh[\s_-]?token|secret|session[\s_-]?token)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;\]}]+)/gi;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const URL_CREDENTIAL = /([a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:)[^\s/@]+@/gi;
// Covers the common hyphenated, spaced, and contiguous nine-digit forms.
const SSN_SHAPED = /\b\d{3}(?:[- ]?\d{2})[- ]?\d{4}\b/g;

const normalizedKey = (key) => String(key).replace(/[^a-z0-9]/gi, "").toLowerCase();

/** Return true when an object field name conventionally carries secret data. */
export function isSensitiveKey(key) {
  const normalized = normalizedKey(key);
  return SENSITIVE_KEY_NAMES.has(normalized)
    || normalized.endsWith("apikey")
    || normalized.endsWith("accesstoken")
    || normalized.endsWith("authtoken")
    || normalized.endsWith("clientsecret")
    || normalized.endsWith("credential")
    || normalized.endsWith("password")
    || normalized.endsWith("privatekey")
    || normalized.endsWith("refreshtoken")
    || normalized.endsWith("secret")
    || normalized.endsWith("token")
    || normalized === "socialsecurity";
}

/** Redact known secret and SSN-shaped material from free text. */
export function redactText(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(PEM_PRIVATE_KEY, REDACTED)
    .replace(BEARER_TOKEN, `Bearer ${REDACTED}`)
    .replace(CREDENTIAL_ASSIGNMENT, `$1${REDACTED}`)
    .replace(URL_CREDENTIAL, `$1${REDACTED}@`)
    .replace(SSN_SHAPED, REDACTED);
}

function redact(value, seen, key) {
  if (key !== undefined && isSensitiveKey(key)) return REDACTED;
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;

  // State sent to the API should be JSON-shaped. A cycle cannot be serialized
  // safely, so make the problematic branch harmless instead of echoing it.
  if (seen.has(value)) return REDACTED;
  seen.add(value);

  if (Array.isArray(value)) return value.map((entry) => redact(entry, seen));

  const out = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    out[childKey] = redact(childValue, seen, childKey);
  }
  return out;
}

/** Deep-copy a value while redacting sensitive fields and free-text patterns. */
export function redactSensitive(value) {
  return redact(value, new WeakSet());
}

// More explicit aliases for callers that are handling a request or a log.
export const redactState = redactSensitive;
export const redactLogRecord = redactSensitive;

/** Make a directory private for state or temporary output. */
export function ensurePrivateDir(directory) {
  try {
    const entry = lstatSync(directory);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`Private state path is not a directory: ${directory}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  // chmod also fixes the mode when the directory already existed. The caller
  // controls the path; do not use this on a broad shared directory.
  chmodSync(directory, 0o700);
  return directory;
}

/** Create a fresh owner-only temporary directory with an unpredictable name. */
export function createPrivateTempDir(prefix = "jev-") {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  return ensurePrivateDir(directory);
}

/** Write a file with owner-only permissions, including when it already exists. */
export function writePrivateFile(filePath, contents, { encoding = "utf8" } = {}) {
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW || 0);
  const fd = openSync(filePath, flags, 0o600);
  try {
    const data = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents), encoding);
    writeSync(fd, data, 0, data.length);
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
  return filePath;
}

/** Append to an owner-only file, preserving its private mode on every write. */
export function appendPrivateFile(filePath, contents, { encoding = "utf8" } = {}) {
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | (fsConstants.O_NOFOLLOW || 0);
  const fd = openSync(filePath, flags, 0o600);
  try {
    const data = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents), encoding);
    writeSync(fd, data, 0, data.length);
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
  return filePath;
}
