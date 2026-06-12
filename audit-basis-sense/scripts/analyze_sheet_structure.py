#!/usr/bin/env python3
"""
Analyze Excel workbook structure for audit-basis-sense skill.

Reads an .xlsx file and outputs structural metadata (sheet names, columns,
row counts) with pre-computed clustering hints for basis transformation analysis.

Pure Python stdlib — no external dependencies.  .xlsx is a ZIP of XML files.

Usage: python analyze_sheet_structure.py <path_to_xlsx>
"""

import json
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET


# ---------------------------------------------------------------------------
# Core analysis
# ---------------------------------------------------------------------------

def analyze_workbook(filepath: str) -> dict:
    """Read workbook metadata and return a structural analysis dict."""
    with zipfile.ZipFile(filepath, "r") as zf:
        # Parse shared strings table (Excel stores text in a shared pool)
        shared_strings = _parse_shared_strings(zf)

        # Parse sheet names from workbook.xml
        sheet_names = _parse_sheet_names(zf)

        # Parse each sheet
        sheets_data = []
        for name in sheet_names:
            header_row, row_count = _parse_sheet(zf, name, shared_strings)
            sheets_data.append(
                {
                    "name": name,
                    "row_count": row_count,
                    "column_count": len(header_row),
                    "columns": header_row,
                }
            )

    groups = _cluster_by_column_similarity(sheets_data)

    return {
        "workbook": Path(filepath).name,
        "sheet_count": len(sheets_data),
        "total_rows": sum(s["row_count"] for s in sheets_data),
        "sheets": sheets_data,
        "analysis_hints": {"identical_structure_groups": groups},
    }


# ---------------------------------------------------------------------------
# XML parsers
# ---------------------------------------------------------------------------

def _parse_shared_strings(zf: zipfile.ZipFile) -> list[str]:
    """Parse xl/sharedStrings.xml into a list of strings."""
    ss_path = "xl/sharedStrings.xml"
    if ss_path not in zf.namelist():
        return []

    root = ET.fromstring(zf.read(ss_path))
    ns = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    strings = []
    for si in root.findall("s:si", ns):
        # A <si> may contain <t> or multiple <r><t> (rich text)
        texts = []
        for t in si.iter("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t"):
            if t.text:
                texts.append(t.text)
        strings.append("".join(texts))
    return strings


def _parse_sheet_names(zf: zipfile.ZipFile) -> list[str]:
    """Parse xl/workbook.xml to get ordered sheet names."""
    wb_xml = zf.read("xl/workbook.xml")
    root = ET.fromstring(wb_xml)
    ns = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    # r:id attributes reference relationships, but we can use name directly
    names = []
    for sheet in root.findall(".//s:sheet", ns):
        name = sheet.get("name", "")
        if name:
            names.append(name)
    return names


def _parse_sheet(
    zf: zipfile.ZipFile, sheet_name: str, shared_strings: list[str]
) -> tuple[list[str], int]:
    """
    Parse a sheet's XML to extract header row and row count.
    Returns (header_columns, estimated_row_count).
    """
    # Find the sheet file — try multiple possible paths
    sheet_path = None
    for candidate in [
        f"xl/worksheets/{sheet_name}.xml",
        f"xl/worksheets/{sheet_name.lower()}.xml",
    ]:
        if candidate in zf.namelist():
            sheet_path = candidate
            break

    if sheet_path is None:
        # Fallback: find by relationship order (sheet1.xml, sheet2.xml, ...)
        sheet_index = _find_sheet_index(zf, sheet_name)
        sheet_path = f"xl/worksheets/sheet{sheet_index}.xml"

    if sheet_path not in zf.namelist():
        return ([], 0)

    root = ET.fromstring(zf.read(sheet_path))
    ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"

    # Collect all rows
    rows = root.findall(f".//{{{ns}}}row")
    if not rows:
        return ([], 0)

    # Row count from dimension attribute if available
    dimension = root.find(f"{{{ns}}}dimension")
    max_row = len(rows)
    if dimension is not None:
        ref = dimension.get("ref", "")
        if ":" in ref:
            # e.g. "A1:Z5000" → parse row number after colon
            end_cell = ref.split(":")[1]
            end_row = "".join(c for c in end_cell if c.isdigit())
            if end_row:
                max_row = int(end_row)

    # Extract header from first 5 rows
    header = []
    for row_elem in rows[:5]:
        cells = row_elem.findall(f"{{{ns}}}c")
        row_values = [_cell_value(c, shared_strings) for c in cells]
        cleaned = [str(v).strip() if v is not None else "" for v in row_values]
        if any(cleaned):
            while cleaned and cleaned[-1] == "":
                cleaned.pop()
            header = cleaned
            break

    return (header, max_row)


def _find_sheet_index(zf: zipfile.ZipFile, sheet_name: str) -> int:
    """Find a sheet's numeric index from workbook.xml."""
    wb_xml = zf.read("xl/workbook.xml")
    root = ET.fromstring(wb_xml)
    ns = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    for i, sheet in enumerate(root.findall(".//s:sheet", ns), start=1):
        if sheet.get("name") == sheet_name:
            return i
    return 1


def _cell_value(cell_elem, shared_strings: list[str]) -> str | None:
    """Extract a cell's displayed value."""
    t = cell_elem.get("t", "")
    ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"

    if t == "inlineStr":
        # Inline string: <is><t>text</t></is>
        is_elem = cell_elem.find(f"{{{ns}}}is")
        if is_elem is not None:
            t_elem = is_elem.find(f"{{{ns}}}t")
            if t_elem is not None and t_elem.text:
                return t_elem.text
        return None

    value_elem = cell_elem.find(f"{{{ns}}}v")
    if value_elem is None or value_elem.text is None:
        return None

    if t == "s":
        # Shared string reference
        idx = int(value_elem.text)
        if 0 <= idx < len(shared_strings):
            return shared_strings[idx]
        return None
    elif t == "b":
        return "TRUE" if value_elem.text == "1" else "FALSE"
    else:
        return value_elem.text


# ---------------------------------------------------------------------------
# Clustering
# ---------------------------------------------------------------------------

def _cluster_by_column_similarity(sheets: list[dict]) -> list[dict]:
    """
    Group sheets whose column sets largely overlap.

    Uses overlap ratio: |A ∩ B| / min(|A|, |B|) >= 0.7
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

        for i in reversed(to_remove):
            remaining.pop(i)

        if len(group_members) > 1:
            member_data = [s for s in sheets if s["name"] in group_members]
            common = set(c for c in member_data[0]["columns"] if c)
            for m in member_data[1:]:
                common &= set(c for c in m["columns"] if c)

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
        print("Usage: python analyze_sheet_structure.py <path_to_xlsx>", file=sys.stderr)
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
