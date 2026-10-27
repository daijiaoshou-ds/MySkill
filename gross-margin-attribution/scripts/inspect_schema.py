#!/usr/bin/env python3
"""Inspect an XLSX/CSV sales file and propose a field mapping.

This script never decides the final mapping. It reports column profiles and a
suggested mapping; the agent must review samples and write mapping.json.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import difflib
import json
import math
import os
import re
import sys
from collections import Counter, OrderedDict
from pathlib import Path

try:
    from openpyxl import load_workbook
except Exception as exc:  # pragma: no cover
    print(f"openpyxl import failed: {exc}", file=sys.stderr)
    load_workbook = None

KEYWORDS = {
    "period": ["期间", "年度", "年份", "年月", "月份", "日期", "period", "year", "month", "date"],
    "order": ["订单号", "订单编号", "单号", "订单", "order", "invoice", "so_no", "so"],
    "product": ["产品", "产品名称", "物料", "物料名称", "物料编码", "存货", "存货编码", "存货名称", "商品", "商品编码", "商品名称", "品项", "sku", "item", "product"],
    "customer": ["客户", "客户名称", "经销商", "customer", "client", "buyer"],
    "qty": ["数量", "销量", "销售量", "qty", "quantity", "units"],
    "revenue": ["销售收入", "销售额", "收入", "营收", "金额", "revenue", "sales", "amount"],
    "cost": ["销售成本", "成本", "cogs", "cost"],
    "unit_price": ["单位售价", "单价", "售价", "unit price", "price"],
}
DIMENSION_HINTS = ["地区", "区域", "省份", "城市", "渠道", "销售渠道", "客户类型", "销售模式", "贸易方式", "行业", "segment", "region", "area", "channel"]
SLICE_HINTS = ["季节", "季度", "月份", "年度", "年份", "周", "week", "month", "quarter", "year", "season"]

# 把常见中文分类列映射成稳定英文 key；未知列再用拼音无关的通用 key。
KEY_HINTS = [
    ("内销/外销", "domestic_export"),
    ("内销外销", "domestic_export"),
    ("销售季节", "season"),
    ("客户类型", "customer_type"),
    ("销售模式", "sales_mode"),
    ("销售渠道", "channel"),
    ("贸易方式", "trade_mode"),
    ("地区", "region"),
    ("区域", "region"),
    ("省份", "province"),
    ("城市", "city"),
    ("渠道", "channel"),
    ("行业", "industry"),
    ("季节", "season"),
    ("季度", "quarter"),
    ("月份", "month"),
    ("segment", "segment"),
    ("region", "region"),
    ("channel", "channel"),
]


def _utf8_stdout() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass


def cell_text(v) -> str:
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v).strip()


def parse_number(v):
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
            return None
        return float(v)
    s = cell_text(v).replace(",", "").replace("，", "")
    s = s.replace("￥", "").replace("¥", "").replace("$", "").replace("%", "")
    neg = s.startswith("(") and s.endswith(")")
    if neg:
        s = s[1:-1]
    s = s.strip()
    if not s or s in {"-", "—", "N/A", "n/a", "NA", "null", "None"}:
        return None
    try:
        x = float(s)
    except ValueError:
        return None
    return -x if neg else x


def parse_date(v):
    if v is None or v == "":
        return None
    if isinstance(v, dt.datetime):
        return v.date()
    if isinstance(v, dt.date):
        return v
    s = cell_text(v)
    if not s:
        return None
    s = s.replace("年", "-").replace("月", "-").replace("日", "").replace("/", "-").replace(".", "-")
    s = re.sub(r"\s+.*$", "", s)
    for fmt in ("%Y-%m-%d", "%Y-%m", "%Y%m%d", "%Y-%m-%d %H:%M:%S", "%Y"):
        try:
            return dt.datetime.strptime(s[:len(fmt) + 8], fmt).date()
        except ValueError:
            pass
    m = re.match(r"^(\d{4})(\d{2})?$", s)
    if m:
        try:
            return dt.date(int(m.group(1)), int(m.group(2) or 1), 1)
        except ValueError:
            return None
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})", s)
    if m:
        try:
            return dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None
    return None


def read_table(path: str, sheet: str | None):
    p = Path(path)
    if p.suffix.lower() in {".xlsx", ".xlsm"}:
        if load_workbook is None:
            raise SystemExit(
                "openpyxl is required to read xlsx; use the DSH bundled Python "
                "or run: python -m pip install openpyxl"
            )
        wb = load_workbook(p, read_only=True, data_only=True)
        ws = wb[sheet] if sheet else wb.worksheets[0]
        rows = [list(r) for r in ws.iter_rows(values_only=True)]
        names = wb.sheetnames
        title = ws.title
        wb.close()
        return rows, names, title
    if p.suffix.lower() == ".csv":
        last_err = None
        for enc in ("utf-8-sig", "gb18030", "utf-8"):
            try:
                text = p.read_text(encoding=enc)
                sample = text[:8192]
                try:
                    dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
                except csv.Error:
                    dialect = csv.excel
                rows = [list(r) for r in csv.reader(text.splitlines(), dialect)]
                return rows, [], "CSV"
            except UnicodeDecodeError as e:
                last_err = e
        raise RuntimeError(f"cannot decode CSV: {last_err}")
    raise RuntimeError("only .xlsx / .xlsm / .csv are supported; convert .xls first")


def find_header(rows):
    best = (0, -1.0)
    for i, row in enumerate(rows[:30]):
        cells = [cell_text(v) for v in row if cell_text(v)]
        if len(cells) < 2:
            continue
        text_ratio = sum(1 for c in cells if parse_number(c) is None) / len(cells)
        hits = 0
        for c in cells:
            lc = c.lower()
            for words in KEYWORDS.values():
                if any(w.lower() in lc for w in words):
                    hits += 1
        score = hits * 3 + min(len(cells), 12) * 0.15 + text_ratio * 1.5 + (0.4 if i == 0 else 0)
        if score > best[1]:
            best = (i, score)
    return best[0] if best[1] >= 3 else 0


def unique_headers(header):
    out, seen = [], Counter()
    for i, v in enumerate(header):
        name = cell_text(v) or f"列{i + 1}"
        seen[name] += 1
        out.append(name if seen[name] == 1 else f"{name}_{seen[name]}")
    return out


def column_key(name: str) -> str:
    s = re.sub(r"[^0-9A-Za-z_]+", "_", name.strip().lower()).strip("_")
    if not s or s[0].isdigit():
        s = "dim_" + (s or "x")
    return s[:40]


def stable_dim_key(name: str, fallback: str) -> str:
    n = re.sub(r"\s+", "", name).lower()
    for hint, key in KEY_HINTS:
        if hint.lower() in n:
            if key == "trade_mode":
                if "外销" in n:
                    return "trade_mode_export"
                if "合同" in n:
                    return "trade_mode_contract"
            return key
    ascii_key = re.sub(r"[^0-9a-z_]+", "_", n).strip("_")
    if ascii_key and not ascii_key[0].isdigit():
        return ascii_key[:40]
    return fallback


def stratified_sample(keys, n=8):
    """Evenly spread samples over the full distinct list, including the tail."""
    if len(keys) <= n:
        return list(keys)
    out, seen = [], set()
    for i in range(n):
        idx = round(i * (len(keys) - 1) / (n - 1))
        if idx not in seen:
            seen.add(idx)
            out.append(keys[idx])
    return out


def profile(rows, header):
    names = unique_headers(header)
    total_rows = len(rows)
    cols = []
    for ci, name in enumerate(names):
        values = []
        present = 0
        for row in rows:
            v = row[ci] if ci < len(row) else None
            if v is None or cell_text(v) == "":
                continue
            present += 1
            values.append(v)
        nums = [parse_number(v) for v in values]
        num_ok = sum(1 for x in nums if x is not None)
        dates = [parse_date(v) for v in values]
        date_ok = sum(1 for x in dates if x is not None)
        typ = "string"
        if values and num_ok / len(values) >= 0.85:
            typ = "number"
        elif values and date_ok / len(values) >= 0.8:
            typ = "date"
        if not values:
            typ = "empty"

        counts = Counter()
        for v in values:
            if typ == "date":
                d = parse_date(v)
                k = d.isoformat() if d else cell_text(v)
            elif typ == "number":
                x = parse_number(v)
                k = "" if x is None else str(x)
            else:
                k = cell_text(v)
            if k:
                counts[k] += 1
        uniq = len(counts)
        samples = stratified_sample(list(counts.keys()), 8)
        nums_clean = [x for x in nums if x is not None]
        col = {
            "index": ci,
            "name": name,
            "type": typ,
            "present": present,
            "missing": max(0, total_rows - present),
            "unique": uniq,
            "unique_ratio": round(uniq / present, 4) if present else 0,
            "samples": samples,
            "sampled": False,
            "sampledRows": total_rows,
            "totalRows": total_rows,
            "uniqueIsLowerBound": False,
        }
        if typ == "number" and nums_clean:
            col["min"] = min(nums_clean)
            col["max"] = max(nums_clean)
        col["_counts"] = counts
        cols.append(col)
    return cols


def keyword_score(name, words):
    lc = name.lower()
    return sum(1 for w in words if w.lower() in lc)


def best_column(cols, words, typ=None, exclude=None):
    exclude = set(exclude or [])
    ranked = []
    for c in cols:
        if c["index"] in exclude:
            continue
        if typ and c["type"] != typ:
            continue
        ks = keyword_score(c["name"], words)
        if ks:
            ranked.append((ks, -c["missing"], c))
    if not ranked:
        return None
    ranked.sort(key=lambda x: (x[0], x[1]), reverse=True)
    return ranked[0][2]


def is_slice_name(name: str) -> bool:
    lc = name.lower()
    return any(h.lower() in lc for h in SLICE_HINTS)


def similar_columns(a, b) -> bool:
    na = re.sub(r"[\s（）()_\-]+", "", a.get("column") or a.get("name") or "")
    nb = re.sub(r"[\s（）()_\-]+", "", b.get("column") or b.get("name") or "")
    if na == nb:
        return True
    if len(na) >= 4 and len(nb) >= 4 and (na.startswith(nb[:4]) or nb.startswith(na[:4])):
        return True
    return difflib.SequenceMatcher(None, na, nb).ratio() >= 0.62


def _revenue_metrics_for_period(body, dim_i, rev_i, cost_i, period_i, period, period_is_date=False):
    groups = {}
    total_rev = 0.0
    total_cost = 0.0
    for r in body:
        if period_i is not None:
            raw_period = r[period_i] if period_i < len(r) else None
            if period_is_date:
                d = parse_date(raw_period)
                period_value = str(d.year) if d else cell_text(raw_period)
            else:
                period_value = cell_text(raw_period)
            if period_value != period:
                continue
        rev = parse_number(r[rev_i] if rev_i is not None and rev_i < len(r) else None)
        cost = parse_number(r[cost_i] if cost_i is not None and cost_i < len(r) else None)
        if rev is None:
            continue
        cat = cell_text(r[dim_i] if dim_i < len(r) else "")
        g = groups.setdefault(cat, {"rev": 0.0, "cost": 0.0})
        g["rev"] += rev
        if cost is not None:
            g["cost"] += cost
        total_rev += rev
        if cost is not None:
            total_cost += cost
    if total_rev <= 1e-12:
        return {"nCategories": 0, "topShare": None, "minorityShare": None,
                "effectiveCategories": None, "weightedMarginDispersion": None}
    shares = {k: v["rev"] / total_rev for k, v in groups.items() if v["rev"] > 1e-12}
    if not shares:
        return {"nCategories": 0, "topShare": None, "minorityShare": None,
                "effectiveCategories": None, "weightedMarginDispersion": None}
    top = max(shares.values())
    effective = 1.0 / sum(s * s for s in shares.values())
    overall_gm = 1 - total_cost / total_rev
    dispersion = 0.0
    for k, share in shares.items():
        rev = groups[k]["rev"]
        gm = 1 - groups[k]["cost"] / rev
        dispersion += share * abs(gm - overall_gm)
    return {
        "nCategories": len(shares),
        "topShare": top,
        "minorityShare": 1 - top,
        "effectiveCategories": effective,
        "weightedMarginDispersion": dispersion,
    }


def _revenue_judge(stats, missing_rate, has_reason):
    periods = [v for v in stats.values() if v["topShare"] is not None]
    if not periods:
        return "not_recommended", "low"
    top = max(v["topShare"] for v in periods)
    minority = min(v["minorityShare"] for v in periods)
    effective = min(v["effectiveCategories"] for v in periods)
    dispersion = max(v["weightedMarginDispersion"] for v in periods)
    if top > 0.9 or minority < 0.03 or effective < 1.5 or dispersion < 0.002:
        return "not_recommended", "low"
    if missing_rate > 0.1 or top > 0.7 or minority < 0.1 or effective < 3 or dispersion < 0.005 or not has_reason:
        return "needs_reason", "medium"
    return "recommended", "high"


def _augment_with_revenue(candidates, body, cols, period_i, rev_i, cost_i, base, cur, period_is_date=False):
    by_name = {c["name"]: c["index"] for c in cols}
    for c in candidates:
        dim_i = by_name.get(c["column"])
        if dim_i is None or rev_i is None:
            continue
        stats = {
            base: _revenue_metrics_for_period(body, dim_i, rev_i, cost_i, period_i, base, period_is_date),
            cur: _revenue_metrics_for_period(body, dim_i, rev_i, cost_i, period_i, cur, period_is_date),
        }
        periods = [v for v in stats.values() if v["topShare"] is not None]
        if periods:
            c["metrics"]["topShareByRevenue"] = round(max(v["topShare"] for v in periods), 4)
            c["metrics"]["minorityShareByRevenue"] = round(min(v["minorityShare"] for v in periods), 4)
            c["metrics"]["effectiveCategoriesByRevenue"] = round(min(v["effectiveCategories"] for v in periods), 3)
            c["metrics"]["weightedMarginDispersionByRevenue"] = round(max(v["weightedMarginDispersion"] for v in periods), 6)
            c["metrics"]["periodsByRevenue"] = stats
        if c.get("redundantWith"):
            continue
        recommendation, confidence = _revenue_judge(stats, c["metrics"]["missingRate"], True)
        c["recommendation"] = recommendation
        c["confidence"] = confidence
        kept = [r for r in c["reasons"] if "按行数" not in r and "有效类目数" not in r]
        rev_reasons = []
        for period, st in stats.items():
            if st["topShare"] is None:
                continue
            if st["topShare"] > 0.9:
                rev_reasons.append(f"{period} 最大类收入占比 {st['topShare'] * 100:.1f}%，接近单极")
            elif st["topShare"] > 0.7:
                rev_reasons.append(f"{period} 最大类收入占比 {st['topShare'] * 100:.1f}%，需要一句业务理由")
            if st["minorityShare"] < 0.03:
                rev_reasons.append(f"{period} 非最大类收入仅 {st['minorityShare'] * 100:.1f}%")
            if st["effectiveCategories"] < 1.5:
                rev_reasons.append(f"{period} 收入有效类目数 {st['effectiveCategories']:.2f}")
            elif st["effectiveCategories"] < 3:
                rev_reasons.append(f"{period} 收入有效类目数偏低 {st['effectiveCategories']:.2f}")
            if st["weightedMarginDispersion"] < 0.002:
                rev_reasons.append(f"{period} 毛利率加权离散 {st['weightedMarginDispersion'] * 100:.2f}pp，解释力不足")
        c["reasons"] = kept + rev_reasons
        if not c["reasons"]:
            c["reasons"] = ["收入口径分布均衡"]


def suggest(cols):
    used = set()
    out = {}

    def take(field, words, typ=None):
        c = best_column(cols, words, typ, used)
        if c:
            used.add(c["index"])
            out[field] = {"column": c["name"], "confidence": "high", "reason": "列名命中关键词"}
        return c

    take("period", KEYWORDS["period"])
    take("order", KEYWORDS["order"])
    take("product", KEYWORDS["product"])
    take("customer", KEYWORDS["customer"])
    take("qty", KEYWORDS["qty"], "number")
    take("revenue", KEYWORDS["revenue"], "number")
    take("cost", KEYWORDS["cost"], "number")
    take("unit_price", KEYWORDS["unit_price"], "number")

    # fallbacks by type / cardinality
    if "period" not in out:
        dates = [c for c in cols if c["type"] == "date" and c["unique"] >= 2]
        if dates:
            c = dates[0]
            out["period"] = {"column": c["name"], "confidence": "medium", "reason": "唯一日期列"}
            used.add(c["index"])

    def fallback_text(field, max_unique=300):
        if field in out:
            return
        candidates = [c for c in cols if c["index"] not in used and c["type"] == "string"
                      and 2 <= c["unique"] <= max_unique]
        if not candidates:
            return
        # prefer low missing, high cardinality but not ID-like
        candidates.sort(key=lambda c: (c["missing"], -min(c["unique"], 50)))
        c = candidates[0]
        out[field] = {"column": c["name"], "confidence": "low", "reason": "按文本基数推断，需人工确认"}
        used.add(c["index"])

    fallback_text("customer")
    fallback_text("product")

    # extra dimensions: remaining categorical columns, with distribution metrics
    candidates = []
    for c in cols:
        if c["index"] in used or c["type"] != "string":
            continue
        if c["unique"] < 2 or c["unique"] > 60 or c["unique_ratio"] > 0.9:
            continue
        lc = c["name"].lower()
        if any(x in lc for x in ["订单", "单号", "编号", "id", "日期", "时间"]):
            continue
        counts = c["_counts"]
        present = sum(counts.values()) or 1
        shares = [v / present for v in counts.values()]
        top_share = max(shares) if shares else 0
        effective = 1 / sum(x * x for x in shares) if shares else 0
        missing_rate = c["missing"] / c["totalRows"] if c["totalRows"] else 0
        hint = any(h.lower() in lc for h in DIMENSION_HINTS)
        role = "slice" if is_slice_name(c["name"]) else "entity"
        reasons = []
        if hint:
            reasons.append("列名命中分类维度关键词")
        if missing_rate > 0:
            reasons.append(f"缺失 {missing_rate * 100:.1f}% 的行会归入“未填”")
        if top_share > 0.9:
            reasons.append(f"最大类按行数占 {top_share * 100:.1f}%，接近单极")
        elif top_share > 0.7:
            reasons.append(f"最大类按行数占 {top_share * 100:.1f}%，需要一句业务理由")
        if effective < 1.5:
            reasons.append(f"有效类目数仅 {effective:.2f}")
        if role == "slice":
            reasons.append("时间切片维度：只做汇总和导出，不做象限 / 迁移")
        if missing_rate > 0.1 or top_share > 0.9 or effective < 1.5:
            recommendation = "not_recommended"
        elif missing_rate > 0.05 or top_share > 0.7 or effective < 3:
            recommendation = "needs_reason"
        else:
            recommendation = "recommended"
        confidence = "high"
        if missing_rate > 0.1 or top_share > 0.95 or effective < 1.5:
            confidence = "low"
        elif missing_rate > 0.05 or top_share > 0.7 or effective < 3:
            confidence = "medium"
        candidates.append({
            "key": stable_dim_key(c["name"], f"extra_{c['index'] + 1}"),
            "label": c["name"],
            "column": c["name"],
            "role": role,
            "confidence": confidence,
            "recommendation": recommendation,
            "reasons": reasons or ["低基数分类列"],
            "metrics": {
                "nCategories": c["unique"],
                "missingRate": round(missing_rate, 4),
                "topShareByRows": round(top_share, 4),
                "minorityShareByRows": round(1 - top_share, 4),
                "effectiveCategoriesByRows": round(effective, 3),
                "uniqueRatio": c["unique_ratio"],
            },
        })

    # 稳定排序：推荐优先，其次有效类目多、缺失少；切片不抢主维度。
    rank = {"recommended": 0, "needs_reason": 1, "not_recommended": 2}
    candidates.sort(key=lambda d: (
        rank[d["recommendation"]],
        0 if d["role"] == "entity" else 1,
        -d["metrics"]["effectiveCategoriesByRows"],
        d["metrics"]["missingRate"],
    ))

    # 近似重复列：保留缺失更少、语义更完整的一列。
    kept = []
    for d in candidates:
        dup = next((k for k in kept if similar_columns(k, d)), None)
        if dup:
            d["redundantWith"] = dup["key"]
            d["recommendation"] = "not_recommended"
            d["confidence"] = "low"
            d["reasons"].append(f"与“{dup['label']}”近似重复，保留缺失更少的列")
        else:
            kept.append(d)

    seen_keys = set()
    for i, d in enumerate(candidates, 1):
        key = d["key"]
        if key in seen_keys:
            key = f"{key}_{i}"
            d["key"] = key
        seen_keys.add(key)

    dims = [d for d in candidates if d["recommendation"] in {"recommended", "needs_reason"}]
    return out, dims, candidates


def main():
    _utf8_stdout()
    ap = argparse.ArgumentParser(description="Inspect XLSX/CSV and propose a mapping")
    ap.add_argument("input")
    ap.add_argument("--sheet", default=None)
    ap.add_argument("--header-row", type=int, default=None)
    ap.add_argument("--out", default="work/schema.json")
    ap.add_argument("--max-rows", type=int, default=0)
    args = ap.parse_args()

    rows, sheets, sheet = read_table(args.input, args.sheet)
    if not rows:
        raise SystemExit("empty file")
    hdr = args.header_row if args.header_row is not None else find_header(rows)
    header = rows[hdr]
    body = [r for r in rows[hdr + 1:] if any(cell_text(v) for v in r)]
    full_count = len(body)
    if args.max_rows:
        body = body[:args.max_rows]
    cols = profile(body, header)
    if args.max_rows:
        for c in cols:
            c["sampled"] = True
            c["sampledRows"] = len(body)
            c["totalRows"] = full_count
            c["uniqueIsLowerBound"] = True
    suggested, dims, candidates = suggest(cols)
    for c in cols:
        c.pop("_counts", None)

    period_col = next((c for c in cols if suggested.get("period") and c["name"] == suggested["period"]["column"]), None)
    periods = []
    if period_col:
        vals = []
        typ = period_col["type"]
        for r in body:
            v = r[period_col["index"]] if period_col["index"] < len(r) else None
            if typ == "date":
                d = parse_date(v)
                if d:
                    vals.append(str(d.year))
            else:
                x = cell_text(v)
                if x:
                    vals.append(x)
        periods = sorted(set(vals), key=lambda x: (len(x), x))
        if len(periods) == 1:
            periods = []
    base_period = periods[0] if len(periods) == 2 else None
    current_period = periods[1] if len(periods) == 2 else None
    if isinstance(suggested.get("period"), dict):
        suggested["period"]["base"] = base_period
        suggested["period"]["current"] = current_period
    # Keep only the canonical nested form; prepare.py still accepts the old
    # top-level aliases for backward compatibility, but generated mappings
    # should not teach two competing shapes.
    suggested.pop("base_period", None)
    suggested.pop("current_period", None)

    # Align schema warnings with prepare.py: judge dimensions by revenue share,
    # not by row count. Keep row metrics for transparency, but the decision is
    # revenue-based whenever revenue can be resolved.
    rev_col = next((c for c in cols if suggested.get("revenue") and c["name"] == suggested["revenue"]["column"]), None)
    cost_col = next((c for c in cols if suggested.get("cost") and c["name"] == suggested["cost"]["column"]), None)
    if base_period and current_period and rev_col is not None:
        _augment_with_revenue(
            candidates, body, cols,
            period_col["index"] if period_col else None,
            rev_col["index"], cost_col["index"] if cost_col else None,
            base_period, current_period, period_col["type"] == "date" if period_col else False,
        )
        dims = [c for c in candidates if c["recommendation"] in {"recommended", "needs_reason"}]

    # Use first entity as primary; never make a time slice primary.
    entities = [k for k in ("customer", "product") if suggested.get(k)]
    entities.extend(d["key"] for d in dims if d["role"] == "entity")
    suggested["dimensions"] = dims
    suggested["primary_dim"] = entities[0] if entities else None
    suggested["dimension_candidates"] = candidates

    warnings = []
    if not suggested.get("qty"):
        warnings.append("未识别数量列；如果数据确实没有数量，单价/单位成本象限不可用，请向用户确认。")
    if not suggested.get("order"):
        warnings.append("未识别订单号；系统会生成行号作为订单，订单下钻意义有限。")
    for key, label in (("product", "产品"), ("customer", "客户")):
        spec = suggested.get(key)
        if isinstance(spec, dict) and spec.get("confidence") == "low":
            warnings.append(
                f"{label}列是按文本基数推断的（{spec.get('column')}），必须人工确认；"
                "如果它实际是渠道 / 类型，请改放到 mapping.dimensions，不要把分类列当产品。"
            )
    if len(periods) > 2:
        warnings.append(f"检测到 {len(periods)} 个期间：{periods}；必须在 mapping.period 中指定 base / current。")
    if not periods:
        warnings.append("未识别出两个期间；请检查期间列。")
    if not suggested.get("revenue") or not suggested.get("cost"):
        warnings.append("收入或成本列未识别，无法计算毛利率归因。")
    if len(dims) > 6:
        warnings.append(f"检测到 {len(dims)} 个候选空维度，建议只保留业务上需要分析的维度。")
    if args.max_rows:
        warnings.append(f"--max-rows 只分析了前 {len(body):,} / {full_count:,} 行；unique 是下界，samples 不是全表。")
    for d in candidates:
        if d["recommendation"] == "not_recommended":
            warnings.append(f"候选维度“{d['label']}”不建议直接加入：{'；'.join(d['reasons'])}")

    result = {
        "source": os.path.abspath(args.input),
        "file_type": Path(args.input).suffix.lower().lstrip("."),
        "sheet": sheet,
        "sheet_names": sheets,
        "header_row": hdr,
        "header": [cell_text(v) for v in header],
        "row_count": len(body),
        "period_values": periods,
        "columns": cols,
        "suggested_mapping": suggested,
        "dimension_candidates": candidates,
        "warnings": warnings,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(json.dumps({
        "out": os.path.abspath(args.out),
        "rows": len(body),
        "header_row": hdr,
        "periods": periods,
        "columns": len(cols),
        "suggested": {k: v for k, v in suggested.items() if k not in {"dimensions", "dimension_candidates"}},
        "dimensions": dims,
        "dimension_candidates": candidates,
        "warnings": warnings,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
