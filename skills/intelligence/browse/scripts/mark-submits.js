// Runs in every page of a browse session (agent-browser --init-script).
// Marks each control that would submit a form with data-browse-submits,
// using the browser's own answer: `el.form` covers nesting and the form=""
// attribute, and `el.type` is "submit" for a <button> that names no type.
// A CSS-scoped snapshot cannot see this: agent-browser scopes to the first
// match only, so a second form's submit button went unnoticed.
(() => {
  const mark = (root) => {
    for (const el of root.querySelectorAll("button, input")) {
      const submits = el.form && (el.type === "submit" || el.type === "image");
      if (submits) el.setAttribute("data-browse-submits", "");
      else el.removeAttribute("data-browse-submits");
    }
  };
  const start = () => {
    mark(document);
    new MutationObserver(() => mark(document)).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["type", "form"] });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
