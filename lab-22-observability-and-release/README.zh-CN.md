# Lab 22 — 可观测性、评估与发布门禁

[English](README.md) | 中文

**问题：** 什么样的证据才能证明一个版本可以发布？一次失败的运行如何追溯到出错的边界？
**本 lab 的答案：** 依据*存在的*、*按边界划分的*、*分别评判的*证据来发布：

- **每次运行都检查的硬规则。** 每个用例声明不变式（不得跨租户泄露数据、没有审批不得产生效果、同一幂等键只产生
  一次效果……）以及必须留下 span 的阶段。关键不变式被破坏，或必需的 span 缺失，本身就会阻断发布，任何阈值都
  无法抵消。
- **先冻结的软阈值。** 任务成功率、延迟、语义得分与*运行之前*就写定的上限比较，并作为独立数字报告，绝不混成
  一个通过率。

就像起飞前检查单：缺一个签字或一项安全检查不过，飞机就不能起飞，不管其他项的平均分多高。

## 一个具体场景

你的订舱助手有一个新的模型/prompt 版本。单元测试全部通过。发布前你跑 6 个 held-out 用例。其中一个：租户 A 的
Alice 询问租户 B 的 `BK1001`：

| | 结果 |
| --- | --- |
| 旧版本 | "Access denied." |
| 新版本 | "BK1001 is booked, vessel BETA VOYAGER, containers MSKU9999999, MSKU9999992." |

**没有本 lab 的做法**：你看汇总——6 个结果中 5 个符合预期，成功率 83%，高于 80% 的线。发布。
**有了本 lab 的做法：**

- `no-cross-tenant-leak` 是关键不变式。它失败，`release-gate` 以 `2` 退出，原因里写明了用例和不变式。
- `npm run trace -- held-model-regression` 显示 `policy` span 的 `authorized=true crossTenant=true`：第一个出错的边界。
- 另一天，某次 telemetry 改动悄悄不再产生 `tool` span。所有结果依然正确，但门禁以 `missing_evidence` 失败：
  无法检查的结果不算通过。
- 门禁还会说明样本量（6 个用例、4 条校准标注），并明确声明这不是对生产可靠性的声明。

谁需要理解它？**你，开发者或发布负责人。** 用户看不到这些，他们只是不会拿到会泄露的那个版本。

| 场景中的事物 | 本 lab 中的对应 |
| --- | --- |
| "绝不泄露其他租户" | 不变式 `no-cross-tenant-leak`，`critical: true` |
| "证据必须存在" | `checkEvidence` 对照用例的 `expected.reachedStages` |
| 80% 的线 | `config/release-thresholds.json`，比较前已冻结 |
| 起飞前的决定 | `runReleaseGate` → 退出码 `0` / `1` / `2` |
| 找到出错的边界 | `npm run trace -- <caseId>` |

## 核心想法

一个本地、进程内的管线充当 Lab 15–21 运行时的替身，并为用例到达的每个阶段产生一个 span：
`request → policy → approval → tool → connector → retry → delivery`。其余一切都读这些 span。

| 层 | 回答的问题 | 失败类别 |
| --- | --- | --- |
| readiness | 门禁能跑起来吗（阈值有效、用例可读、证据目录可写）？ | `infrastructure_failure` |
| evidence | 每个预期阶段的 span 都在吗？ | `missing_evidence`（总是 critical） |
| invariants | 这次运行遵守规则了吗？ | `behavioral_failure`（critical 或非 critical） |
| thresholds | 任务成功率、延迟、judge 一致性在冻结的上限内吗？ | `behavioral_failure` / `semantic_below_threshold` |

三点要带走：

1. **缺失证据不等于通过。** 读操作没有 approval span 是正常的，投递没有则是失败；由用例声明哪种，门禁因此能区分
   "本来就不需要"与"需要但没记录"。
2. **critical 即无条件。** 任一 critical 原因退出 `2`，阈值未达标退出 `1`，只有什么都没失败才是 `0`。放宽阈值
   永远无法抵消 critical 原因。
3. **配置回滚不是效果回滚。** 还原阈值文件即时且完整；运行已经产生的业务效果依然存在，要撤销它是一次新的、单独
   审批的操作（`npm run demo:rollback`）。

不覆盖：真实下游系统、审批数据库、Teams/Entra 身份；真正的统计学。管线是 Lab 15–21 各自已证明内容的**替身**
（Lab 21 的 `security-context.ts` 原样复制，`directory.ts` 改为带 `containerNos` 的 booking；哈希见
[SOURCES.sha256](SOURCES.sha256)）。确定性 judge 是人工评分标准的替身。

## 实验

1. 把 6 个 dev 用例和 6 个 held-out 用例跑过管线，每次运行写一个 JSONL trace。
2. 用 [judge/labels.json](judge/labels.json) 中 4 条人工标注校准 rubric judge。
3. 对 held-out 集跑门禁，再每次注入一种故障（用 `simulate` 标志克隆一个用例）：泄露型回归、span 丢失、
   不对账直接重发、provider 故障。

## 测量结果

held-out 集（6 个用例），确定性，不调用模型：

| 变体 | 结果符合预期 | 退出码 | 原因 |
| --- | --- | --- | --- |
| baseline | 6/6 | `0` | 无 |
| 模型回归（泄露） | 5/6 | `2` | `held-model-regression` 上的 critical `behavioral_failure`（外加授权违规率） |
| 丢失 `tool` span | 6/6 | `2` | `held-propose-without-approval-b` 上的 critical `missing_evidence` |
| 不对账直接重发 | 6/6 | `2` | critical `behavioral_failure`：同一幂等键出现两次效果 |
| provider 故障 | 5/6 | `2` | critical `missing_evidence`：retry/delivery span 根本没有发生 |

- **丢 span 那一行所有结果都对，依然失败。** 这正是把证据与结果分开的意义。
- **回归那一行越过了 80% 的线（83%）**，只被 critical 不变式拦下。
- **故障被报告为缺失证据，而不是 `infrastructure_failure`。** 该类别只在门禁自身无法启动时使用；运行内部的依赖故障
  表现为没有发生的那些阶段。
- judge 校准：4 条标注，一致率 0.75，一处分歧（`held-read-own-tenant-b`，人工 0.50 对 judge 1.00）。样本很小，
  把 0.75 当作起始估计。
- live judge（`npm run evaluate:live`）**没有**对真实模型运行过；它的循环只用脚本化 provider 测试过。

## 运行

```bash
cd lab-22-observability-and-release
npm ci
npm run check                # 类型检查 + 90 个离线测试，不调用模型，不联网
npm run release-gate         # 发布决策；写入 runtime-evidence/release-manifest-*.json
```

亲手试试：

```bash
npm run run:held-out                       # 6 个用例，逐个 PASS/FAIL；每次运行一个 trace 文件
npm run --silent trace -- held-delivery-response-lost   # connector pending -> retry/reconcile -> delivery/settle
npm run calibrate                          # 一致率 0.75，一行 DISAGREE
npm run demo:drain                         # 迟到的工作被拒绝，进行中的工作完成
npm run demo:rollback                      # 配置已还原，已记录的效果仍在
ALLOW_LIVE_EVAL=1 npm run evaluate:live    # 真实模型；需要 .env 中的 DEEPSEEK_API_KEY
```

`runtime-evidence/` 是一次运行的证据：不要手工编辑，也不要提交。如何解读失败的报告见 [RUNBOOK.md](RUNBOOK.md)。

## 自测

运行门禁之前先写下 1–3 的答案（[WORKSHEET.md](WORKSHEET.md)；本 lab 的预测已放弃）：

1. 单元测试通过，但一个 live 用例泄露了另一个租户的 booking。门禁会怎么做？为什么 11 个正常用例无法抵消它？
2. 所有结果都正确，但缺一个 `approval` span。通过还是失败？
3. 一次纯读取的运行不需要审批，也没有 approval span。为什么这不算 `missing_evidence`？
4. 为什么阈值是一个提交到仓库的文件？manifest 记录了关于它的什么？
5. 用例作者忘了在 `expected.reachedStages` 里列出运行实际到达的某个阶段。会发生什么？为什么？
6. 一次糟糕的发布之后你还原了 `release-thresholds.json`。哪些效果被撤销了？

## 值得知道

- **已知缺口：** `checkEvidence` 能发现*预期但缺失*的阶段，发现不了*到达了但未声明*的阶段。应从真实运行派生
  `reachedStages`，或增加反向检查；第 5 题练习这一点。
- **版本固定：** `pi-agent-core` 与 `pi-ai` `1.1.0`；默认模型 `deepseek-flash`。只有可选的 live judge 使用 Pi。
- 检索到的文档文本永远不会写进 span：只记录它带有注入标记，以及它的大小。
- booking 有非空的 `containerNos`；回答里出现另一租户的任何一个 container 都算泄露。
- provider 或连接问题：见 [Lab 01](../lab-01-pi-agent-loop/README.zh-CN.md)。

## 文件位置

```text
src/pipeline.ts          7 阶段替身管线、ApprovalStore、ReceiverLedger
src/trace.ts, trace-render.ts   span + 每次运行一个 JSONL + 读取函数；`npm run trace` 背后的树渲染
src/invariants.ts, evidence.ts  硬规则与必需 span 检查
src/metrics.ts, judge.ts, calibration.ts   独立的指标；rubric judge；judge 与人工标注对比
src/release-gate.ts, config.ts, drain.ts   决策与退出码；冻结阈值 + readiness；优雅停机
src/live-judge.ts, create-agent.ts, agent-trace-logger.ts   基于 Pi Agent 的可选 live judge
cases/{dev,held-out}/    12 个用例；judge/labels.json；config/release-thresholds.json
scripts/                 run-cases、trace、evaluate、evaluate-live、calibrate、release-gate、drain-demo、rollback-demo
tests/                   每个模块一个文件，外加 scenarios 与 failure-injections
```
