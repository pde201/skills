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

  const sameOrigin = (url) => {
    try {
      return new URL(url, location.href).origin === location.origin;
    } catch {
      return false;
    }
  };

  // Enter submits a form through its default button: the first submit
  // control among the form's elements. That button's formmethod and
  // formaction override the form's own, so both have to say GET, here.
  const getsOwnOrigin = (form) => {
    if (!form || form.method !== "get" || !sameOrigin(form.action)) return false;
    const button = [...form.elements].find((el) => el.type === "submit" || el.type === "image");
    if (!button) return true;
    if (button.hasAttribute("formmethod") && button.getAttribute("formmethod").toLowerCase() !== "get") return false;
    return !button.hasAttribute("formaction") || sameOrigin(button.formAction);
  };

  const mark = () => {
    for (const el of document.querySelectorAll("button, input")) {
      flag(el, "data-browse-submits", el.form && (el.type === "submit" || el.type === "image"));
    }
    for (const el of document.querySelectorAll("input, textarea")) {
      flag(el, "data-browse-search", searchLike(el) && getsOwnOrigin(el.form));
    }
  };

  // Busy pages mutate constantly, mostly text and layout. Rescan only when a
  // change could touch a form control; the rescan itself stays whole-page,
  // because a mark that lags behind the page is the unsafe direction.
  const CONTROLS = "form, button, input, textarea";
  const touchesControls = (records) => records.some((r) =>
    r.type === "attributes"
    || [...r.addedNodes, ...r.removedNodes].some((n) => n.nodeType === 1 && (n.matches(CONTROLS) || n.querySelector(CONTROLS))));

  const start = () => {
    mark();
    new MutationObserver((records) => { if (touchesControls(records)) mark(); }).observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["type", "form", "role", "method", "action", "formmethod", "formaction"],
    });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
