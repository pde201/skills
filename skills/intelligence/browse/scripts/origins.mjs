// ──────────────────────────────────────────────────────────────────────
//  Trusted origins: localhost, or an origin the user lists exactly.
//  No wildcards on public domains — `*.vercel.app` would trust everyone's
//  deployments, including an attacker's.
// ──────────────────────────────────────────────────────────────────────

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The origin of a URL, or null when it has none (about:blank, data:, junk). */
export function originOf(url) {
  try {
    const { origin } = new URL(url);
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/**
 * Parse a comma-separated list of exact origins. Entries with a wildcard
 * or without a scheme are rejected rather than guessed at.
 * @returns {{origins: string[], rejected: string[]}}
 */
export function parseTrustedOrigins(text = "") {
  const origins = [];
  const rejected = [];
  for (const entry of String(text).split(",").map((e) => e.trim()).filter(Boolean)) {
    const origin = entry.includes("*") ? null : originOf(entry);
    if (origin) origins.push(origin);
    else rejected.push(entry);
  }
  return { origins, rejected };
}

export function isTrusted(origin, listed = []) {
  if (!origin) return false;
  let host;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  if (LOCAL_HOSTS.has(host) || host.endsWith(".localhost")) return true;
  return listed.includes(origin);
}

/** Hostnames for agent-browser's --allowed-domains. */
export const hostsOf = (origins) => [...new Set(origins.map((o) => new URL(o).hostname))];
