"""Tests for effective-html/scripts/check-html-artifact.py (stdlib only)."""

import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "effective-html" / "scripts" / "check-html-artifact.py"
spec = importlib.util.spec_from_file_location("check_html_artifact", SCRIPT)
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


def page(body="<p>Body</p>", css="", head="", title="Release plan"):
    return (
        "<!doctype html><html><head>"
        f"<title>{title}</title>"
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<style>main {{ max-width: 70ch; }} {css}</style>{head}"
        f"</head><body><main><h1>Plan</h1>{body}</main></body></html>"
    )


class CheckTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def check(self, html, name="a.html"):
        path = Path(self.tmp.name) / name
        path.write_text(html, encoding="utf-8")
        return checker.check(path)

    def assertClean(self, html):
        errors, warnings = self.check(html)
        self.assertEqual(errors, [])
        self.assertEqual(warnings, [])

    def assertWarns(self, html, fragment):
        _, warnings = self.check(html)
        self.assertTrue(any(fragment in w for w in warnings), warnings)

    def assertErrors(self, html, fragment):
        errors, _ = self.check(html)
        self.assertTrue(any(fragment in e for e in errors), errors)

    def test_complete_page_is_clean(self):
        self.assertClean(page())

    def test_title_and_viewport_are_required(self):
        self.assertErrors(page(title=""), "meaningful <title>")
        self.assertErrors(page(title="Untitled"), "meaningful <title>")
        errors, _ = self.check("<title>Plan</title><style>main{max-width:1px}</style><main><h1>x</h1></main>")
        self.assertTrue(any("viewport" in e for e in errors), errors)

    def test_remote_assets_are_errors_and_local_ones_warnings(self):
        self.assertErrors(page(head='<script src="https://cdn.example.com/x.js"></script>'), "https://cdn.example.com/x.js")
        self.assertErrors(page(body='<img src="//example.com/a.png" alt="a">'), "//example.com/a.png")
        self.assertWarns(page(head='<link rel="stylesheet" href="theme.css">'), "theme.css")
        self.assertClean(page(body='<img src="data:image/png;base64,AAAA" alt="dot">'))

    def test_remote_urls_in_css_are_errors(self):
        self.assertErrors(page(css="@import url('https://fonts.example.com/inter.css');"), "https://fonts.example.com/inter.css")
        self.assertErrors(page(css='@import "https://fonts.example.com/a.css";'), "https://fonts.example.com/a.css")
        self.assertErrors(page(css=".h { background: url(https://example.com/bg.png) }"), "https://example.com/bg.png")
        self.assertErrors(page(body='<div style="background:url(//example.com/s.png)">x</div>'), "//example.com/s.png")

    def test_css_urls_in_page_text_are_not_dependencies(self):
        self.assertClean(page(body="<pre><code>background: url(https://example.com/bg.png)</code></pre>"))
        self.assertClean(page(css=".dot { background: url(data:image/png;base64,AAAA) }"))

    def test_gradient_text_warning_needs_background_clip_text(self):
        gradient = "background-image: linear-gradient(red, blue);"
        self.assertWarns(page(css=f".t {{ {gradient} -webkit-background-clip: text; }}"), "Gradient text")
        self.assertClean(page(css=f".card {{ {gradient} background-clip: padding-box; }}", body="<p>plenty of text</p>"))

    def test_labelled_inputs(self):
        self.assertClean(page(body='<label for="a">A</label><input id="a">'))
        self.assertClean(page(body='<label>Name <input id="n"></label>'))
        self.assertClean(page(body='<input id="q" aria-label="Search"><span id="l">L</span><textarea id="t" aria-labelledby="l"></textarea>'))
        self.assertClean(page(body='<input id="h" type="hidden"><input id="s" type="submit" value="Go">'))
        self.assertWarns(page(body='<input id="orphan">'), "orphan")

    def test_label_scope_ends_with_the_label(self):
        self.assertWarns(page(body='<label>Name <input id="in"></label><input id="after">'), "after")

    def test_buttons_links_and_images(self):
        self.assertWarns(page(body='<button id="b"></button>'), "Button near 'b'")
        self.assertClean(page(body='<button aria-label="Close"></button><button>Save</button>'))
        self.assertWarns(page(body='<a href="#top"></a>'), "Anchor link")
        self.assertWarns(page(body='<img src="data:image/png;base64,AA">'), "missing an 'alt'")

    def test_duplicate_ids_and_positive_tabindex(self):
        self.assertErrors(page(body='<p id="x">1</p><p id="x">2</p>'), "Duplicate element IDs found")
        self.assertWarns(page(body='<div tabindex="2">x</div>'), "Positive tabindex")
        self.assertClean(page(body='<div tabindex="0">x</div><div tabindex="-1">y</div>'))

    def test_style_warnings(self):
        self.assertWarns(page(css="p { color: #000 }"), "Pure black")
        self.assertClean(page(css="@media print { p { color: #000 } }"))
        self.assertWarns(page(css=".card { border-left: 4px solid red }"), "Side-stripe")
        self.assertWarns(page(body="<p>" + "TO" + "DO later</p>"), "Placeholder")
        self.assertWarns(
            "<title>Plan</title>" '<meta name="viewport" content="width=device-width">'
            "<style>p{}</style><main><h1>x</h1></main>",
            "max-width",
        )


class CliTest(unittest.TestCase):
    def run_cli(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True)

    def test_exit_codes(self):
        with tempfile.TemporaryDirectory() as tmp:
            good = Path(tmp) / "good.html"
            good.write_text(page(), encoding="utf-8")
            bad = Path(tmp) / "bad.html"
            bad.write_text(page(title=""), encoding="utf-8")
            passed = self.run_cli(str(good))
            self.assertEqual(passed.returncode, 0, passed.stderr)
            self.assertIn("HTML artifact checks passed.", passed.stdout)
            self.assertEqual(self.run_cli(str(bad)).returncode, 1)
            self.assertEqual(self.run_cli(str(Path(tmp) / "missing.html")).returncode, 2)


if __name__ == "__main__":
    unittest.main()
