// ──────────────────────────────────────────────────────────────────────
//  A site's published search template (OpenSearch), for a Site search on
//  sites whose search box is script-driven rather than a form (GitHub).
//
//  Only a template that is a GET to the page's own origin is used. The
//  description is fetched from here, not the browser: the strict policy
//  denies page scripts, and a public XML file needs no cookies.
// ──────────────────────────────────────────────────────────────────────

import { originOf } from "./origins.mjs";

const attr = (tag, name) => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(tag)?.[1]
  ?? new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, "i").exec(tag)?.[1];

// &amp; last, so "&amp;lt;" decodes once, to "&lt;".
const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** The HTML search template in an OpenSearch description, or null. */
export function parseTemplate(xml) {
  for (const [tag] of String(xml).matchAll(/<Url\b[^>]*>/gi)) {
    if ((attr(tag, "type") ?? "").toLowerCase() !== "text/html") continue;
    if ((attr(tag, "method") ?? "get").toLowerCase() !== "get") continue;
    const template = attr(tag, "template");
    if (template) return unescape(template);
  }
  return null;
}

/**
 * The URL a Site search for `text` opens, or null when the template is
 * unusable: not on `pageOrigin`, no {searchTerms}, or a required parameter
 * this cannot fill.
 */
export function searchUrl(template, text, pageOrigin) {
  if (!template?.includes("{searchTerms}")) return null;
  const filled = template
    .replace(/\{searchTerms\}/g, encodeURIComponent(text))
    .replace(/\{[\w:]+\?\}/g, "");
  if (/\{[\w:]+\}/.test(filled)) return null;
  return originOf(filled) === pageOrigin ? filled : null;
}

/**
 * Fetch and parse a page's OpenSearch description, remembering the answer
 * per description URL. Any failure means no Site search by template.
 */
export function templateFinder(fetchImpl = globalThis.fetch, timeoutMs = 3000) {
  const cache = new Map();
  return async (href, pageUrl) => {
    if (!href || !pageUrl) return null;
    let url;
    try {
      url = new URL(href, pageUrl);
    } catch {
      return null;
    }
    // Same origin only: a description elsewhere could point the search anywhere.
    if (url.origin !== originOf(pageUrl) || !/^https?:$/.test(url.protocol)) return null;
    if (!cache.has(url.href)) {
      cache.set(url.href, (async () => {
        try {
          const res = await fetchImpl(url.href, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
          return res.ok ? parseTemplate(await res.text()) : null;
        } catch {
          return null;
        }
      })());
    }
    return cache.get(url.href);
  };
}
