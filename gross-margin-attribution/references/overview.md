# 毛利率归因 Skill：目录与产物说明

> 这不是执行入口。执行任务只看 `../SKILL.md`；本文只解释这个 Skill 由什么组成、产物是什么、维护边界在哪里。

## 1. 这个 Skill 是什么

把两期销售明细做成可复核的毛利率归因工作台：

- 先识别字段，由 AI 确认 `mapping.json`；
- 计算逐行拉力、价格拉力、成本拉力；
- 动态加入客户、产品、地区、渠道等维度；
- 输出单文件 HTML、`analysis.json`、中文报告和 6 位小数 CSV。

它只做数据归因，不解释“客户为什么降价”“成本为什么下降”这类业务原因。

## 2. 目录职责

```text
gross-margin-attribution/
├── SKILL.md              # 唯一执行入口：AI 按这里执行
├── scripts/              # 可执行工具，不写死业务字段
├── assets/               # HTML / CSS / JS 模板
├── references/           # 按需查阅的口径和说明
│   ├── overview.md       # 本文：目录、产物、维护边界
│   ├── concepts.md       # 公式：拉力、价格拉力、成本拉力、象限
│   ├── mapping.md        # 字段确认、空维度门槛、mapping 结构
│   └── report.md         # 报告结构与措辞
└── examples/             # 案例输入输出，供对照，不是执行前提
```

执行时不需要把整个目录读一遍：

1. 永远先读 `SKILL.md`；
2. 要判断字段 / 维度，读 `references/mapping.md`；
3. 要确认公式，读 `references/concepts.md`；
4. 要写报告，读 `references/report.md`；
5. 本文只在需要解释目录和产物时读。

## 3. 产物

默认输出到调用方指定的 `work/`：

```text
work/
├── schema.json             # 字段识别结果
├── mapping.json            # AI 确认后的映射
├── mapping.used.json       # 折算后的映射，复现看这个
├── data.js / data.json     # 页面数据，含逐行拉力
├── data.csv                # 解码后的平表，6 位小数；表头用 mapping key
├── quality.json            # 负收入 / 负成本 / 负数量等
├── dim_diagnostics.json    # 维度分布、缺失率、推荐级别
├── analysis.json           # 报告主事实源
├── 毛利率归因工作台.html
└── 报告.md
```

页面和报告不是同一套单位：页面按阅读习惯显示 `%`，报告用 `pp`；`analysis.json` / `data.json` 里的拉力是小数，`0.0191` 就是 `1.91pp`。

## 4. 维护边界

- `SKILL.md` 只放执行步骤和硬规则，不放安装说明、更新日志、测试说明。
- `references/` 放“需要时才查”的细节，不重复 `SKILL.md` 的步骤。
- 自动化测试放在仓库根目录 `tests/`，不属于 Skill 运行时；执行 Skill 的 AI 不需要读它，也不需要跑它。
- 改完 `scripts/` 或 `assets/` 后，由维护者在仓库根运行测试和重建单文件 HTML，避免把开发流程塞回 Skill。
