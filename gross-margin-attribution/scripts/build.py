#!/usr/bin/env python3
"""Inline data/core/app/styles into one offline HTML file."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path


def _utf8_stdout() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass


def main():
    _utf8_stdout()
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="prepared data.js")
    ap.add_argument("--out", required=True, help="output HTML")
    ap.add_argument("--assets", default=str(Path(__file__).resolve().parent.parent / "assets"))
    args = ap.parse_args()

    assets = Path(args.assets)
    data = Path(args.data).read_text(encoding="utf-8")
    data_mb = len(data.encode("utf-8")) / 1024 / 1024
    if data_mb > 8:
        print(
            f"warning: data.js is {data_mb:.1f} MB; the single-file HTML may be slow. "
            "Aggregate or sample before building if the browser struggles.",
            file=sys.stderr,
        )
    html = (assets / "index.html").read_text(encoding="utf-8")
    css = (assets / "styles.css").read_text(encoding="utf-8")

    # A truncated stylesheet silently drops every later rule (including section
    # collapse); fail loudly instead of shipping a half-styled workbench.
    _css = css.strip()
    assert _css.endswith("}"), "assets/styles.css is truncated: missing closing brace"
    assert _css.count("{") == _css.count("}"), "assets/styles.css has unbalanced braces"

    core = (assets / "core.js").read_text(encoding="utf-8")
    app = (assets / "app.js").read_text(encoding="utf-8")

    html = html.replace('<link rel="stylesheet" href="styles.css">', "<style>\n" + css + "\n</style>")
    html = html.replace('<script src="data.js"></script>', "<script>\n" + data + "\n</script>")
    html = html.replace('<script src="core.js"></script>', "<script>\n" + core + "\n</script>")
    html = html.replace('<script src="app.js"></script>', "<script>\n" + app + "\n</script>")

    assert 'href="styles.css"' not in html
    assert 'src="data.js"' not in html
    assert 'src="core.js"' not in html
    assert 'src="app.js"' not in html

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    print(f"written {out.resolve()} {len(html.encode('utf-8'))} bytes")


if __name__ == "__main__":
    main()
