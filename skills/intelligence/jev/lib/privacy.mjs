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
// A value is anything up to the next delimiter — unless an earlier pattern
// already replaced it, which the lookahead leaves alone.
const CREDENTIAL_ASSIGNMENT = /((?:^|[^a-z0-9])(?:api[\s_-]?key|access[\s_-]?token|auth(?:orization)?|client[\s_-]?secret|credential|password|passwd|passphrase|private[\s_-]?key|refresh[\s_-]?token|secret|session[\s_-]?token|token)\b\s*[:=]\s*)(?!\[REDACTED\])(?:"[^"]*"|'[^']*'|[^\s,;\]}]+)/gi;
// Environment-style names: AWS_SECRET_ACCESS_KEY=…, GITHUB_TOKEN=…, DB_PASSWORD: ….
// The word list above needs a word boundary after the keyword, which an
// underscore defeats, so upper-case compound names get their own pattern.
const ENV_ASSIGNMENT = /(\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)[A-Z0-9_]*\s*[:=]\s*)(?!\[REDACTED\])(?:"[^"]*"|'[^']*'|[^\s,;\]}]+)/g;
// Token shapes that identify themselves by prefix, wherever they appear.
const KNOWN_TOKENS = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,           // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,                          // GitHub fine-grained
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,                              // GitLab
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,                                 // OpenAI, Anthropic
  /\bsk_(?:live|test)_[A-Za-z0-9]{10,}\b/g,                     // Stripe
  /\bAKIA[0-9A-Z]{16}\b/g,                                      // AWS access key id
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,                          // Slack
  /\bAIza[0-9A-Za-z_-]{35}\b/g,                                 // Google API
  /\bapikey_[A-Za-z0-9_]{20,}\b/g,                              // TypeSafe
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
];
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
// Covers the common hyphenated, spaced, and contiguous nine-digit forms. The
// contiguous form also catches nine-digit identifiers that are not SSNs; that
// over-redaction is accepted because the hooks run against mortgage data.
const SSN_SHAPED = /\b\d{3}(?:[- ]?\d{2})[- ]?\d{4}\b/g;

function isAsciiLetter(code) {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isSchemeChar(code) {
  return isAsciiLetter(code)
    || (code >= 0x30 && code <= 0x39)
    || code === 0x2b // +
    || code === 0x2d // -
    || code === 0x2e; // .
}

function isWhitespace(code) {
  return code === 0x09 // tab
    || code === 0x0a // line feed
    || code === 0x0b // vertical tab
    || code === 0x0c // form feed
    || code === 0x0d // carriage return
    || code === 0x20 // space
    || code === 0xa0 // no-break space
    || code === 0x1680
    || (code >= 0x2000 && code <= 0x200a)
    || code === 0x2028
    || code === 0x2029
    || code === 0x202f
    || code === 0x205f
    || code === 0x3000
    || code === 0xfeff;
}

function isUsernameChar(code) {
  return !isWhitespace(code) && code !== 0x2f && code !== 0x40 && code !== 0x3a;
}

function isPasswordChar(code) {
  return !isWhitespace(code) && code !== 0x2f && code !== 0x40;
}

/** Redact URL passwords with a single forward scan. */
function redactUrlCredentials(value) {
  const pieces = [];
  let copyFrom = 0;
  let searchFrom = 0;

  while (true) {
    const delimiter = value.indexOf("://", searchFrom);
    if (delimiter < 0) break;

    // The old expression may start at any letter in the scheme-character run
    // immediately before ://. Walking that run backwards preserves that
    // behavior without retrying every position in a long letter-only string.
    let schemeStart = delimiter;
    while (schemeStart > 0 && isSchemeChar(value.charCodeAt(schemeStart - 1))) schemeStart--;
    while (schemeStart < delimiter && !isAsciiLetter(value.charCodeAt(schemeStart))) schemeStart++;
    if (schemeStart === delimiter) {
      searchFrom = delimiter + 3;
      continue;
    }

    const authorityStart = delimiter + 3;
    let cursor = authorityStart;
    while (cursor < value.length && isUsernameChar(value.charCodeAt(cursor))) cursor++;
    if (cursor === authorityStart || cursor >= value.length || value.charCodeAt(cursor) !== 0x3a) {
      searchFrom = authorityStart;
      continue;
    }

    const passwordStart = cursor + 1;
    cursor = passwordStart;
    while (cursor < value.length && isPasswordChar(value.charCodeAt(cursor))) cursor++;
    if (cursor >= value.length || cursor === passwordStart || value.charCodeAt(cursor) !== 0x40) {
      searchFrom = authorityStart;
      continue;
    }

    pieces.push(value.slice(copyFrom, passwordStart), REDACTED, "@");
    copyFrom = cursor + 1;
    searchFrom = copyFrom;
  }

  return copyFrom === 0 ? value : pieces.join("") + value.slice(copyFrom);
}

// Files that conventionally hold credentials, by path. Used both to ask
// before one is committed and to ask before one is read.
const SECRET_FILE_PATTERNS = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /(^|\/)credentials(\.json)?$/i,
  /(^|\/)\.(netrc|pypirc|npmrc|git-credentials)$/i,
  /(^|\/)\.aws\/credentials$/i,
  /(^|\/)\.kube\/config$/i,
  /(^|\/)\.docker\/config\.json$/i,
  /(^|\/)secrets?\.(json|ya?ml|toml|env|properties)$/i,
  /(^|\/)secrets?\./i,
];
// Templates are meant to be committed and read; only a real .env carries values.
const SECRET_FILE_EXEMPT = /\.env\.(example|sample|template|dist)$|\.pub$/i;

/** Does this path look like a file that holds credentials? */
export function looksLikeSecretFile(path) {
  if (typeof path !== "string" || !path) return false;
  const normalized = path.replace(/\\/g, "/");
  return SECRET_FILE_PATTERNS.some((p) => p.test(normalized)) && !SECRET_FILE_EXEMPT.test(normalized);
}

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
  let out = value
    .replace(PEM_PRIVATE_KEY, REDACTED)
    .replace(BEARER_TOKEN, `Bearer ${REDACTED}`)
    .replace(CREDENTIAL_ASSIGNMENT, `$1${REDACTED}`)
    .replace(ENV_ASSIGNMENT, `$1${REDACTED}`)
    .replace(SSN_SHAPED, REDACTED);
  out = redactUrlCredentials(out);
  for (const pattern of KNOWN_TOKENS) out = out.replace(pattern, REDACTED);
  return out;
}

function redact(value, ancestors, key) {
  if (key !== undefined && isSensitiveKey(key)) return REDACTED;
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;

  // State sent to the API should be JSON-shaped. A cycle cannot be serialized
  // safely, so make the problematic branch harmless instead of echoing it.
  // Only the chain of ancestors counts as a cycle: the same object reached
  // twice through different keys (two questions sharing one criteria map) is
  // ordinary JSON and must come through both times.
  if (ancestors.has(value)) return REDACTED;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => redact(entry, ancestors));

    const out = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] = redact(childValue, ancestors, childKey);
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
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
