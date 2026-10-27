---
name: gross-margin-attribution
description: 把任意 XLSX/CSV 销售明细做成毛利率归因工作台：识别并确认字段，计算拉力 / 价格拉力 / 成本拉力，动态增加客户、产品、地区、渠道等空维度，生成单文件 HTML、6 位小数 CSV 和中文解读报告。用户提到“毛利率归因”“毛利率分析”“拉高/拉低毛利率”“价格拉力/成本拉力”，或上传销售明细要做客户、产品、地区、渠道分析时使用。
---

# 毛利率归因 Skill

这个 Skill 把一份两期销售明细变成：

1. 一份可交互的单文件 HTML 工作台；
2. 一份机器可读的 `analysis.json`；
3. 一份中文解读报告；
4. 6 位小数的主明细 / 维度表 / 订单表 CSV，以及 `data.csv` 平表。

它只做数据归因，不解释业务原因。

## 读取顺序

只把本文件当执行入口，按需读取，不要一次加载整个目录：

1. 第一次执行：读本文件 + `references/concepts.md`（公式与口径）；
2. 字段 / 维度不确定：读 `references/mapping.md`；
3. 写报告：读 `references/report.md`；
4. `references/overview.md` 只解释目录、产物和维护边界，不是执行步骤。

脚本在 `$SKILL/scripts/`，模板在 `$SKILL/assets/`，案例在 `$SKILL/examples/`；这些是 Skill 的运行时资产，不要改。

## 硬规则

- **不写死字段、期间、维度、客户名、产品名。** 所有列名来自 `schema.json` + `mapping.json`。
- **不跳过字段确认。** 程序给出 `suggested_mapping`，AI 必须看 samples、类型、缺失、唯一值，再写 `mapping.json`。
- **必须有数量和两个期间。** 没有数量就不要硬做单价 × 成本象限；先向用户确认。两期总数量为 0 时 `prepare.py` 会报错，不会静默把 P0/C0 置 0。
- **空维度是开放的，但不是“能拆就拆”。** “具体变动数据”的维度 tab 不是硬编码的两个；地区、渠道等通过 `mapping.dimensions` 增加。二维象限固定为订单 / 客户 / 产品，不随空维度扩张。先用 `dimension_candidates` 看分布、缺失率和解释力，再决定加不加。
- **页面 2 位小数，导出 6 位小数。** 不要用 2 位小数导出，否则小值会变成 0。
- **HTML 工作台按页面约定显示 %；报告和 analysis.json 用 pp。** 页面里的毛利变化、拉力、价格拉力、成本拉力、成本率变化都显示成 %，这是工作台的阅读习惯；技术口径和报告仍用 pp，不要把页面标签当成统计单位。`analysis.json` / `data.json` 里的拉力是小数，`0.0191` 就是 `1.91pp`。
- **报告只写 analysis.json 能支撑的事实。** 不编业务原因。

## 目录

```text
gross-margin-attribution/
├── SKILL.md
├── scripts/
│   ├── inspect_schema.py   # 读文件、全量统计、猜字段、输出 schema.json
│   ├── prepare.py          # 校验 mapping、规范化、质量检查、维度诊断
│   ├── build.py            # 内联成单文件 HTML
│   ├── analyze.js          # 输出 analysis.json
│   └── run.py              # prepare → build → analyze 一键跑
├── assets/                 # HTML/CSS/JS 模板
├── references/
│   ├── overview.md         # 目录 / 产物 / 维护边界（非执行步骤）
│   ├── concepts.md
│   ├── mapping.md
│   └── report.md
└── examples/
    ├── case1.mapping.json
    ├── case1.schema.json
    └── case1.report.md
```

命令里的 `$SKILL` 指本文件所在目录；`$PY` 指 `load_workspace_dependencies` 返回的 Python（自带 openpyxl）。如果环境没有该工具，用已装 openpyxl 的 `python`。

Windows 下路径统一用 `/`，并在第一次写文件前先建目录：

```bash
mkdir -p work
export PYTHONIOENCODING=utf-8
```

## Step 1：接收文件

向用户确认或从上传目录找到：

- XLSX / XLSM / CSV；
- 两期销售明细；
- 至少包含：期间、数量、销售收入、销售成本；
- 建议包含：订单号、客户、产品；
- 可选：地区、渠道、客户类型、销售模式等。

如果用户只给了一个文件但没有说明期间，先看 `schema.json` 的 `period_values`，不要猜“本期/上期”。

## Step 2：检查字段，AI 确认 mapping

```bash
$PY $SKILL/scripts/inspect_schema.py "$INPUT" --out work/schema.json
```

读 `work/schema.json`，逐项确认：

- `period`：是否真的是期间？是否只有两个值？值是什么？
- `qty` / `revenue` / `cost`：是否数值？缺失多少？成本是不是总成本而不是分项？
- `order` / `customer` / `product`：samples 是否像业务对象？唯一值多少？
- `dimension_candidates`：每个候选维度的 `nCategories`、`missingRate`、`topShareByRows`、`topShareByRevenue`、`effectiveCategoriesByRevenue`、`recommendation`、`reasons`。推荐级别按收入口径，和 `prepare.py` 一致；行数口径只用于核对。
- 如果超过两个期间：必须在 mapping 里指定 `base` / `current`。
- 如果没有订单号：可以继续，程序生成行号订单；订单下钻意义有限，报告要说明。
- 如果没有数量：停止，向用户确认数量列；不要用 1 代替。

> `schema.json` 的 `unique` / `samples` 是全量统计，不是前 5,000 行。`sampled: false`、`sampledRows`、`totalRows` 会明确写出；如果以后对大文件启用采样，必须同时给出 `uniqueIsLowerBound: true`。

把确认后的 mapping 写到 `work/mapping.json`。格式见 `references/mapping.md`。

**不要把 suggested_mapping 直接复制成最终 mapping。** 它只是候选；AI 要用列 samples、分布和业务含义做最终判断。

空维度示例：

```json
"dimensions": [
  { "key": "region", "label": "地区", "column": "地区", "role": "entity", "reason": "按区域看毛利率差异，区域负责人会用来调整铺货" },
  { "key": "channel", "label": "渠道", "column": "销售渠道", "role": "entity" }
]
```

可以加 0 个、1 个或多个。页面会自动生成“客户 / 产品 / 地区 / 渠道”等维度切换 tab 和导出列；二维象限固定为“订单 / 客户 / 产品”，不需要改代码。

### 空维度的两段式门槛

第一段“有”：列存在、2–50 类、缺失可控、不是 ID / 日期 / 金额。第二段“有意义”：

| 门槛 | 指标 | 推荐 | 需理由 | 不建议 |
| --- | --- | --- | --- | --- |
| 有意义 | 最大类收入占比 | ≤70% | 70–90% | >90% |
| 有意义 | 非最大类收入占比 | ≥10% | 3–10% | <3% |
| 有意义 | 有效类目数 1/Σs² | ≥3 | 1.5–3 | <1.5 |
| 有意义 | 毛利率加权离散 | ≥0.5pp | 0.2–0.5pp | <0.2pp |
| 有意义 | 缺失率 | ≤5% | 5–10% | >10% |

- 客户 / 产品是固有实体维度，不受这套门槛约束，产品长尾也要保留。
- 不达标的维度默认 `not_recommended`，但**不自动删**；用户坚持要加，必须在 `mapping.dimensions[].reason` 写一句可执行的理由。
- `role: "slice"` 用于季度、月份、销售季节等时间切片：只做汇总 tab 和导出列，不进二维象限 / 迁移。
- 默认只告警；加 `--strict-dims` 时，`not_recommended` 或 `needs_reason` 且没有 `reason` 会直接失败。

## Step 3：跑分析

```bash
$PY $SKILL/scripts/prepare.py "$INPUT" --mapping work/mapping.json --outdir work
$PY $SKILL/scripts/build.py --data work/data.js --out work/毛利率归因工作台.html
node $SKILL/scripts/analyze.js --data work/data.js --core $SKILL/assets/core.js --out work/analysis.json

# 或一键（同样三步）
$PY $SKILL/scripts/run.py "$INPUT" --mapping work/mapping.json --outdir work

# 需要弱维度必须写理由时
$PY $SKILL/scripts/run.py "$INPUT" --mapping work/mapping.json --outdir work --strict-dims

# 数值缺失的行默认跳过并记入 quality；要严格失败时
$PY $SKILL/scripts/run.py "$INPUT" --mapping work/mapping.json --outdir work --strict-rows
```

检查：

- `prepare.py` 输出的 `rows`、`periods`、`dims`、`primaryDim`；
- `data.json` 的 **`meta.periods` / `meta.dims` / `meta.primaryDim`**。顶层是 `meta / dict / rows`，不是 `periods` / `dims`；
- `data.json.meta.fields` 与 `fieldIndex`：行是索引数组，维度位置随 mapping 变化；
- `data.json.meta.formulas`：`pull / pricePull / costPull` 已经逐行附在行尾，`pullIndex` 指向第一列；
- `quality.json` 的负收入 / 负成本 / 负数量 / 零值 / 缺失期间 / 生成订单；`skippedInvalidRows` 是数值缺失被跳过的行，报告必须说明；`generatedOrderRows` 是行号订单数。
- `dim_diagnostics.json` 的 `recommendation`、`missingRate`、`periods[*].topShare`、`weightedMarginDispersion`；
- `analysis.json` 的 `conclusion`、`support`、`dims`、`quadrants`、`orderSummary`、`dimDiagnostics`、`units`；
- `quality.json` 的 `checks`（拉力闭合、逐行恒等、字典基数）和 `orderPeriods`（跨期订单数）；
- 打开 HTML，确认维度 tab、弱维度提示、象限、点详情都能用。

如果 `rows` 为 0、两期收入有一期为 0、mapping 列找不到，先修 mapping，不要输出报告。

### data.json 行格式

```text
[periodIndex, orderIdx, productIdx, customerIdx, qty, revenue, cost,
 ...extraDimIdxs, (unitPrice,) pull, pricePull, costPull]
```

- 维度下标要用 `data.meta.dims[].rowIndex` 解码；`unitPrice` 是源表参考值，不参与拉力公式，公式用 `P0 = S0/Q0`、`C0 = K0/Q0`；
- `periodIndex` 0 = 上期，1 = 本期；
- 上期行的 `pull` 已经是负数口径，直接 `sum(本期 pull) - sum(上期 pull)` 就是毛利率变化，不要只加上期；
- 更推荐直接用 `data.csv`（已解码、6 位小数，表头是 mapping key，UTF-8 BOM，读取用 `utf-8-sig`）或 `analysis.json`；不要按中文 label 取 CSV 列；6 位小数求和有尾差，严格校验看 `analysis.json.checks`。

## Step 4：写报告

读 `references/report.md` 和 `work/analysis.json`，写 `work/报告.md`。

报告至少包含：

- 一句话：毛利率从 x% 到 y%，变化 z pp；谁拉高、谁拉低；
- 经营大盘：收入、成本、毛利、毛利率 / 成本率、价格拉力、成本拉力；
- 毛利率变动分析：主维度正向 / 负向 top，帕累托覆盖率，是否触顶；
- 毛利率构成：按所选期间（上期 / 本期）列**拉力水平**（不是拉力差），只讲客户 / 产品；默认全部对象、不截断，列对象、销售收入、销售成本、毛利率、销售占比、拉力；页面有显式“折叠 <0.01pp”开关，折叠后合计不变；点对象看该期间订单明细；
- 订单：先看 `quality.orderPeriods.crossPeriod`；跨期订单少时写“单期订单”，不要写“同一订单前后变化”。变动分析每个对象最多 15 张同向订单，覆盖率和截断说明；构成分析的订单明细按所选期间列收入 / 成本 / 毛利率 / 占比 / 拉力；
- 空维度：地区 / 渠道等有显著差异时单独讲，弱维度要标注“单极 / 解释力有限”；
- 二维象限：四象限占比变化、最大迁移路径及其成员；
- 数据质量与边界：包括 `skippedInvalidRows`、`generatedOrderRows`、`orderPeriods`；
- 不写业务原因，不把价格 / 成本拉力说成价格指数。

## 交付

至少交付：

- `work/毛利率归因工作台.html`
- `work/报告.md`
- `work/analysis.json`
- `work/data.json`
- `work/data.csv`
- `work/quality.json`
- `work/dim_diagnostics.json`
- `work/mapping.used.json`

主明细 / 维度表 / 订单表由页面导出，6 位小数；全精度底稿在“口径说明”里。

> `work/` 是生成物目录，通常被 `.gitignore` 忽略。需要把报告 / 工作台作为仓库交付物时，显式复制到 `doc/` 或改用 `--outdir out/`，不要把中间产物直接提交。

## 失败与边界

- 不是两期数据：先问用户要哪两期，或让用户提供第二期。
- 没有数量，或两期总数量为 0：停在字段确认，不要伪造单价；`prepare.py` 会直接报错。
- 期间超过两个且用户不指定：不要自己选，先问。
- 成本列只有分项：总和能对上总成本才可用；否则先问。若确认有分项列，在 mapping 写 `cost_components`，`prepare.py` 会逐行勾稽，不匹配就失败。
- 订单号不跨期：报告写“单期订单”，不要写“同一订单迁移”。
- 数据量很大：页面默认对订单 / 产品象限取 |拉力| 前 60 个；分析 JSON 仍是全量汇总。约 6,700 行 HTML 约 1.1MB；超过 2 万行先聚合 / 抽样，否则单文件 HTML 会明显变慢。
- 维度缺失值会归入“未填”，不是丢弃；报告要说明缺失率。
