# 字段映射与空维度

## 1. 先看 schema.json，不要直接相信 suggested_mapping

`inspect_schema.py` 会输出：

- `columns`：每列的 type、missing、unique、samples、min/max；`unique` / `samples` 是全量统计，并带 `sampled` / `sampledRows` / `totalRows` / `uniqueIsLowerBound`；
- `period_values`：期间列的去重值；
- `suggested_mapping`：按列名和类型猜的映射；
- `dimension_candidates`：所有低基数分类列的分布指标、推荐级别和理由；推荐级别按**收入**口径计算，同时保留 `topShareByRows` 供核对；
- `warnings`：缺数量、缺订单、期间过多、弱维度等风险。

AI 必须逐项核对 samples，再写 `mapping.json`。列名相似不代表语义正确，例如“销售成本-直接材料”不是总成本，“订单日期”不是期间。

## 2. mapping.json 结构

```json
{
  "source": "case.xlsx",
  "sheet": "Sheet1",
  "header_row": 0,
  "period": {
    "column": "年度",
    "base": "2023",
    "current": "2024",
    "granularity": "year"
  },
  "order": { "column": "订单号", "label": "订单" },
  "product": { "column": "产品名称", "label": "产品" },
  "customer": { "column": "客户名称", "label": "客户" },
  "qty": { "column": "数量" },
  "revenue": { "column": "销售收入" },
  "cost": { "column": "销售成本" },
  "unit_price": { "column": "单位售价" },
  "cost_components": ["销售成本-直接材料", "销售成本-直接人工", "销售成本-制造费用"],
  "dimensions": [
    { "key": "region", "label": "地区", "column": "地区", "role": "entity", "reason": "区域负责人按区域调整铺货" },
    { "key": "channel", "label": "渠道", "column": "渠道", "role": "entity" }
  ],
  "primary_dim": "customer",
  "missing_label": "未填"
}
```

必需：period、qty、revenue、cost。

至少一个实体维度：customer 或 product。可以同时没有 customer/product，但必须通过 `dimensions` 提供至少一个实体维度；一般不建议。

## 3. 空维度（extra dimensions）

`dimensions` 是开放数组，不是固定字段。用户数据里多一个“地区”“渠道”“客户类型”“行业”，就在这里加一项：

- `key`：英文小写字母开头，只含小写字母 / 数字 / 下划线；不能和保留字段或其他维度重名，冲突时 `prepare.py` 直接报错；
- `label`：页面显示名；
- `column`：源表列名；
- `role`：`entity`（默认）或 `slice`；
- `reason`：为什么这个维度值得拆；弱维度在 `--strict-dims` 下必须写。

可以加 0 个、1 个、多个。页面会自动生成维度切换 tab、象限层级和导出列，代码不需要改。

### 3.1 第一段：有没有

适合作为空维度的列：

- 文本 / 分类；
- 去重值 2–50 个；
- 不是订单号、日期、金额、数量；
- 缺失可控（最好 ≤5%，>10% 基本不建议）。

不适合：

- 唯一值接近行数的 ID；
- 日期（应该做期间，或作为 `slice`）；
- 金额 / 数量（应该做指标）；
- 全表只有一个值的列。

### 3.2 第二段：值不值得

“能拆”不等于“值得拆”。`prepare.py` 会在 `dim_diagnostics.json` 里计算：

- `nCategories`：两期分别有多少个有收入的类；
- `topShare` / `minorityShare`：最大类 / 非最大类的收入占比；
- `effectiveCategories`：`1 / Σ(类收入占比²)`，越接近 1 越像单极；
- `weightedMarginDispersion`：`Σ 类收入占比 × |类毛利率 − 总毛利率|`，即这个维度最多能把总毛利率解释出多少 pp；
- `missingRate`：空值比例（空值会归入 `missing_label`，默认“未填”）。

推荐阈值（可配置，不是法律）：

| 门槛 | 指标 | 推荐 | 需理由 | 不建议 |
| --- | --- | --- | --- | --- |
| 有 | 类别数 | 2–50 | 2–50 | <2 或 >50 |
| 有 | 缺失率 | ≤5% | 5–10% | >10% |
| 有意义 | 最大类收入占比 | ≤70% | 70–90% | >90% |
| 有意义 | 非最大类收入占比 | ≥10% | 3–10% | <3% |
| 有意义 | 有效类目数 | ≥3 | 1.5–3 | <1.5 |
| 有意义 | 毛利率加权离散 | ≥0.5pp | 0.2–0.5pp | <0.2pp |
| 有意义 | 增量性 | 与现有维度不冗余 | 部分重叠需说明 | 近似重复 |
| 有意义 | 理由 | 一句话可执行 | 有但不具体 | 无 |

判定结果：

- `intrinsic`：客户 / 产品，固有实体维度，不受门槛约束；
- `recommended`：可以直接加；
- `needs_reason`：可以加，但必须写 `reason`；
- `not_recommended`：默认不加；用户坚持要加，必须写 `reason`。

默认只告警，不自动删维度。加 `--strict-dims` 后，不达标且没有 `reason` 会失败。

> 例：内销 / 外销收入占比 99.1% / 0.9%，有效类目数 1.02，毛利率加权离散 0.19pp。虽然两类毛利率差 10.8pp，但小类权重太低，拆出来推不动总盘，应判 `not_recommended`。这就是“有差异，但没有意义”。

### 3.3 entity 与 slice

- `entity`：客户、产品、地区、渠道等经营对象；生成象限、迁移、对象级订单。
- `slice`：季度、月份、销售季节等时间切片；只做汇总 tab 和导出列，**不做象限 / 迁移**，也不能做 `primary_dim`。
- 2 个点的“象限”、4 个季度的“迁移”阅读价值有限，不要硬做。

## 4. 期间

`period.base` / `period.current` 是唯一推荐写法；`base_period` / `current_period` 只是旧 mapping 的兼容别名，新文件不要再用。

- 正好两个期间：可以自动推断 base/current，但仍建议显式写。
- 超过两个期间：必须写 `base` / `current`，程序只保留这两期，其他行记为 `skippedOtherPeriod`。
- 日期列：`granularity` 可选 `year`（默认）、`quarter`、`month`、`raw`。
- 期间值必须能稳定转成字符串；不要用“本期/上期”这种没有具体含义的标签，除非数据本身只有这两期。

## 5. 订单

- 有订单号：映射 `order.column`，订单下钻可用。
- 没有订单号：程序生成 `ROW-0000001` 行号作为订单；订单页签会隐藏，订单明细只剩单行。
- 订单号不跨期时，“新增 / 流失”是单期订单，不是同一订单搬家；报告里要讲清楚。

## 6. 数量

单价 / 单位成本象限必须有数量。缺数量时不要用 1 代替，也不要把收入当单价；先向用户确认数量列，或说明只能做收入 / 成本分析。

## 7. 成本

优先映射“销售成本 / COGS / 总成本”。不要误选“直接材料”“直接人工”“制造费用”等分项；分项之和即使相等，也不如总成本列稳定。

如果数据确实有成本分项，可在 mapping 里加 `cost_components` 数组。`prepare.py` 会逐行校验 `销售成本 = 各分项之和`，并写入 `quality.costReconciliation`；有对不上的行会直接失败。没有分项就不要加这个字段。

## 8. 主维度

`primary_dim` 决定结论层用哪个维度。默认 customer；如果数据没有客户，使用 product 或第一个 `entity` 维度。结论只讲这个主维度，其他维度在“数据定位”和“二维象限”里切换。

## 9. prepare 的产物

`prepare.py` 会写：

- `data.js` / `data.json`：页面数据。顶层是 `meta / dict / rows`；
- `data.csv`：解码后的平表，6 位小数，含 `pull / price_pull / cost_pull`；**表头是 mapping key（如 `channel` / `trade`），不是中文 label**；中文 label 看 `data.meta.dims[].label`；文件带 UTF-8 BOM，读取用 `utf-8-sig`；6 位小数逐行求和会有尾差，严格校验看 `analysis.json.checks` / 全精度结果；
- `quality.json`：负收入 / 负成本 / 负数量 / 零值等，逐项拆分；默认跳过数值缺失的明细行并记入 `skippedInvalidRows`，要严格失败用 `--strict-rows`；
- `dim_diagnostics.json`：每个维度的分布、缺失率、推荐级别和理由；
- `quality.json.checks`：基期 / 本期拉力闭合、逐行 `pull = pricePull + costPull`、字典基数；
- `quality.json.orderPeriods`：跨两期 / 仅上期 / 仅本期的订单数；
- `mapping.used.json`：折算后的 mapping（含维度 key、rowIndex、字段布局），复现时看这个，不要看原始 mapping。

`data.json.meta.fields` 与 `fieldIndex` 说明行数组每一列是什么；`pullIndex` 指向逐行拉力的第一列。上期行的 pull 已经是负数口径。
