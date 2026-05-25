#!/usr/bin/env python3
"""Lightweight sanity checks for self-contained HTML artifacts."""

from __future__ import annotations

import argparse
import sys
from html.parser import HTMLParser
from pathlib import Path


class ArtifactParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.stack: list[str] = []
        self.title_text: list[str] = []
        self.in_title = False
        self.has_viewport = False
        self.has_style = False
        self.has_main = False
        self.has_h1 = False
        self.external_refs: list[str] = []
        self.buttons: list[dict[str, str]] = []
        self.button_text: list[str] = []
        self._button_depth = 0
        self._current_button_text: list[str] = []
        self.inputs: list[dict[str, str]] = []
        self.labels_for: set[str] = set()

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr = {key.lower(): value or "" for key, value in attrs}
        self.stack.append(tag)
        if tag == "title":
            self.in_title = True
        elif tag == "meta" and attr.get("name", "").lower() == "viewport":
            self.has_viewport = "width=device-width" in attr.get("content", "")
        elif tag == "style":
            self.has_style = True
        elif tag == "main":
            self.has_main = True
        elif tag == "h1":
            self.has_h1 = True
        elif tag == "script" and attr.get("src"):
            self.external_refs.append(attr["src"])
        elif tag == "link" and attr.get("href"):
            rel = attr.get("rel", "").lower()
            if "stylesheet" in rel or attr["href"].startswith(("http://", "https://", "//")):
                self.external_refs.append(attr["href"])
        elif tag in {"img", "iframe", "audio", "video", "source"} and attr.get("src"):
            self.external_refs.append(attr["src"])
        elif tag == "button":
            self.buttons.append(attr)
            self._button_depth += 1
            self._current_button_text = []
        elif tag in {"input", "textarea", "select"}:
            self.inputs.append(attr)
        elif tag == "label" and attr.get("for"):
            self.labels_for.add(attr["for"])

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self.in_title = False
        if tag == "button" and self._button_depth:
            self.button_text.append(" ".join("".join(self._current_button_text).split()))
            self._button_depth -= 1
            self._current_button_text = []
        if self.stack:
            self.stack.pop()

    def handle_data(self, data: str) -> None:
        if self.in_title:
            self.title_text.append(data)
        if self._button_depth:
            self._current_button_text.append(data)


def check(path: Path) -> tuple[list[str], list[str]]:
    text = path.read_text(encoding="utf-8")
    parser = ArtifactParser()
    parser.feed(text)

    errors: list[str] = []
    warnings: list[str] = []

    title = " ".join("".join(parser.title_text).split())
    if not title or title.lower() in {"html artifact", "untitled", "spec artifact title"}:
        errors.append("Use a meaningful <title>.")
    if not parser.has_viewport:
        errors.append('Add <meta name="viewport" content="width=device-width, initial-scale=1">.')
    if not parser.has_style:
        warnings.append("No inline <style> found; self-contained artifacts usually need local CSS.")
    if not parser.has_main:
        warnings.append("No <main> landmark found.")
    if not parser.has_h1:
        warnings.append("No <h1> found.")

    http_refs = [ref for ref in parser.external_refs if ref.startswith(("http://", "https://", "//"))]
    if http_refs:
        errors.append("External URL dependencies found: " + ", ".join(sorted(set(http_refs))))
    local_refs = [ref for ref in parser.external_refs if not ref.startswith(("data:", "#")) and ref not in http_refs]
    if local_refs:
        warnings.append("Local external assets found; confirm portability: " + ", ".join(sorted(set(local_refs))))

    for index, button in enumerate(parser.buttons):
        button_id = button.get("id", "button")
        visible_text = parser.button_text[index] if index < len(parser.button_text) else ""
        if not any(key in button for key in ("aria-label", "title")) and not visible_text:
            warnings.append(f"Button near {button_id!r} may need visible text or aria-label.")

    input_ids = {attrs.get("id", "") for attrs in parser.inputs if attrs.get("id")}
    unlabeled = sorted(input_ids - parser.labels_for)
    if unlabeled:
        warnings.append("Inputs without matching <label for>: " + ", ".join(unlabeled))

    placeholder_markers = ("TO" + "DO", "T" + "BD")
    if any(marker in text for marker in placeholder_markers):
        warnings.append("Placeholder marker found.")
    if "<marquee" in text.lower():
        warnings.append("Avoid obsolete or distracting elements such as <marquee>.")
    if len(text) > 500_000:
        warnings.append("Artifact is larger than 500 KB; check whether embedded data should be summarized.")

    return errors, warnings


def main() -> int:
    parser = argparse.ArgumentParser(description="Sanity-check a self-contained HTML artifact.")
    parser.add_argument("html_file", type=Path)
    args = parser.parse_args()

    if not args.html_file.exists():
        print(f"error: file not found: {args.html_file}", file=sys.stderr)
        return 2
    if args.html_file.suffix.lower() not in {".html", ".htm"}:
        print("warning: file does not use .html or .htm extension", file=sys.stderr)

    errors, warnings = check(args.html_file)
    for warning in warnings:
        print(f"warning: {warning}")
    for error in errors:
        print(f"error: {error}", file=sys.stderr)

    if errors:
        return 1
    print("HTML artifact checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
