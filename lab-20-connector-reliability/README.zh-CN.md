# Lab 20 — Connector 可靠性与执行预算

[English](README.md) | 中文

> **剧透提醒。** 本 README 会给出答案。请先在 [WORKSHEET.md](WORKSHEET.md) 里记录你的预测（或写 `waived`），
> 再继续阅读或运行 `npm run demo:faults`。

**问题：** 当外部 API 很慢、被限流、返回畸形数据，或只部分成功时，助手如何完成有界的工作，并且仍然准确地描述结果？
**本 lab 的答案：** 把"要不要重试、等多久、何时停止"全部放在应用代码里，并且由应用（而不是 model）来说明哪里不完整。

- **重试只有一个负责方，且处处有上限。** 只有 connector 会重试 booking API，并且依据失败的*类别*决定（403 永不重试；
  429 在服务端要求的等待之后重试），同时受单请求、整个 run 和 deadline 三层预算约束。
- **结果诚实。** 总量和"cutoff 是否已过"由已校验的数据计算；不完整的 listing 永远不会产出总量；
  无论 model 怎么写，应用都会附上一条 note 说明缺了什么。

可以把它想成：快递员每个包裹只有固定的派送次数，并且由经理在单子上写"未送达"，而不是指望快递员自己记得。

## 一个具体场景

运营人员问助手：*"`BK1001` 的 container 总重是多少？文件截单时间过了吗？"*
booking 服务在一个 HTTP API 后面，五个 container 分在三页里。

| 发生了什么 | 没有本 lab 的做法 | 有本 lab 的做法 |
| --- | --- | --- |
| 第 2 页连续三次返回 `503` | model 反复调用 tool，每次调用内部又重试，等待时间和费用成倍增长 | 一个负责方重试，3 次尝试、短暂等待，然后停止并报告 `unavailable` |
| API 返回 `429`、`Retry-After: 2` | 盲目 sleep，或者猛刷 API | 在限额允许时恰好等 2 秒，然后成功 |
| API 返回 `403` | 一个永远不可能成功的重试循环 | 只发一次请求，报告为 `forbidden` |
| 5 个 container 只到了 2 个 | model 把手头的加起来，把总量当作事实说出来 | 总量是 `UNKNOWN`；回答附带应用 note，说明数据不完整 |
| 运营人员关掉了页面 | run 和 API 请求继续跑 | abort 传到打开的 socket，API 看到请求被放弃 |

谁需要理解这些？**你，开发者。** 运营人员看到的是一句说明"哪些已知、哪些未知"的话；API 的所有者看到的是更少、更守规矩的请求。

| 场景里的东西 | lab 里的对应 |
| --- | --- |
| 决定要不要再试 | `HttpBookingConnector.request`，由 `FailureCategory` 驱动 |
| 快递员的尝试次数上限 | `maxAttemptsPerRequest`，以及 `RunBudget` 里整个 run 的 attempt 预算 |
| 写着"未送达"的单子 | run 结果里的 `applicationNote` 和 `completeness` |
| 运营人员离开 | `root.abort()` → tool 的 abort signal → `fetch` |

## 核心想法

```text
HTTP 请求 ─ 鉴权 ─ 准入队列（有界）─ ChatService ─ Pi run ─ lookup_booking ─ connector ─ booking API
                                       │ 预算：turn、tool call、page、attempt、context、output、deadline
                                       └ 结果：answer + completeness + 预算用量 + 每一次 HTTP 尝试
```

1. **按类别重试，并明确归属。** booking API 只由 connector 重试。model 调用只由 harness 重试（`settings.retry`，
   provider SDK 自带的重试固定为 0）。model 再次调用 tool 时，消耗的是同一份 run 级 attempt 预算，所以重试不会相乘。
2. **先预留，再花费。** 每次 tool call、每一页、每次 HTTP attempt 都在发出之前预留。预算耗尽会阻止*新的*工作，
   但不会取消或退还已经发出的工作。
3. **完整性看身份，不看数量。** 一个 booking 有一个或多个 container（`containerNos`）。只有 listing 里的 container
   恰好等于这个集合才算完整，所以被换掉的 container 会被发现，外来的 container 不会增加重量。

未覆盖：写操作和未知 outcome（Lab 21）、真实 endpoint、Lab 15/17/18/19（本 lab 复制了 Lab 19 的身份处理，
只给任何拥有 role 的 principal 提供一个只读 tool）。

## 实验

`npm run demo:faults` 会启动一个本地 fake booking API（真实 HTTP，带脚本化故障）和一个脚本化的 model，
让 roadmap 里的失败注入走完整条路径。不联网，不用真实 model。

## 测量结果

来自 demo 的一次运行。"API 请求数"是 fake API 为这一次查询收到的全部请求（booking 记录加最多三页 container）。

| 注入的故障 | API 请求数 | 等待 | 结果 |
| --- | --- | --- | --- |
| `403` | 1 | – | `unavailable`，`forbidden`，1 次尝试 |
| `429`，`Retry-After: 2`，随后成功 | 5 | 2000 ms | `complete` |
| `429`，`Retry-After: 30` | 1 | – | `unavailable`；因等待超出预算而停止，报告了服务端要求的 30 秒 |
| `503` 两次后成功 | 6 | 10 + 20 ms | `complete` |
| `503` 一直 | 3 | 10 + 20 ms | `unavailable`，3 次尝试 |
| 请求挂起 | 3 | 200 + 400 ms | `unavailable`，`timeout`；API 看到 3 个被放弃的请求 |
| 畸形 JSON / 缺字段 | 1 | – | `unavailable`，不重试 |
| 重复的分页 cursor | 3 | – | `partial`，5 个里取到 4 个，总量 `null` |
| 第 2 页彻底失败 | 5 | 10 + 20 ms | `partial`，5 个里取到 2 个，总量 `null`，附加了应用 note |
| 只允许 1 次 tool call，却请求了 2 次 | 4 | – | 第二次被拒绝；`BK2001` 从未被请求 |
| 客户端在请求途中离开 | 1 | – | `cancelled`；API 看到了 abort |
| 客户端离开，而 API 已经在工作 | 1 | – | API 看到了 abort；它的工作仍然做完了 |

- **拒绝（`403`）和暂时性失败（`429`、`503`）的行为不同**：前者一次请求，后者最多三次尝试。
- **等待由上限决定，而不是由服务端决定。** 2 秒的 `Retry-After` 会被遵守；30 秒的不会，而是报告服务端给出的数字。
- **部分结果永远不会变成总量。** 每个 `partial` 行的总量都是 `null`。
- **取消能到达 socket，却无法撤销已经做的工作。** 最后一行里，客户端离开之后 API 的工作仍然完成了——
  对读操作无害，但正是 Lab 21 要处理的问题。

167 个离线测试补充了：即使 model 无视警告、照样说出一个总量，note 仍会标出；换成外来 container 但数量不变的情况会被发现；
超限的请求只会以占位符的形式发出；服务凭证不会出现在任何 trace 行、provider 请求、响应或 session 文件里。

未测量：真实 model 在这些限制下的表现，以及真实的 booking endpoint。

## 运行

```bash
cd lab-20-connector-reliability
npm ci
npm run check            # typecheck + 167 个离线测试；不联网，不用真实 model
npm run demo:faults      # 上面的实验
```

手动试一试（每条都检查过会通过）：

```bash
npx vitest run tests/connector-failures.test.ts -t "403 and 429"        # 同一个请求：429 之后重试，403 之后不重试
npx vitest run tests/trace.test.ts -t "retry"                             # 一次被重试的调用的 trace
npx vitest run tests/sdk-assumptions.test.ts -t "cancelling the Context"  # 取消 wait 并不会取消 run
npm run --silent token -- tenant-a alice                                  # 本地测试 token，配合 npm run dev + curl 使用
```

`npm run dev`（需要在 `.env` 里配置 `DEEPSEEK_API_KEY`；写这份 README 时没有运行）会打印每个请求的 trace。
一次 run 的大致形状；id、token 数和耗时会变：

```text
▶ run
  ▶ turn #1
    assistant (tool call) lookup_booking call=… args={"bookingNo":"BK1001"} tokens=…
    ▶ tool_start lookup_booking call=… args={"bookingNo":"BK1001"}
      ↳ booking p1 try 1 rate_limited http=429 4ms
      ↳ booking p1 try 2 ok http=200 3ms waited=2000ms
      ↳ containers p1 try 1 ok http=200 3ms
    ◀ tool_end lookup_booking status=success
```

`assistant (tool call)` 是 model 的请求；`▶ tool_start … ◀ tool_end` 是 harness 在执行它；每个 `↳` 行是一次 HTTP attempt。
`⊘ tool_refused … code=blocked` 表示预算在 connector 被调用之前就拦下了这次调用。`■ stopped: …` 是应用给出的、run 提前结束的原因。

## 自测

运行 demo 之前先回答 1–3：

1. `403` 和 `429` 应该触发相同的重试行为吗？每个状态分别告诉 connector 什么？
2. 客户端在请求已经发出时断开。应用会停止什么，又有什么是它无法撤销的？
3. 三次 tool call、每次三次尝试，本来会是九个请求。是什么让这个 run 发出更少的请求？
4. 为什么不完整的 listing 带的是 `total=null`，而不是一个下界总量？
5. 一个 booking 记录了五个 container，API 也列出了五个——listing 仍然可能不完整吗？
6. turn 上限是通过 `root.abort()` 来停止 run 的。为什么"不再发出后续 model 调用"只是一个观察结果？

## 值得知道

- **版本：** `pi-durable`、`pi-ai`、`chord` 均为 `1.1.0`；默认模型 `deepseek-flash`。`pi-durable` 是实验性的。
- **model 调用的限额不是"不会发出"的保证。** `pi-durable` 里没有任何 hook 能结束一个 run，所以 turn 和 context 上限
  调用 `root.abort()`，而它和下一个请求是竞争关系。因此 context 上限还会把超限请求的消息换成一行占位文本：
  会话内容不会出去，但请求本身可能被发出。
- **取消要用 `root.abort()`**，而不是把一个可取消的 `Context` 传给 `wait()`——那样只会停止等待。
- **context 上限统计的是整个 session 的历史。** session 一旦超过它，之后的每个请求都是 `incomplete`；需要新开 session。
- 同一个 session 上的请求会排队，避免分叉它的历史；带有崩溃遗留的未结算工作的 session 会被拒绝，而不是在旧工作后面继续跑。
- 这里的一切都是脚本化的 model 加本地 fake API。真实 model 在这些限额下的表现，以及真实服务的表现，都没有测量。
  确定性测试套件做过逐个关闭 81 个控制点的检查：79 个被检出（其中一个是补了测试之后），
  2 个幸存者是一处已记录的冗余和一个没有测试触达的分支。
- provider / 连接问题：见 [Lab 01](../lab-01-pi-agent-loop/README.md)。

## 文件位置

```text
src/connector/http-connector.ts  重试的负责方：类别、Retry-After、deadline、取消、分页、身份检查
src/connector/{errors,schemas,lookup,deadline,trace}.ts  失败分类、校验器、计算出的结论、attempt 日志
src/fake-api/server.ts           本地 booking API，带脚本化故障和自己的请求日志
src/run-budget.ts, admission-queue.ts, usage-meter.ts, model-limits.ts   预算、有界队列、成本、输出上限
src/create-harness.ts            每个请求一份 registry：tool + 预算 hook；model 调用的重试归属
src/chat-service.ts              按 session 排队、run 生命周期、结果分类、应用 note
src/harness-trace-logger.ts      上面的 trace 树
scripts/faults-demo.ts           实验
tests/                           connector-contract、connector-failures、http-runs、http-sessions、trace、sdk-assumptions、units
```
