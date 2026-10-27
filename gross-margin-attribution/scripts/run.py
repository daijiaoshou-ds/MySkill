#!/usr/bin/env python3
"""Run prepare -> build -> analyze from a reviewed mapping."""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent


def _utf8_stdout() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass


def main():
    _utf8_stdout()
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("--mapping", required=True)
    ap.add_argument("--outdir", default="work")
    ap.add_argument("--strict-dims", action="store_true")
    ap.add_argument("--strict-rows", action="store_true")
    args = ap.parse_args()

    if Path(args.input).suffix.lower() in {".xlsx", ".xlsm"}:
        try:
            import openpyxl  # noqa: F401
        except Exception:
            raise SystemExit(
                "openpyxl is required to read .xlsx / .xlsm. "
                f"Current Python: {sys.executable}\n"
                "Use the DSH bundled Python (load_workspace_dependencies) or run: "
                f"{sys.executable} -m pip install openpyxl"
            )

    out = Path(args.outdir)
    out.mkdir(parents=True, exist_ok=True)

    prepare_cmd = [sys.executable, str(SKILL / "scripts" / "prepare.py"), args.input,
                   "--mapping", args.mapping, "--outdir", str(out)]
    if args.strict_dims:
        prepare_cmd.append("--strict-dims")
    if args.strict_rows:
        prepare_cmd.append("--strict-rows")
    subprocess.run(prepare_cmd, check=True)
    subprocess.run([sys.executable, str(SKILL / "scripts" / "build.py"),
                    "--data", str(out / "data.js"),
                    "--out", str(out / "毛利率归因工作台.html")], check=True)
    node = shutil.which("node")
    if not node:
        raise SystemExit("node not found")
    subprocess.run([node, str(SKILL / "scripts" / "analyze.js"),
                    "--data", str(out / "data.js"),
                    "--core", str(SKILL / "assets" / "core.js"),
                    "--out", str(out / "analysis.json")], check=True)
    print("done:", out.resolve())
    print("files: data.json / data.csv / quality.json / dim_diagnostics.json / mapping.used.json / analysis.json / 毛利率归因工作台.html")


if __name__ == "__main__":
    main()
