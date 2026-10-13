# Lab 14 — Typed Telemetry 与行为评估

[English](README.md) | 中文

**问题：** 不只读一个最终答案，怎么知道一个 Pi agent 是可靠的？
**本 lab 展示的答案：** 检查这次 run 留下的证据，分成两条互相独立的线：

- **确定性检查。** 它查过这个 booking 吗？它说出的每个标识符都来自某个 tool result 吗？状态变更是不是恰好发生了一次？
  这些是关于 transcript 和 span 的是非题，而不是答案听起来怎么样。
- **语义评分。** 答案清楚、有帮助吗？这需要 judge，所以它是一次单独的、有界的模型调用，永远不会推翻某个检查。

可以类比验收：检查清单（"封条完好吗？"）和验收员的整体印象是两回事，你绝不会让好印象去勾掉一个没通过的格子。

## 一个具体场景

你运营一个 booking 助手，想换成更便宜的模型。有人问它 *"booking `BK1001` 上有哪些 container？"*，它答：
*"BK1001 has container MSKU1234567."* 读起来没问题，审阅者通过了。

但 `BK1001` 有**两个** container，而且新模型根本没调用 `get_booking` —— 它是凭记忆答的。

- **读答案**看不出任何问题：很流畅，它说出的那一个 container 也是真的。
- **检查**同时给出两个结果：`required-tool-evidence` 失败（transcript 里没有查询，也没有 `lab.tool` span），
  `container-coverage` 失败（缺 `MSKU2345678`）。只看请求和答案的语义 judge，没有办法发现这两点。
- **跑两次**也很重要。同一个 case、同一个 prompt：一次可能有依据，下一次可能多出一句 "(format is like BK1001)" ——
  一个模型从没查过的真实 booking 号。`identifier-provenance` 会判它失败。

谁需要理解这些？**你，决定换模型或改 prompt 是否安全的开发者。** 用户完全看不到这些；本 lab 教你该记录什么、检查什么，
让这个决定建立在证据上。

| 场景里的东西 | lab 里的对应物 |
| --- | --- |
| "它真的查过吗？" | `required-tool-evidence`，从 durable transcript 读出 |
| "它说的 container 都是真的吗？" | `identifier-provenance`（booking 号和 container 号） |
| "它把所有 container 都说全了吗？" | `container-coverage` |
| "状态变更只发生了一次吗？" | `duplicate-effects` |
| 一次 run 的形状 | 由事件流建出的 `lab.*` span |
| "它清楚、有帮助吗？" | `semantic-judge.ts`，与所有检查严格分开 |

## 核心思路

Pi 把一次 run 记录成 committed events。本 lab 把一个 conversation 的事件流变成 span，并对这次 run 评分：

```text
一个 case，一个全新的 fixture，一个全新的 storage
  ├─ events (watchEvents) ──► lab.run > lab.turn > { lab.ai.request, lab.tool }   (span)
  ├─ durable entries      ──► tool call、参数、结果、答案                           (证据)
  └─ 两者                 ──► 检查：pass | fail | skipped | unavailable
                          └► 一次隔离的 judge 调用 → 一个分数，不是裁决
```

要带走的三点：

1. **一个检查有四种结果，不是两种。** `skipped` 表示不适用；`unavailable` 表示数据根本不存在（navigation 和 recovery 在事件流里永远看不到；
   除非每个 request 都带 `durationMs`，否则 latency 是 unavailable）。把 `unavailable` 并进 pass 或 fail，是要避免的错误。
2. **span 按位置嵌套，一次 run 要等两步才可读。** 事件里没有 run id 或 turn id，所以用一个栈来建模嵌套。`submission.wait()` 返回后，
   必须等终态 `submission` 事件、停掉事件流，再 flush 两个 microtask —— 这时 span 才完整且 `settled`。
3. **一次好的 run 证明得很少。** 相同的重复可能不同，所以 report 按 case 和重复分别给出，并绑定到模型、prompt 版本和 case 列表。

不涉及：托管 telemetry、exporter、dashboard、大型回归套件。六个 case、两次重复、一个模型。

## 实验

`npm run demo:telemetry-evaluation` 对真实模型运行：

1. 运行六个冻结 case × 两次重复，每次都用全新的 `BookingRepository` 和 storage。`BK1001` 有两个 container
   （`MSKU1234567`、`MSKU2345678`），`BK1002` 一个，`BK1003` 一个且为 `delivered`。
2. 给每次 run 评分，打印它的 trace，并打印其中一次 run 的 span 树。
3. 取真实捕获的证据，用三种方式弄坏它 —— 去掉查询、把状态变更翻倍、去掉 run span —— 证明每个检查恰好抓到对应的问题。
4. 让一次隔离的 judge 调用给一个答案打分。

## 测到了什么

一次真实运行，`deepseek/deepseek-flash`，`promptVersion=v2`，12 次 run（`pass / fail / skipped / unavailable`）：

| 检查 | 结果 | 检查 | 结果 |
| --- | --- | --- | --- |
| `required-tool-evidence` | 8 / 0 / 4 / 0 | `token-usage` | 12 / 0 / 0 / 0 |
| `identifier-provenance` | 12 / 0 / 0 / 0 | `latency` | 12 / 0 / 0 / 0 |
| `container-coverage` | 2 / 0 / 10 / 0 | `span:lab.tool` | 10 / 0 / 0 / 0（10 次 run 预期有 tool） |
| `duplicate-effects` | 12 / 0 / 0 / 0 | `unobservable:navigation`、`:recovery` | 各 0 / 0 / 0 / 12 |

- **12 次 run 全部到达 `done`，每个 span 都是 `settled`，bridge 没有发出 warning。**
- **这里 `latency` 通过**，因为每条 assistant message 都带 `durationMs`（例如 `status-change` 那次是 3634 ms 和 1296 ms）。
  它是 provider 的耗时，不是 span 时长 —— span 没有时间戳。
- **这次运行里没有失败，但更早的一次同样的 case 有。** 那次 `unknown-booking` 第 1 次重复说了 "format is like BK1001"，
  `identifier-provenance` 判它失败，而第 0 次通过。那次的输出没有保存在仓库里，所以把它当作观察，而不是测量；下面的离线测试可以按需复现它。
- **三个 injection 都按设计失败**，而事件流看不到的东西被报告为 `unavailable`，从不是 `fail`。
- **judge 给 `lookup-single` 打了 5/5。** 这只是对一个答案的一次调用，不能说明其他 case。

离线测试（真实 `Harness`，脚本化模型）证明了 live run 很少产生的情形：流畅但没查询的答案让 `required-tool-evidence` 失败；
重复的 `update_booking_status` 以两次真实执行让 `duplicate-effects` 失败；即使做过真实查询，只描述一个 container 的两 container booking 也会让
`container-coverage` 失败；没查过或编造的 container 让 `identifier-provenance` 失败；非法参数或未知 tool 是一个没有 warning 的 `refused` tool span。
live run 从没产生过"只说一个 container"的失败。

## 运行

```bash
cd lab-14-telemetry-evaluation
npm install
cp .env.example .env            # 然后填 DEEPSEEK_API_KEY
npm run check                   # typecheck + 121 个离线测试，不调用模型
npm run demo:telemetry-evaluation
```

手动试试：

```bash
npm run agent -- --case status-change --trace --spans             # 先是 trace，再是 span 树
npm run agent -- --case list-containers --case compare-two --repetitions 2
ls session-data                                                    # 每次 run 一个 JSONL storage
```

trace 里，`assistant (tool call) … call=<id> args=<json>` 是模型请求的，`tool_start`/`tool_end` 是 Pi 在执行；`call=` id 把它们配对。
assistant 行末尾的 `(stop=… tokens=… …ms)` 与 `lab.ai.request` span 携带的是同样三个事实。report（每个检查的 detail、每个 span、每个 tool call）
写到 `runtime-data/evaluation-report.json`。不要手改 `session-data/`。

## 自测

先回答 1–3，再跑 demo：

1. 这里是 Pi 的哪个组件在开 telemetry span？对于一个 tool call 加一个最终答案，画出 span 树。
2. `submission.wait()` 已经返回。在 `getSpans()` 完整之前，必须发生哪两件事？
3. 一个流畅的答案只提到真实的 booking 号，但从没调用 `get_booking`。哪些检查失败，哪些通过？
4. `BK1001` 有两个 container，答案只说了一个。是 provenance 还是 coverage 失败，为什么不是另一个？
5. 为什么 `latency` 离线是 `unavailable`、live 却是 `pass`，又为什么它拒绝对不完整的集合求和？
6. 为什么 judge 的分数永远不能把 `fail` 变成 `pass`？

（本 lab 没有记录 learner 的预测。）

## 值得知道

- **版本：** `pi-durable`、`pi-ai`、`chord`、`pi-telemetry` 都是 `1.1.0`。默认模型 `deepseek-flash`。`pi-durable` 是 experimental，
  所以下面的内容是先读它的类型，再观察验证。
- Pi 自己不开任何 span：在 `pi-durable`、`chord`、`pi-ai` 里 grep 找不到 `startSpan` 调用。`lab.*` 词表声明在 `src/telemetry-schema.ts`，
  `pi-telemetry` 只把它用于类型，不做校验。
- 被拒绝的调用（未知 tool、非法参数）到达时是没有 `tool_execution_start` 的 `tool_execution_end`；用脚本化模型验证过，不是读文档得来的。
- `tool_execution_end` 没有 entry，表示 task faulted 或被孤立，计为失败。这来自类型声明，由对手工构造事件的单元测试覆盖，不是 live 故障验证的。
- `containerNos` 是非空数组。一个 container 只有被**同一次 run** 里成功的 tool result 支撑，才算有依据。
- Compaction 关闭。provider/连接问题见 [Lab 01](../lab-01-pi-agent-loop/README.md)。残留的 `PI_MODEL=deepseek-v4-flash` 会在启动时以
  `Unknown model` 失败；改成 `deepseek-flash`。

## 文件位置

```text
src/harness-telemetry.ts       watchEvents -> lab.* span（在一个事件上开、在另一个事件上关）
src/telemetry-schema.ts        lab.* span 词表
src/harness-trace-logger.ts    trace：请求行 vs 执行行，每条 assistant 行带 (stop tokens ms)
src/settle.ts                  等待一个 submission 的终态事件（tracer 和 bridge 共用）
src/evidence.ts                从 durable entries 读回 tool call 和答案
src/deterministic-checks.ts    每个检查，以及哪些是 `unavailable`
src/evaluation-cases.ts        六个冻结 case、PROMPT_VERSION
src/evaluation-runner.ts       重复 × case，全新 fixture + storage，settle 顺序
src/semantic-judge.ts          那一次隔离的 judge 调用
src/span-tree.ts, report.ts, cli.ts, booking-repository.ts, *-tool.ts, create-harness.ts, session-store.ts
scripts/telemetry-evaluation-demo.ts   live 实验
tests/evaluation-runner.test.ts        核心离线证明，跑在真实 Harness 上
```
