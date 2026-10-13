# Lab 13 — Tool Governance 与 Runtime Hook

[English](README.md) | 中文

**问题：** 应用如何独立于 prompt，去约束并审计一次 model 请求的 tool call？
**本 lab 给出的答案：** 用两道互相独立、都不读 prompt 的门：

- **一道门管"提供了什么"。** conversation 没有 offer 的 tool，不会被声明给 model；对它的 call 会在任何 hook 运行之前就被拒绝。
- **一道门管"每一次 call"。** 对已 offer 的 tool，`beforeTool` hook 读取这次 call 的结构化参数和当前 booking 的状态，
  然后放行或拦截，并且无论哪种都写一条审计记录。

可以这样理解：先决定柜台上到底摆哪些工具，再加一个按规则手册核对每一次请求的柜员，他从不在意你请求时有多客气。

## 一个具体场景

你给客服人员做了一个 booking 助手。它能查 booking，并且为了省 ops 一次点击，还能修改 booking 的状态。上线过程按时间线是这样：

1. **先只读。** session 只 offer `get_booking`。客户写道 *"Cancel BK1002, I'm furious."* 助手说它没有这个 tool。什么都没变，
   也没有审计记录，因为没有任何 hook 运行过。
2. **ops 为这个 session 打开该 tool。** 同一句话现在会让 model 请求 `update_booking_status(BK1002, "cancelled")`。
   `beforeTool` 的规则看到 `newStatus === "cancelled"` 就拦截。model 读到 *"Tool call blocked: Cancellation is not permitted…"*，
   并告诉客户。booking 没变，有一条审计记录写着 `blocked`。客户有多生气，从来没有传到规则那里。
3. *"Mark BK1003 in transit."* BK1003（两个 container）已经是 `delivered`。第二条规则从 booking 本身读到这一点，
   而不是从请求里读，于是拦截。
4. *"Mark BK1001 in transit."* 这次被允许：一条 `before_tool allowed` 记录，状态改变，一条 `after_tool executed` 记录。
5. **然后审计盘出故障。** 如果故障发生在修改*之前*，这次修改会被拒绝：一个没法被记录的决定就不会发生。
   如果发生在*之后*，修改保留，它的执行记录缺失；只有一行 `[Report]` 能看出来。

**没有本 lab 的做法时**，常见答案是在 system prompt 里写一句："never cancel bookings."

谁需要理解这些？**你，开发者。** ops 只看到某些修改被拒绝并附带原因；客户只看到一句道歉。本 lab 告诉你规则该放在哪里，以及每一种失败会留下什么。

| 场景里的东西 | lab 里对应的 |
| --- | --- |
| 柜台上摆哪些工具 | conversation 存储的 tool offer（`configure({ tools })`） |
| 柜员的规则手册 | `src/tool-policy.ts` 里的 `evaluateUpdateBookingStatusPolicy` |
| 柜员，在每次请求到来的那一刻 | `src/governance-hooks.ts` 里的 `beforeTool` hook |
| 台账 | `AuditLog` → `runtime-data/audit-log.jsonl` |
| "tool 和它的柜员一起招进来" | 一个 extension 同时包含 `update_booking_status` 和两个 hook |

## 核心想法

```text
model 请求一次 tool call
  → tool 被 offer 了吗？          没有 → 拒绝：tool_unavailable          （没有 hook，没有审计记录）
  → 参数合法吗？                  不合法 → 拒绝：invalid_arguments       （没有 hook，没有审计记录）
  → beforeTool：policy + 审计     不允许 → 拒绝：blocked                 （审计：blocked）
  → durable intent → execute()
  → afterTool：审计                                                       （审计：executed / errored）
  → durable pi.tool-result
```

下面每一种结局都由 `tests/governance-pipeline.test.ts` 用真实 harness 加脚本化 model 固定下来：

| 情形 | 结果 `code` | 审计记录 | 效果 |
| --- | --- | --- | --- |
| tool 没有被 offer | `tool_unavailable` | 无 | 无 |
| 不可能的参数（`newStatus: "teleported"`） | `invalid_arguments` | 无 | 无 |
| policy 说不行 | `blocked` | `before_tool blocked` | 无 |
| policy hook 抛异常 | `blocked` | 无 | 无 |
| `beforeTool` 里审计写入失败 | `blocked` | 无 | 无 |
| 被允许 | ok | `allowed` + `executed` | 有 |
| 被允许，但 `execute()` 抛异常（未知 booking） | `tool_error` | `allowed` + `errored` | 无 |
| `afterTool` 里审计写入失败 | ok | 只有 `allowed` | 有 |

三点要带走的：

1. **两道门，由结果的 `code` 区分。** "没被 offer"和"被拦截"最后都是 `status=error`。只有后者会留下审计记录，因为只有后者到达了 hook。
   在 system prompt 里提到某个 tool 的名字（本 lab 的每个场景都提了）并不会让它变得可调用。
2. **`beforeTool` 是唯一完整的审计面，但它不在最前面。** 没被 offer 的 tool 和校验失败的参数，它都看不到；被拦截的 call，`afterTool` 也看不到。
   这些拒绝只能在 transcript 里看到。所以决定的审计写在 `beforeTool` 里。
3. **同一个审计失败，在一个 hook 里是 fail-closed，在另一个里是 fail-open。** harness 用同一个 try/catch 运行每个 hook，并上报给 `onReport`；
   `beforeTool` 在此之上又加了一层 catch，把 throw 转成拦截，而 `afterTool` 没有，所以已执行的结果保持不变。本 lab 自己只做了一个选择：
   不在 `beforeTool` 里给审计写入包 try/catch。剩下的风险是一次真实的修改却没有 `after_tool` 记录，而且除非你传入 `onReport`，它是静默的
   （默认什么都不做；本 lab 会把它打印出来）。

不涉及：身份/RBAC/委托 token、通用 policy 引擎、真实的货运更新（唯一的效果是对 fixture 的内存修改）。

## 实验

booking 有 `containerNos`（非空列表），整个 booking 只有一个 status。Fixture：[`data/bookings.json`](data/bookings.json)：
`BK1001`（两个 container）、`BK1002`（一个）、`BK1003`（两个，已经是 `delivered`）。

`npm run demo:tool-governance` 对真实 model 运行五个场景，每个都是全新的 session 和全新的 repository：

1. `disabled`：tool 没有被 offer。让它取消 `BK1002`。
2. `enabled-normal`：已 offer。三轮：取消 `BK1002`、修改已 delivered 的 `BK1003`、把 `BK1001` 改成 `in_transit`。
3. `policy-bug`：`beforeTool` hook 什么都没做就抛异常。
4. `audit-sink-fails-before-tool`：每次审计写入都抛异常；请求一次本该被允许的修改。
5. `audit-sink-fails-after-tool`：只有 `afterTool` 的写入抛异常。

## 我们测到了什么

来自 `deepseek-flash` 上的一次 live 运行。断言检查的是后端状态（repository、审计记录、每个 tool result 的 `code`、`onReport`），绝不是 model 说了什么：

| 场景 | 审计记录 | 被改变的 booking | 受治理 tool 的结果 | `onReport` |
| --- | --- | --- | --- | --- |
| disabled | 0 | 0 | 无（model 没调用过它） | 0 |
| enabled-normal | 4 | 1 | blocked, blocked, ok | 0 |
| policy-bug | 0 | 0 | blocked | 0 |
| audit-sink-fails-before-tool | 0 | 0 | blocked | 0 |
| audit-sink-fails-after-tool | 1 | 1 | ok | 1 |

- **`enabled-normal` 的四条记录**是两条 `blocked`、一条 `allowed`、一条 `executed`。两次拦截引用的是不同的规则（取消；已 delivered）。
- **`policy-bug` 留下零条记录**，因为 hook 在审计之前就抛了异常：fail-closed 并不依赖审计能正常工作。
- **最后一行就是那个缺口。** `BK1002` 确实变成了 `in_transit`，有一条 `before_tool` 记录，没有 `after_tool` 记录，那一行 `[Report]` 是这次失败唯一的痕迹。
- **审计 id。** 记录带有 `sessionId`、`conversationId`、`taskId`（`pi.tool` task）和 `toolCallId`；hook 拿不到 run、lane 或 turn id，记录里也没有编造它们。
  有一个测试把 `toolCallId` join 回发出请求的 `pi.assistant` entry（turn）、`pi.tool-result` entry，以及 `[entry, answer]` 区间包含该 turn 的 submission（run）。

## 运行

```bash
cd lab-13-tool-governance
npm install
cp .env.example .env            # 然后填入 DEEPSEEK_API_KEY
npm run check                   # typecheck + 60 个离线测试，不调用 model
npm run demo:tool-governance    # 上面的 live 实验
```

手动试一试（请在 session 的**第一次**调用里打开 tool，因为一个 session offer 什么是被存储的）：

```bash
npm run agent -- --session try --enable-governed-tool --prompt "Please cancel booking BK1002."
npm run agent -- --session try --inspect    # …pi.tool-result update_booking_status status=error code=blocked
npm run agent -- --inspect-audit            # 一条 before_tool/blocked 记录：session、conversation、task、call
npm run agent -- --session try2 --enable-governed-tool --simulate-policy-bug --prompt "Mark BK1002 as in_transit."
npm run agent -- --session try3 --prompt "Mark BK1002 as in_transit."   # offeredTools=["get_booking"]
```

在 trace 里，model 的请求（`assistant (tool call) … call=<id>`）和 harness 做了什么是两行，靠 `call=` 配对。从未启动的 call 打印成
`⊘ tool_refused … code=<code>`，没有 `tool_start`；运行过的有 `▶ tool_start` … `◀ tool_end`。不要手改 `session-data/` 或 `runtime-data/`。

## 自测

运行 demo 之前先回答 1–3：

1. 一个 tool 没有被 offer，但 model 还是请求了它。`beforeTool` 会运行吗？结果里写的是什么？
2. `beforeTool` 是在参数校验之前还是之后运行？一个不可能的 `newStatus` 会在审计日志里留下什么？
3. 一次 call 被拦截。有什么是 durable 的吗？`afterTool` 会运行吗？
4. policy hook 抛了异常。tool 会被执行吗？
5. 审计写入先在 `beforeTool` 里失败，再在 `afterTool` 里失败。每一次，这次修改会怎样？哪一次你能看到？
6. 为什么 policy 不会被客户的措辞骗过？还有什么可能出问题，是 policy 自己看不到的？

（1–4 是在任何代码存在之前由 learner 记录的预测：错、错、错、对。）

## 值得知道的

- **版本：** `pi-durable`、`pi-ai`、`chord` 都是 `1.1.0`（`pi-durable` 是实验性的）。默认 model 是 `deepseek-flash`。
- **tool 和它的 guard 是同一个 extension。** conversation 存储的是 extension 的*名字*，代码没有安装的名字会静默地不再起作用；hook 没有 id。
  有一个测试把 extension 移除，tool 就跟着消失。
- **一个 session offer 什么是 durable 的**：之后一个没有传 `--enable-governed-tool` 的进程仍然会 offer 它（有测试）。
- booking 的修改只存在于内存里，所以下一个 CLI 进程又从 fixture 开始。session 和审计日志会保留。
- **没有检查过的：** 只看了 `beforeTool` 和 `afterTool`（这里没有任何内容说明别的 hook 会 fail-closed）；被拒绝的 call *为什么*不发出
  `tool_execution_start`（测出来的，没有被解释）；每个场景不止一次的 live 运行。
- model/provider 连接问题见 [Lab 01](../lab-01-pi-agent-loop/README.md)。

## 文件在哪里

```text
src/tool-policy.ts             两条规则：取消永远被拦截；已 delivered 的 booking 被锁住
src/governance-hooks.ts        beforeTool（policy + 审计）、afterTool（审计），以及把 tool 和 hook 打包在一起的 extension
src/update-booking-status-tool.ts, get-booking-tool.ts   受治理的 tool 和只读的 tool
src/audit-log.ts, create-harness.ts   可注入 writer 的 AuditLog；registry、存储的 tool offer、onReport
src/harness-trace-logger.ts    run/turn trace；错误上的 code=，⊘ tool_refused
scripts/tool-governance-demo.ts           live 实验
tests/governance-pipeline.test.ts         核心的离线证明：脚本化 model 之上的真实 harness
```
