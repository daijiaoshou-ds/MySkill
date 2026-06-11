#!/usr/bin/env python3
"""
Analyze Excel workbook structure for audit-basis-sense skill.

Reads an .xlsx file and outputs structural metadata (sheet names, columns,
row counts) with pre-computed clustering hints for basis transformation analysis.

The script is domain-agnostic -- it does NOT contain audit logic.
The AI interprets the JSON output through the lens of the SKILL.md methodology.

Usage: python analyze_sheet_structure.py <path_to_xlsx>
"""

import json
import sys
from pathlib import Path

try:
    import openpyxl
except ImportError:
    print(
        "Error: openpyxl is required. Install with: pip install openpyxl",
        file=sys.stderr,
    )
    sys.exit(1)


# ---------------------------------------------------------------------------
# Core analysis
# ---------------------------------------------------------------------------

def analyze_workbook(filepath: str) -> dict:
    """Read workbook metadata and return a structural analysis dict."""
    wb = openpyxl.load_workbook(filepath, read_only=True, data_only=True)

    sheets_data = []
    for name in wb.sheetnames:
        ws = wb[name]
        header_row = _get_header_row(ws)
        row_count = _estimate_row_count(ws)
        sheets_data.append(
            {
                "name": str(name),
                "row_count": row_count,
                "column_count": len(header_row),
                "columns": header_row,
            }
        )
    wb.close()

    # Pre-compute structural clustering
    groups = _cluster_by_column_similarity(sheets_data)

    result = {
        "workbook": Path(filepath).name,
        "sheet_count": len(sheets_data),
        "total_rows": sum(s["row_count"] for s in sheets_data),
        "sheets": sheets_data,
        "analysis_hints": {"identical_structure_groups": groups},
    }

    return result


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_header_row(ws) -> list[str]:
    """Extract column headers from the first non-empty row (within first 5 rows)."""
    for row in ws.iter_rows(min_row=1, max_row=5, values_only=True):
        cleaned = [str(c).strip() if c is not None else "" for c in row]
        if any(cleaned):
            # Truncate trailing empty strings
            while cleaned and cleaned[-1] == "":
                cleaned.pop()
            return cleaned
    return []


def _estimate_row_count(ws) -> int:
    """Estimate number of data rows (including header)."""
    if ws.max_row:
        return ws.max_row
    return 0


def _cluster_by_column_similarity(sheets: list[dict]) -> list[dict]:
    """
    Group sheets whose column sets largely overlap.

    Uses overlap ratio: |A ∩ B| / min(|A|, |B|) >= 0.7
    This is more intuitive than Jaccard for audit use cases —
    e.g. two 5-column sheets sharing 4 columns → 4/5 = 80% overlap.
    """
    groups = []
    remaining = list(sheets)

    while remaining:
        base = remaining.pop(0)
        base_set = set(c for c in base["columns"] if c)
        if not base_set:
            continue

        group_members = [base["name"]]
        to_remove = []

        for i, s in enumerate(remaining):
            s_set = set(c for c in s["columns"] if c)
            if not s_set:
                continue
            intersection = base_set & s_set
            min_size = min(len(base_set), len(s_set))
            if min_size > 0 and len(intersection) / min_size >= 0.7:
                group_members.append(s["name"])
                to_remove.append(i)

        # Remove in reverse order to preserve indices
        for i in reversed(to_remove):
            remaining.pop(i)

        if len(group_members) > 1:
            # Compute common columns across all group members
            member_data = [s for s in sheets if s["name"] in group_members]
            common = set(c for c in member_data[0]["columns"] if c)
            for m in member_data[1:]:
                common &= set(c for c in m["columns"] if c)

            # Compute differing columns per sheet
            differing = {}
            for m in member_data:
                m_cols = set(c for c in m["columns"] if c)
                diff = sorted(m_cols - common)
                if diff:
                    differing[m["name"]] = diff

            groups.append(
                {
                    "group_id": len(groups) + 1,
                    "sheets": group_members,
                    "common_columns": sorted(common),
                    "differing_columns": differing,
                }
            )

    return groups


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    if len(sys.argv) != 2:
        print(
            "Usage: python analyze_sheet_structure.py <path_to_xlsx>",
            file=sys.stderr,
        )
        sys.exit(1)

    filepath = sys.argv[1]
    if not Path(filepath).is_file():
        print(f"Error: file not found: {filepath}", file=sys.stderr)
        sys.exit(1)

    try:
        result = analyze_workbook(filepath)
    except Exception as exc:
        print(f"Error: failed to analyze workbook: {exc}", file=sys.stderr)
        sys.exit(1)

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
