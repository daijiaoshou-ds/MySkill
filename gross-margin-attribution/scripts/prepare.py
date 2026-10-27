#!/usr/bin/env python3
"""Validate a reviewed mapping, normalize the source file, and emit data.js."""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import math
import os
import re
import sys
from collections import Counter, OrderedDict
from pathlib import Path

from inspect_schema import cell_text, parse_date, parse_number, read_table

RESERVED = {
    "period", "order", "product", "customer", "qty", "qty_num", "rev", "revenue",
    "cost", "unitprice", "unit_price", "delta", "dprice", "dcost", "gm0", "gm1",
    "dgm", "p0", "c0", "p1", "c1", "w0", "w1", "status", "key", "year",
    "pull", "pricepull", "costpull", "pullindex", "fieldindex",
}
EPS = 1e-12


def _utf8_stdout() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass


def spec_column(spec, field):
    if spec is None:
        return None
    if isinstance(spec, str):
        return spec
    if isinstance(spec, dict):
        return spec.get("column")
    raise ValueError(f"{field} must be a column name or an object with column")


def slug(text: str, fallback: str) -> str:
    s = re.sub(r"[^0-9A-Za-z_]+", "_", str(text).strip().lower()).strip("_")
    if not s or s[0].isdigit():
        s = fallback
    return s[:48]


def normalize_period(value, granularity: str):
    if value is None:
        return ""
    d = parse_date(value)
    if d:
        if granularity == "month":
            return d.strftime("%Y-%m")
        if granularity == "quarter":
            return f"{d.year}Q{(d.month - 1) // 3 + 1}"
        if granularity == "raw":
            return d.isoformat()
        return str(d.year)
    s = cell_text(value)
    if re.fullmatch(r"-?\d+\.0+", s):
        s = s.split(".")[0]
    return s


def pct(x):
    return None if x is None else round(float(x) * 100, 4)


def period_stats(groups, total_rev, total_cost):
    """Metrics for one period, used to judge whether a dimension is meaningful."""
    if total_rev is None or total_rev <= EPS:
        return {
            "nCategories": 0, "topShare": None, "minorityShare": None,
            "effectiveCategories": None, "weightedMarginDispersion": None,
            "totalRevenue": total_rev,
        }
    shares = {}
    for key, v in groups.items():
        if v["rev"] > EPS:
            shares[key] = v["rev"] / total_rev
    if not shares:
        return {
            "nCategories": 0, "topShare": None, "minorityShare": None,
            "effectiveCategories": None, "weightedMarginDispersion": None,
            "totalRevenue": total_rev,
        }
    top = max(shares.values())
    effective = 1.0 / sum(s * s for s in shares.values())
    overall_gm = 1 - total_cost / total_rev if total_rev > EPS else None
    disp = 0.0
    for key, s in shares.items():
        rev = groups[key]["rev"]
        if rev > EPS and overall_gm is not None:
            gm = 1 - groups[key]["cost"] / rev
            disp += s * abs(gm - overall_gm)
    return {
        "nCategories": len(shares),
        "topShare": top,
        "minorityShare": 1 - top,
        "effectiveCategories": effective,
        "weightedMarginDispersion": disp,
        "totalRevenue": total_rev,
    }


def judge_dimension(key, role, stats_by_period, missing_rate, has_reason):
    if key in {"customer", "product"}:
        return "intrinsic"
    periods = [v for v in stats_by_period.values() if v["topShare"] is not None]
    if not periods:
        return "not_recommended"
    top = max(v["topShare"] for v in periods)
    minority = min(v["minorityShare"] for v in periods)
    effective = min(v["effectiveCategories"] for v in periods)
    disp = max(v["weightedMarginDispersion"] for v in periods)
    if top > 0.9 or minority < 0.03 or effective < 1.5 or disp < 0.002:
        return "not_recommended"
    if missing_rate > 0.1 or top > 0.7 or minority < 0.1 or effective < 3 or disp < 0.005 or not has_reason:
        return "needs_reason"
    return "recommended"


def main():
    _utf8_stdout()
    ap = argparse.ArgumentParser(description="Prepare normalized data for the attribution app")
    ap.add_argument("input")
    ap.add_argument("--mapping", required=True)
    ap.add_argument("--outdir", default="work")
    ap.add_argument("--sheet", default=None)
    ap.add_argument("--header-row", type=int, default=None)
    ap.add_argument("--strict-dims", action="store_true",
                    help="fail when a weak extra dimension has no written reason")
    ap.add_argument("--strict-rows", action="store_true",
                    help="fail instead of skipping rows with non-numeric qty/revenue/cost")
    args = ap.parse_args()

    mapping = json.load(open(args.mapping, encoding="utf-8"))
    rows, sheets, sheet = read_table(args.input, args.sheet or mapping.get("sheet"))
    hdr = args.header_row if args.header_row is not None else mapping.get("header_row")
    if hdr is None:
        # Let the inspector's detector decide if no explicit header row.
        from inspect_schema import find_header
        hdr = find_header(rows)
    header = [cell_text(v) for v in rows[hdr]]
    col_index = {}
    for i, name in enumerate(header):
        if name and name not in col_index:
            col_index[name] = i

    def need(field, required=True):
        name = spec_column(mapping.get(field), field)
        if not name:
            if required:
                raise SystemExit(f"mapping.{field}.column is required")
            return None
        if name not in col_index:
            raise SystemExit(f"column not found: {field} -> {name!r}; header={header}")
        return col_index[name]

    period_i = need("period")
    order_i = need("order", required=False)
    product_i = need("product", required=False)
    customer_i = need("customer", required=False)
    qty_i = need("qty")
    rev_i = need("revenue")
    cost_i = need("cost")
    up_i = need("unit_price", required=False)

    period_spec = mapping.get("period") or {}
    granularity = period_spec.get("granularity", "raw") if isinstance(period_spec, dict) else "raw"
    base_want = mapping.get("base_period") or (period_spec.get("base") if isinstance(period_spec, dict) else None)
    cur_want = mapping.get("current_period") or (period_spec.get("current") if isinstance(period_spec, dict) else None)

    body = [r for r in rows[hdr + 1:] if any(cell_text(v) for v in r)]
    normalized = []
    skipped_period = 0
    skipped_invalid = []
    for source_row, r in enumerate(body, start=hdr + 2):
        def get(i):
            return r[i] if i is not None and i < len(r) else None
        p = normalize_period(get(period_i), granularity)
        if not p:
            skipped_period += 1
            continue
        qty = parse_number(get(qty_i))
        rev = parse_number(get(rev_i))
        cost = parse_number(get(cost_i))
        if qty is None or rev is None or cost is None:
            skipped_invalid.append({
                "sourceRow": source_row,
                "qty": qty, "revenue": rev, "cost": cost,
                "preview": [cell_text(v) for v in r[:8]],
            })
            if args.strict_rows:
                raise SystemExit(
                    f"non-numeric qty/revenue/cost at row {source_row}: {r[:8]}; "
                    "use --strict-rows to fail fast, or omit it to skip and report"
                )
            continue
        normalized.append({
            "period": p,
            "order": cell_text(get(order_i)) if order_i is not None else "",
            "product": cell_text(get(product_i)) if product_i is not None else "",
            "customer": cell_text(get(customer_i)) if customer_i is not None else "",
            "qty": qty, "rev": rev, "cost": cost,
            "unit_price": parse_number(get(up_i)) if up_i is not None else None,
            "row": r,
        })

    periods = sorted(set(x["period"] for x in normalized))
    if base_want is None or cur_want is None:
        if len(periods) != 2:
            raise SystemExit(f"need exactly 2 periods or explicit base/current; found {periods}")
        base, cur = periods
    else:
        base, cur = str(base_want), str(cur_want)
        if base not in periods or cur not in periods:
            raise SystemExit(f"base/current not found in periods {periods}: {base}, {cur}")
    before = len(normalized)
    normalized = [x for x in normalized if x["period"] in (base, cur)]
    skipped_other = before - len(normalized)
    if not normalized:
        raise SystemExit("no usable rows left after period filtering / invalid-row skipping")
    if skipped_invalid:
        print(
            f"[rows] WARN skipped {len(skipped_invalid)} row(s) with non-numeric qty/revenue/cost; "
            f"first source row {skipped_invalid[0]['sourceRow']}",
            file=sys.stderr,
        )

    # Entity dimensions
    entities = []

    def add_entity(key, label, idx, column, fixed=False):
        if idx is None:
            return
        entities.append({"key": key, "label": label, "rowIndex": idx, "role": "entity", "column": column})

    # data row layout is fixed: [period, order, product, customer, qty, revenue, cost, ...].
    # rowIndex is a position in that row, not the source Excel column index.
    add_entity("customer",
               (mapping.get("customer") or {}).get("label", "客户") if isinstance(mapping.get("customer"), dict) else "客户",
               3, spec_column(mapping.get("customer"), "customer"))
    add_entity("product",
               (mapping.get("product") or {}).get("label", "产品") if isinstance(mapping.get("product"), dict) else "产品",
               2, spec_column(mapping.get("product"), "product"))

    extra_dims = []
    used_keys = {"customer", "product", "order"}
    used_cols = {period_i, order_i, product_i, customer_i, qty_i, rev_i, cost_i, up_i}
    for n, d in enumerate(mapping.get("dimensions") or []):
        name = spec_column(d, "dimensions")
        if not name or name not in col_index:
            raise SystemExit(f"dimension column not found: {d!r}")
        ci = col_index[name]
        if ci in used_cols:
            continue
        requested_key = d.get("key")
        key = str(requested_key) if requested_key else slug(name, "dim_" + str(n + 1))
        if not re.fullmatch(r"[a-z][a-z0-9_]{0,47}", key):
            raise SystemExit(
                "invalid dimension key " + repr(key) + "; use lowercase letters, digits and _, starting with a letter"
            )
        if key in used_keys or key in RESERVED:
            raise SystemExit(
                "dimension key " + repr(key) + " is reserved or already used; rename mapping.dimensions[].key"
            )
        used_keys.add(key)
        used_cols.add(ci)
        role = str(d.get("role") or "entity")
        if role not in {"entity", "slice"}:
            raise SystemExit(f"dimension role must be entity or slice: {d!r}")
        extra_dims.append({
            "key": key,
            "label": str(d.get("label") or name),
            "rowIndex": 7 + len(extra_dims),
            "role": role,
            "column": name,
            "reason": str(d.get("reason") or ""),
            "missingLabel": str(d.get("missingLabel") or mapping.get("missing_label") or "未填"),
        })

    if not entities and not extra_dims:
        raise SystemExit("at least one of customer/product/dimensions is required")

    # Order: real or synthetic (one row = one order)
    synthetic_order = order_i is None
    generated_order_rows = 0
    order_values = []
    for idx, x in enumerate(normalized):
        generated = False
        if synthetic_order:
            v = f"ROW-{idx + 1:07d}"
            generated = True
        else:
            v = x["order"]
            if not v:
                v = f"ROW-{idx + 1:07d}"
                generated = True
        if generated:
            generated_order_rows += 1
        x["order"] = v
        order_values.append(v)
    order_dim = {"key": "order", "label": str((mapping.get("order") or {}).get("label", "订单")) if isinstance(mapping.get("order"), dict) else "订单",
                 "rowIndex": 1, "role": "order", "synthetic": synthetic_order}

    base_orders = {x["order"] for x in normalized if x["period"] == base}
    cur_orders = {x["order"] for x in normalized if x["period"] == cur}
    order_periods = {
        "base": len(base_orders),
        "current": len(cur_orders),
        "crossPeriod": len(base_orders & cur_orders),
        "baseOnly": len(base_orders - cur_orders),
        "currentOnly": len(cur_orders - base_orders),
    }

    # Fill extra dimensions and record missing values before filling.
    missing_counts = {d["key"]: 0 for d in extra_dims}
    missing_total = {d["key"]: 0 for d in extra_dims}
    for x in normalized:
        vals = x["row"]
        for d in extra_dims:
            ci = col_index[d["column"]]
            raw = cell_text(vals[ci] if ci < len(vals) else None)
            if not raw:
                missing_counts[d["key"]] += 1
            missing_total[d["key"]] += 1
            x[d["key"]] = raw or d["missingLabel"]

    # Dictionaries, sorted for stable display
    def uniq(vals):
        return sorted({str(v) for v in vals})

    dims_meta = [order_dim] + entities + extra_dims
    dicts = {}
    for d in dims_meta:
        if d["key"] == "order":
            vals = [x["order"] for x in normalized]
        else:
            vals = [x.get(d["key"], "") for x in normalized]
        dicts[d["key"]] = uniq(vals)

    idx_maps = {k: {v: i for i, v in enumerate(vals)} for k, vals in dicts.items()}
    unit_price_index = (7 + len(extra_dims)) if up_i is not None else None

    # Period totals and per-row pull values.  They are appended to each row so
    # consumers can reproduce numbers without importing core.js.
    S0 = sum(x["rev"] for x in normalized if x["period"] == base)
    K0 = sum(x["cost"] for x in normalized if x["period"] == base)
    Q0 = sum(x["qty"] for x in normalized if x["period"] == base)
    S1 = sum(x["rev"] for x in normalized if x["period"] == cur)
    K1 = sum(x["cost"] for x in normalized if x["period"] == cur)
    Q1 = sum(x["qty"] for x in normalized if x["period"] == cur)
    if S0 <= EPS or S1 <= EPS:
        raise SystemExit("base/current revenue is empty")
    R0 = (S0 - K0) / S0
    if Q0 <= EPS or Q1 <= EPS:
        raise SystemExit(
            "base/current total quantity is zero; cannot compute weighted unit price / unit cost. "
            f"Q0={Q0:g}, Q1={Q1:g}. Check the qty column or provide a usable quantity measure."
        )
    P0 = S0 / Q0
    C0 = K0 / Q0

    data_rows = []
    for x in normalized:
        p = 0 if x["period"] == base else 1
        vals = [
            p,
            idx_maps["order"][x["order"]],
            idx_maps["product"][x["product"]] if product_i is not None else 0,
            idx_maps["customer"][x["customer"]] if customer_i is not None else 0,
            round(x["qty"], 10), round(x["rev"], 10), round(x["cost"], 10),
        ]
        for d in extra_dims:
            vals.append(idx_maps[d["key"]][x[d["key"]]])
        if unit_price_index is not None:
            vals.append(x["unit_price"] if x["unit_price"] is not None else 0)

        S = S0 if p == 0 else S1
        pull = ((1 - R0) * x["rev"] - x["cost"]) / S
        price = (1 - R0) * (x["rev"] - P0 * x["qty"]) / S
        cost_pull = (C0 * x["qty"] - x["cost"]) / S
        vals.extend([pull, price, cost_pull])
        data_rows.append(vals)

    fields = ["period", "order", "product", "customer", "qty", "revenue", "cost"]
    fields.extend(d["key"] for d in extra_dims)
    if unit_price_index is not None:
        fields.append("unitPrice")
    pull_index = len(fields)
    fields.extend(["pull", "pricePull", "costPull"])
    field_index = {name: i for i, name in enumerate(fields)}

    primary = mapping.get("primary_dim") or ("customer" if customer_i is not None else ("product" if product_i is not None else entities[0]["key"]))
    primary_meta = next((d for d in dims_meta if d["key"] == primary), None)
    if primary_meta is None or primary_meta.get("role") != "entity":
        raise SystemExit(f"primary_dim must be an entity dimension: {primary}")

    # Quality: split negative / zero by measure instead of reporting only a union.
    def rows_with(pred):
        return [x for x in normalized if pred(x)]

    neg_rev = rows_with(lambda x: x["rev"] < 0)
    neg_cost = rows_with(lambda x: x["cost"] < 0)
    neg_qty = rows_with(lambda x: x["qty"] < 0)
    R1 = (S1 - K1) / S1
    base_pull_sum = sum(row[pull_index] for row in data_rows if row[0] == 0)
    current_pull_sum = sum(row[pull_index] for row in data_rows if row[0] == 1)
    dgm = R1 - R0
    max_identity_error = max(
        abs(row[pull_index] - row[pull_index + 1] - row[pull_index + 2])
        for row in data_rows
    ) if data_rows else 0.0
    closure_error = max(abs(base_pull_sum), abs(current_pull_sum - dgm))
    if closure_error > 1e-9:
        raise SystemExit(
            "pull closure failed: "
            f"base sum={base_pull_sum:.12g}, current sum={current_pull_sum:.12g}, dGM={dgm:.12g}"
        )
    if max_identity_error > 1e-9:
        raise SystemExit(f"pull identity failed: max |pull - pricePull - costPull|={max_identity_error:.12g}")
    checks = {
        "basePullSum": base_pull_sum,
        "currentPullSum": current_pull_sum,
        "dGM": dgm,
        "pullClosureError": closure_error,
        "maxPriceCostError": max_identity_error,
        "dictionary": {d["key"]: len(dicts[d["key"]]) for d in dims_meta},
    }

    quality = {
        "sourceRows": len(body),
        "usableRows": len(normalized),
        "skippedMissingPeriod": skipped_period,
        "skippedOtherPeriod": skipped_other,
        "skippedInvalidRows": len(skipped_invalid),
        "skippedInvalidExamples": skipped_invalid[:5],
        "periods": periods,
        "base": base,
        "current": cur,
        "negativeRows": sum(1 for x in normalized if x["rev"] < 0 or x["cost"] < 0 or x["qty"] < 0),
        "negativeRevenueRows": len(neg_rev),
        "negativeRevenueSum": sum(x["rev"] for x in neg_rev),
        "negativeCostRows": len(neg_cost),
        "negativeCostSum": sum(x["cost"] for x in neg_cost),
        "negativeQtyRows": len(neg_qty),
        "negativeQtySum": sum(x["qty"] for x in neg_qty),
        "zeroRevenueRows": sum(1 for x in normalized if abs(x["rev"]) < EPS),
        "zeroCostRows": sum(1 for x in normalized if abs(x["cost"]) < EPS),
        "zeroQtyRows": sum(1 for x in normalized if abs(x["qty"]) < EPS),
        "syntheticOrder": synthetic_order,
        "generatedOrderRows": generated_order_rows,
        "generatedOrderRate": generated_order_rows / len(normalized) if normalized else 0,
        "orderPeriods": order_periods,
        "dimensions": {d["key"]: len(dicts[d["key"]]) for d in dims_meta},
        "checks": checks,
    }

    # Optional cost reconciliation: only runs when mapping.cost_components is
    # supplied. Do not infer component columns automatically; many files have
    # subtotals or tax lines that look like components.
    component_names = mapping.get("cost_components") or []
    if isinstance(component_names, str):
        component_names = [component_names]
    if component_names:
        component_idx = []
        for name in component_names:
            if name not in col_index:
                raise SystemExit(f"cost component column not found: {name!r}; header={header}")
            component_idx.append(col_index[name])
        mismatch = 0
        max_diff = 0.0
        for x in normalized:
            raw = x["row"]
            vals = [parse_number(raw[i] if i < len(raw) else None) for i in component_idx]
            if any(v is None for v in vals):
                continue
            diff = abs(sum(vals) - x["cost"])
            max_diff = max(max_diff, diff)
            if diff > max(1e-6, abs(x["cost"]) * 1e-6):
                mismatch += 1
        quality["costReconciliation"] = {
            "components": list(component_names),
            "checkedRows": len(normalized),
            "mismatchRows": mismatch,
            "maxAbsDiff": max_diff,
        }
        if mismatch:
            raise SystemExit(
                f"cost reconciliation failed: {mismatch} rows where cost != {' + '.join(component_names)}; "
                f"max diff={max_diff:.6g}"
            )

    # Dimension diagnostics: "has a column" is not enough; check distribution,
    # missing rate and weighted margin dispersion before recommending a dimension.
    dim_diagnostics = {}
    period_rev = {base: S0, cur: S1}
    period_cost = {base: K0, cur: K1}
    for d in dims_meta:
        if d["key"] == "order":
            continue
        key = d["key"]
        groups = {base: {}, cur: {}}
        for x in normalized:
            g = groups[x["period"]].setdefault(x.get(key, ""), {"rev": 0.0, "cost": 0.0})
            g["rev"] += x["rev"]
            g["cost"] += x["cost"]
        stats = {
            base: period_stats(groups[base], period_rev[base], period_cost[base]),
            cur: period_stats(groups[cur], period_rev[cur], period_cost[cur]),
        }
        if key in missing_counts:
            missing_rows = missing_counts[key]
            missing_denom = missing_total[key] or 1
        else:
            ci = col_index.get(d.get("column") or "")
            missing_rows = 0
            missing_denom = len(normalized)
            if ci is not None:
                for x in normalized:
                    r = x["row"]
                    if ci >= len(r) or not cell_text(r[ci]):
                        missing_rows += 1
        missing_rate = missing_rows / missing_denom if missing_denom else 0
        role = d.get("role", "entity")
        reason = (d.get("reason") or "").strip()
        recommendation = judge_dimension(key, role, stats, missing_rate, bool(reason))
        reasons = []
        if role == "slice":
            reasons.append("时间切片：只做汇总 / 导出，不做象限和迁移")
        if missing_rate > 0:
            reasons.append(f"缺失率 {missing_rate * 100:.1f}%，空值归入“{d.get('missingLabel', '未填')}”")
        for label, st in ((base, stats[base]), (cur, stats[cur])):
            if st["topShare"] is None:
                continue
            if st["topShare"] > 0.9:
                reasons.append(f"{label} 最大类收入占比 {st['topShare'] * 100:.1f}%，接近单极")
            elif st["topShare"] > 0.7:
                reasons.append(f"{label} 最大类收入占比 {st['topShare'] * 100:.1f}%，需要一句业务理由")
            if st["minorityShare"] < 0.03:
                reasons.append(f"{label} 非最大类仅 {st['minorityShare'] * 100:.1f}%")
            if st["effectiveCategories"] < 1.5:
                reasons.append(f"{label} 有效类目数 {st['effectiveCategories']:.2f}")
            elif st["effectiveCategories"] < 3:
                reasons.append(f"{label} 有效类目数偏低 {st['effectiveCategories']:.2f}")
            if st["weightedMarginDispersion"] < 0.002:
                reasons.append(f"{label} 毛利率加权离散 {st['weightedMarginDispersion'] * 100:.2f}pp，解释力不足")
        if key in {"customer", "product"}:
            reasons.append("固有实体维度，不受空维度门槛约束")
        if not reasons:
            reasons.append("分布均衡，可用作分析维度")
        dim_diagnostics[key] = {
            "key": key,
            "label": d["label"],
            "role": role,
            "recommendation": recommendation,
            "reason": reason,
            "missingRate": round(missing_rate, 4),
            "missingRows": missing_rows,
            "missingLabel": d.get("missingLabel"),
            "periods": stats,
            "reasons": reasons,
        }

    if any(v["recommendation"] == "not_recommended" for v in dim_diagnostics.values()):
        for v in dim_diagnostics.values():
            if v["recommendation"] == "not_recommended":
                print(f"[dims] WARN {v['label']}: not_recommended; {'; '.join(v['reasons'])}", file=sys.stderr)
                if args.strict_dims and not v["reason"]:
                    raise SystemExit(f"dimension {v['label']} is not recommended and has no reason; add mapping.dimensions[].reason or drop it")
    if args.strict_dims:
        for v in dim_diagnostics.values():
            if v["recommendation"] == "needs_reason" and not v["reason"]:
                raise SystemExit(f"dimension {v['label']} needs a written reason; add mapping.dimensions[].reason")

    meta = {
        "source": os.path.basename(args.input),
        "sheet": sheet,
        "base": base,
        "current": cur,
        "periods": periods,
        "rowCount": len(data_rows),
        "header": header,
        "dims": dims_meta,
        "primaryDim": primary,
        "orderSynthetic": synthetic_order,
        "unitPriceIndex": unit_price_index,
        "fields": fields,
        "fieldIndex": field_index,
        "pullIndex": pull_index,
        "units": {
            "pull": "fraction of period revenue; 0.0191 = 1.91pp",
            "pricePull": "fraction of period revenue; 0.0191 = 1.91pp",
            "costPull": "fraction of period revenue; 0.0191 = 1.91pp",
            "unitPrice": "reference only; not used in pull formulas",
        },
        "unitPriceNote": "unitPrice comes from the source column; pull formulas use P0 = S0 / Q0 and C0 = K0 / Q0, not this column.",
        "formulas": {
            "pull": "((1 - R0) * revenue - cost) / periodRevenue",
            "pricePull": "(1 - R0) * (revenue - P0 * qty) / periodRevenue",
            "costPull": "(C0 * qty - cost) / periodRevenue",
            "delta": "current pull sum - base pull sum; base rows carry negative pull",
        },
        "quality": quality,
        "dimDiagnostics": dim_diagnostics,
    }
    data = {"meta": meta, "dict": dicts, "rows": data_rows}

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    with open(outdir / "data.js", "w", encoding="utf-8") as f:
        f.write("window.GM_DATA = ")
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
    with open(outdir / "data.json", "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    # Flat CSV: same rows, 6 decimals, headers are mapping keys (not display labels).
    with open(outdir / "data.csv", "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        header_out = ["period", "order", "product", "customer", "qty", "revenue", "cost"]
        header_out.extend(d["key"] for d in extra_dims)
        if unit_price_index is not None:
            header_out.append("unit_price")
        header_out.extend(["pull", "price_pull", "cost_pull"])
        w.writerow(header_out)
        for row in data_rows:
            p = row[0]
            out = [base if p == 0 else cur,
                   dicts["order"][row[1]] if "order" in dicts else "",
                   dicts["product"][row[2]] if "product" in dicts else "",
                   dicts["customer"][row[3]] if "customer" in dicts else ""]
            out.extend([f"{row[4]:.6f}", f"{row[5]:.6f}", f"{row[6]:.6f}"])
            for d in extra_dims:
                out.append(dicts[d["key"]][row[d["rowIndex"]]])
            if unit_price_index is not None:
                out.append(f"{row[unit_price_index]:.6f}")
            out.extend([f"{row[pull_index]:.6f}", f"{row[pull_index + 1]:.6f}", f"{row[pull_index + 2]:.6f}"])
            w.writerow(out)

    used = dict(mapping)
    used["_used"] = {"base": base, "current": cur, "dims": dims_meta, "primaryDim": primary,
                     "fields": fields, "fieldIndex": field_index}
    with open(outdir / "mapping.used.json", "w", encoding="utf-8") as f:
        json.dump(used, f, ensure_ascii=False, indent=2)
    with open(outdir / "quality.json", "w", encoding="utf-8") as f:
        json.dump(quality, f, ensure_ascii=False, indent=2)
    with open(outdir / "dim_diagnostics.json", "w", encoding="utf-8") as f:
        json.dump(dim_diagnostics, f, ensure_ascii=False, indent=2)

    print(json.dumps({
        "outdir": str(outdir.resolve()),
        "rows": len(data_rows),
        "periods": [base, cur],
        "dims": [d["key"] + ":" + d["label"] for d in dims_meta],
        "primaryDim": primary,
        "syntheticOrder": synthetic_order,
        "quality": quality,
        "dimDiagnostics": {k: v["recommendation"] for k, v in dim_diagnostics.items()},
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
