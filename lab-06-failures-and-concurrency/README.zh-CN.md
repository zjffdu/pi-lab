# Lab 06 — 失败与并发

[English](README.md) | 中文

**问题：** 当工具失败、工具很慢、工具并行执行，或者运行还没结束时又来了一条消息，Pi 会怎么做？
**本 Lab 给出的答案：** 它的行为有三种是可预期的，还有一条规则要你自己定：

- **失败变成一条消息，而不是崩溃。** 抛异常的工具会变成一条错误的 tool result；下一个 turn 读到它并作答。
- **顺序按"请求"而不是"完成时间"。** 并行的工具可以按任意顺序结束，但结果永远按模型请求它们的顺序存储。
- **排队的消息要等一个明确的时刻。** `steer()` 在当前这批工具结束后送达；`followUp()` 要等到 agent 本来要停下时才送达。
- **第二条消息怎么处理，是你的策略。** Pi 提供两个队列；本 Lab 选择 `followUp()`，并且绝不启动第二个 `prompt()`。

可以把它想成餐厅后厨：烧焦的菜会以一张便条退回（而不是起火），菜按点单顺序上桌，即使汤先好了；服务中途新来的单子
挂在单据架上，而不是塞进厨师手里正在炒的锅。

## 一个具体场景

你在团队聊天里运行一个货运状态助手。Dana 问："*调查一下订单 BK1001。*" `BK1001` 有两个集装箱，而今天港口状态查询
很慢（假设 900 ms）：

1. 助手先查订单，然后一次性请求两个集装箱的事件和港口状态。事件立刻返回；港口状态还在执行。
2. 等待期间，Dana 又发了一句"*另外，延误会不会变严重？*"如果没有规则，这条消息可能在同一个会话上启动第二次运行，
   让两组 tool result 交错——或者被丢掉。按本 Lab 的规则，它进入队列并按顺序得到回答。
3. 同事问了 `BAD_ID`。查询抛异常；助手回答查不到这个订单，没有编造集装箱。
4. 下周有人问"为什么答案来得这么晚？"你打开日志，不用看答案就能还原每一步在什么时候执行。

| 场景中的事物 | 在 Lab 中对应 |
| --- | --- |
| 很慢的港口查询 | `get_port_status` 加 `LAB06_PORT_STATUS_DELAY_MS` |
| 运行中途的"另外，会不会变严重？" | `agent.steer()`（实验 B）或 `agent.followUp()`（实验 C） |
| 第二条消息的规则 | `createConcurrentMessagePolicy`——`isStreaming` 时作为 `followUp()` 排队 |
| 未知订单 | `get_booking("BAD_ID")` 抛异常（实验 A） |
| 还原每一步的时间 | 带耗时、`turn=`、`call=` id 的 trace 树 |

谁需要理解这些？**你，开发者。** 用户只看到答案慢；第二条消息意味着什么由你决定，出问题时由你读 trace。

## 核心思路

| 情况 | Pi 的做法 | 在哪个实验观察到 |
| --- | --- | --- |
| 工具抛异常 | 提交一条 `status=error` 的 `toolResult`，然后再跑一个 turn | A |
| 工具执行中 `steer()` | 入队；在这批工具的 `turn_end` 之后，作为下一个 turn 的 `user` 消息送达 | B |
| 工具执行中 `followUp()` | 入队；只有 agent 本来要停下时才送达，多花一个 turn | C |
| 一条消息里有多个调用 | 一起执行；`tool_end` 按完成顺序，`toolResult` 按请求顺序 | D |

三个要点：

1. **排队不等于打断。** 两个队列都不会停止正在执行的工具。`steer()` 在 turn 结束时被读取；`followUp()` 再晚一步。
2. **有两种顺序，只存储一种。** trace 同时显示：`tool_end` 行（完成顺序）和 `[Timeline] source= transcript=`（请求顺序 = 存储顺序）。
3. **Pi 对"会话正忙"没有规则。** 运行中再调 `prompt()` 要你自己避免。这里由
   [`concurrent-message-policy.ts`](src/concurrent-message-policy.ts) 检查 `agent.state.isStreaming` 并排队。

不涉及：持久化恢复、分布式 worker、重试与幂等，以及基于 `steer()` 的策略。

## 实验

每个实验是一个会话、一次 CLI 运行；B 和 C 把 `get_port_status` 延迟 900 ms，并在它开始的瞬间调用队列。`BK1001`（两个集装箱）、
`BK1002`（一个）和港口状态是 [`data/`](data/) 下的 fixture。

```bash
npm run agent -- --experiment a   # BAD_ID：工具错误
npm run agent -- --experiment b   # 慢工具 + steer()
npm run agent -- --experiment c   # 慢工具 + followUp()
npm run agent -- --experiment d   # 并行批次（BK1001：2 个集装箱 + 港口）
```

运行前，先写下"自测"里前三个问题的答案。

## 测量结果

每个实验取一次真实运行（`deepseek-flash`；耗时会有波动）：

| 实验 | turn 数 | trace 显示 |
| --- | --- | --- |
| A | 2 | 一条 `tool_end status=error`，一条错误 `toolResult`；回答：订单不存在，没有集装箱 |
| B | 3 | `+4185 ms` 调用 `steer()`；`get_port_status` 在 `+5093 ms` 结束；`turn_end` 在 `+5094 ms`；steering 的 `user` 消息在 `+5096 ms` 开启第 3 个 turn |
| C | 4 | 第 3 个 turn 以普通答案结束；follow-up 的 `user` 消息随后开启第 4 个 turn |
| D | 3 | 第 2 个 turn 里有三个调用：`source=0,1,2` = `transcript=0,1,2`；答案按集装箱分别评估 |

- **B 与 C 恰好差一个 turn。** steering 消息搭上了本来就要跑的那个 turn；follow-up 要等到本该收到的答案之后，再多花一个 turn。
- **两个队列都没有让慢工具提前结束。** 每次运行里 `tool_end get_port_status` 都在两个 `get_container_events` 结束之后。
- **D 加 900 ms 延迟：** 集装箱调用在 `+3979 ms` 结束，港口调用在 `+4880 ms`，但 `transcript=` 仍是 `0,1,2`。
  真实运行中模型总是最后才请求 `get_port_status`，所以完成顺序和请求顺序一致；两者不一致的情况（慢工具最先被请求）
  由 `tests/agent-loop.test.ts` 离线证明。
- **每个 `toolCallId` 只有一条 `toolResult`。** D 的这次运行有 4 个请求、4 个 `tool_start`、4 行 `toolResult`。

离线测试（44 个，不调用模型）还覆盖：用脚本化流驱动真实 `Agent` 跑 A–D；`steer()` 与 `followUp()` 具体在哪个 turn 被读取；
同一个 tick 内的第二次 `sendMessage` 在真实 agent 上变成 follow-up；以及 trace 的固定宽度列。

## 运行

```bash
cd lab-06-failures-and-concurrency
npm install
cp .env.example .env     # 然后填入 DEEPSEEK_API_KEY
npm run check            # typecheck + 44 个离线测试，不调用模型
npm run agent -- --experiment d
```

手动试试：

```bash
LAB06_PORT_STATUS_DELAY_MS=900 npm run agent -- --experiment d | grep -E "tool_end|Timeline\]   id"
npm run agent -- --experiment a | grep -E "tool_end|\[Assistant\]"
npm run agent -- --experiment d | grep -c "assistant (tool call)"      # 4：一次订单 + 三次证据调用
```

读 trace：每行是 `[conversation] t=<耗时> turn=N`（耗时是单调时钟，并做了定宽填充，树保持对齐）。
`assistant (tool call) <name> call=<id> args=…` 是模型的请求；`tool_start`/`tool_end` 是 Pi 在执行它；`call=` 把两者配对。
`[Harness]` 行是实验自己发起的队列调用。

## 自测

1–3 题在运行实验前回答，其余运行后回答：

1. 在 B 中，steering 消息是在 `get_port_status` 结束之前还是之后被回答？在第几个 turn？
2. B 的 turn 数和 C 一样吗？为什么？
3. 如果 D 里某个调用先结束，存储的结果顺序会变吗？
4. 哪一行日志证明是 Pi（而不是模型）把 `BAD_ID` 当成错误？
5. `sendMessage` 做了什么是连续两次 `agent.prompt()` 做不到的？
6. 为什么真实运行无法展示"完成顺序和请求顺序不一致"？它在哪里被证明？

（本 Lab 尚未记录学习者的预测。）

## 须知

- **版本固定：** `pi-agent-core` 与 `pi-ai` 为 `1.1.0`。默认模型 `deepseek-flash`。
- 第一次 `sendMessage` 会同步把 `isStreaming` 置为 true，所以同一个 tick 里的第二次调用已经会被排队（在真实 `Agent` 上测试过）。
- 一个订单可以有多个集装箱（`containerNos`）；延误按集装箱分别评估。
- 模型/连接问题：见 [Lab 01](../lab-01-pi-agent-loop/README.md)。

## 文件说明

```text
src/concurrent-message-policy.ts   忙时的第二条消息 → followUp()
src/session-registry.ts            Map<conversationId, Agent>（来自 Lab 05）
src/trace-logger.ts                run/turn/tool 树，带耗时、turn、call id
src/create-agent.ts, cli.ts        agent 构建；--experiment a|b|c|d
src/get-*-tool.ts, *-repository.ts 三个工具与 fixture（来自 Lab 04）
tests/agent-loop.test.ts           真实 Agent + 脚本化流：A–D 与策略
```
