// Runs in every page of a browse session (agent-browser --init-script) and
// marks what the accessibility snapshot cannot show, using the browser's
// own answers rather than guesses from markup:
//
//   data-browse-submits  a control that would submit a form. `el.form`
//                        covers nesting and the form="" attribute, and
//                        `el.type` is "submit" for a <button> naming none.
//                        (A CSS-scoped snapshot sees only the first form.)
//   data-browse-search   a search field whose form submits by GET to this
//                        page's own origin: a Site search, safe to submit.
(() => {
  const SEARCH_ROLES = new Set(["searchbox", "combobox"]);
  const flag = (el, name, on) => (on ? el.setAttribute(name, "") : el.removeAttribute(name));

  const searchLike = (el) =>
    el.type === "search"
    || SEARCH_ROLES.has(el.getAttribute("role"))
    || Boolean(el.closest("[role=search], search"))
    || el.form?.getAttribute("role") === "search";

  const getsOwnOrigin = (form) => {
    if (!form || form.method !== "get") return false;
    try {
      return new URL(form.action, location.href).origin === location.origin;
    } catch {
      return false;
    }
  };

  const mark = () => {
    for (const el of document.querySelectorAll("button, input")) {
      flag(el, "data-browse-submits", el.form && (el.type === "submit" || el.type === "image"));
    }
    for (const el of document.querySelectorAll("input, textarea")) {
      flag(el, "data-browse-search", searchLike(el) && getsOwnOrigin(el.form));
    }
  };

  const start = () => {
    mark();
    new MutationObserver(mark).observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["type", "form", "role", "method", "action"],
    });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
