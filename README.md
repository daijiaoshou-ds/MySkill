# MySkill — 审计效率 Skill 集合

把审计一线的数据处理经验，沉淀为 AI 可执行的方法论 Skill。本仓库的理论基础是作者提出的「审计时间复杂度」与「向量空间基变换」：**基变换（降维/融合）→ 降低信息熵 → 降低审计时间复杂度**。

> 审计员 2/3 的时间花在数据处理上。优化的核心策略是：把「认知判断原子」（O(N)）尽可能转化为「界面交互原子」（O(1)）。

## 仓库结构

```text
MySkill/
├── audit-basis-sense/               # Skill 1：审计向量空间分析与基变换优化
│   ├── SKILL.md                     # 执行入口（方法论 + 7 步优化协议）
│   ├── scripts/
│   │   └── analyze_sheet_structure.py   # 读取 .xlsx，输出结构 JSON（纯标准库）
│   ├── references/
│   │   ├── theory.md                # 理论参考
│   │   ├── patterns.md              # 常见基变换模式
│   │   └── examples.md              # 实战案例
│   └── assets/
├── gross-margin-attribution/        # Skill 2：毛利率归因工作台
│   ├── SKILL.md                     # 执行入口（字段确认 → 分析 → 报告）
│   ├── scripts/
│   │   ├── inspect_schema.py        # 读文件、全量统计、猜字段 → schema.json
│   │   ├── prepare.py               # 校验 mapping、规范化、质量检查
│   │   ├── build.py                 # 内联生成单文件 HTML 工作台
│   │   ├── analyze.js               # 输出 analysis.json
│   │   └── run.py                   # prepare → build → analyze 一键跑
│   ├── assets/                      # HTML/CSS/JS 模板
│   ├── references/                  # 概念口径 / mapping 格式 / 报告规范 / 目录说明
│   └── examples/                    # 示例：schema、mapping、报告
```

## Skill 1：audit-basis-sense（审计基感知）

**解决什么问题**：Excel 底稿中大量结构雷同的 sheet 各自为政，公式要重复设置 N 遍。

**核心思路**：把一个 Excel 工作簿看成一个向量空间——每个 sheet 是一个向量，列名集合是基。当多个 sheet 仅差 1–2 列名时，新增一个维度列（如「存货类别」「月份」），把异构 sheet 融合为 1 个统一 sheet，公式即从 N 套坍缩为 1 套。

**典型收益**（来自存货底稿实战）：

| 场景 | 变换前 | 变换后 |
|------|--------|--------|
| 3 种存货 × 3 个审计程序 | 9 张 sheet、75 遍公式 | 3 张 sheet、1 套公式框架 |
| 12 个月费用报告 | 12 套公式 | 1 套公式 +「月份」列 |
| N 个部门同模板 | N 套公式 | 1 套公式 +「部门」列 |

**用法**：AI 读取 `audit-basis-sense/SKILL.md` 后，按其中的 7 步协议（清点 → 聚类 → 识别融合候选 → 提出基变换 → 估算前后复杂度 → 报告收益）分析你的工作簿；如需程序辅助，可运行：

```bash
python audit-basis-sense/scripts/analyze_sheet_structure.py <文件.xlsx>
```

脚本输出结构 JSON（含相似 sheet 分组提示），由 AI 用本 skill 方法论解读。依赖 Python 3 标准库，无需安装第三方包。

## Skill 2：gross-margin-attribution（毛利率归因）

**解决什么问题**：拿到两期销售明细后，快速回答「毛利率变化了多少、谁拉高、谁拉低」。

**输入**：XLSX / XLSM / CSV 两期销售明细，至少包含期间、数量、销售收入、销售成本；可选订单号、客户、产品、地区、渠道等维度（空维度通过 mapping 动态添加，不写死）。

**产出**：

- 单文件 HTML 交互工作台（总拉力 / 价格拉力 / 成本拉力、客户 / 产品 / 地区 / 渠道等维度 tab、二维象限与迁移路径、订单下钻）；
- 机器可读的 `analysis.json` 与中文解读报告；
- 6 位小数的主明细 / 维度表 / 订单表 CSV（页面小数 2 位仅用于显示，导出用 6 位避免小值归零）。

**执行流程**（AI 按 `gross-margin-attribution/SKILL.md` 逐步执行）：

1. `inspect_schema.py` 检查字段 → AI 看 samples / 类型 / 缺失率后确认 mapping（不直接采用猜测结果）；
2. `run.py` 一键完成 prepare → build → analyze；
3. 按 `references/report.md` 规范写报告——只写 analysis.json 能支撑的事实，不编业务原因。

关键约束：必须有数量列和两个期间；期间超过两个时由用户指定 base / current；维度添加遵循两段式门槛（有 → 有意义），弱维度需写明理由。

## 设计原则（两个 Skill 共通）

- **入口唯一**：只以 SKILL.md 为执行入口，references 按需读取，不一次加载整个目录。
- **不写死业务字段**：所有列名、期间、维度来自 schema + mapping，靠 AI 确认而非猜测。
- **脚本与认知分离**：脚本只负责结构提取和数值计算，判断与解读交给 AI 依据方法论完成。
- **可校验**：输出 quality.json / checks（拉力闭合、逐行恒等、字典基数），异常先报错不静默降级。

## 适用环境

- Python ≥ 3.10（`inspect_schema.py` 纯标准库；`gross-margin-attribution` 的 prepare/build 依赖 openpyxl）；
- Node.js（仅 `gross-margin-attribution` 的 `analyze.js` 需要）；
- Windows 下路径统一用 `/`，运行前设置 `PYTHONIOENCODING=utf-8`。

## License

本项目基于 [MIT License](LICENSE) 开源。
