# Lab 04 — 多工具货运调查

[English](README.md) | 中文

**问题：** 当一个工具的输出是后续工具的输入时，谁来决定调用顺序、哪些调用可以同时跑？
**本 lab 的答案：** 由模型决定，Pi 只负责执行模型提出的调用：

- **依赖关系写在文字里，不在代码里。** Pi 并不知道 `get_container_events` 必须等 `get_booking`。模型是从
  system prompt 和工具描述里学到这一点的；而它还没见过的必填参数，它也填不出来，所以 `get_booking` 一定排第一。
- **互相独立的调用一起跑。** `get_booking` 返回之后，模型可以在同一条消息里请求剩下所有调用，Pi 默认的并行执行会
  同时启动它们。结果进入 transcript 的顺序是**请求的顺序**，不是它们完成的顺序。

可以把它想成一个调度员：必须先看完订舱单，才能打电话；然后同时打给堆场和港口办公室，再按拨出电话的顺序记笔记。

## 一个具体场景

客服问助手：*"订单 `BK1001` 晚了吗？港口有问题吗？"* `BK1001` 有两个集装箱 `MSKU1234567` 和 `MSKU2345678`，
在 `CNSHA` 装船，计划 `2026-09-10T08:00:00Z` 离港。

- **不用本 lab 的做法**，你要手写整个流程：查订单、遍历集装箱、调港口服务、合并结果。每多一个数据源就多一段胶水代码，
  顺序也被写死了。
- **用了它**，你给模型三个小工具和业务规则：
  - 第 1 轮：模型只能调 `get_booking`，因为集装箱号和港口代码只在它的结果里。
  - 第 2 轮：它在一条消息里请求两个集装箱的事件和港口状态，Pi 把三个调用同时启动。
  - 第 3 轮：它按集装箱分别作答。两个箱子的 `LOAD` 都晚于计划离港（延误证据），`CNSHA` 拥堵程度为 high（风险信号），
    并且答案说明"拥堵并未被证明是原因"。
- 如果港口服务里没有 `CNSHA` 的记录，答案仍然给出两个箱子的延误证据，并明确说没有拥堵读数，而不是编一个。

谁需要理解这些？**你，开发者。** 客服只看到答案。这个 lab 教你：顺序规则放在哪里（描述和 prompt）、Pi 对并行调用保证了什么、
怎么读 timeline。

| 场景里的东西 | lab 里的对应物 |
| --- | --- |
| 订舱单 | `get_booking` → `containerNos[]` 和 `origin` |
| 每个箱子打一次电话给堆场 | `get_container_events`，每个集装箱调用一次 |
| 打电话给港口办公室 | `get_port_status` |
| 某个箱子"晚了" | 一个晚于 `plannedDeparture` 的 `LOAD` 事件 |
| "港口可能有问题" | 高拥堵：风险信号，绝不是已证明的原因 |

## 核心想法

```text
get_booking(bookingNo)
  -> containerNos[] + origin
  -> get_container_events(containerNo)   每个集装箱一次，并且与下一行同一轮 ...
  -> get_port_status(origin)             ... 一起发出
  -> 按集装箱的延误证据 + 风险信号 + 证据不能说明的内容
```

三个要点：

1. **顺序来自模型"有什么数据、缺什么数据"。** 没见过的必填参数会形成一次 turn 边界；描述和 prompt 说明哪些调用互相独立。
   Pi 自己不强制任何顺序。
2. **有两种顺序，而且它们不同。** `tool_execution_end` 事件按完成顺序到达；transcript 里的 `toolResult` 消息按模型请求
   调用的顺序追加。trace 里的 `[Timeline]` 块同时打印 `source=`（请求顺序）、`transcript=`（追加顺序）和真实的起止时间，
   让你两种顺序都能看到。
3. **一个调用失败不会拖垮它的兄弟调用。** 以 `status=error` 结束的调用变成一条错误结果，其他结果保留，下一轮照常开始。

不涉及：Teams、多轮会话状态、durable workflow、真实货运系统（fixture 都是本地的）。

## 实验

fixture 在 [`data/`](data/)：`bookings.json`（`BK1001` 有两个集装箱，`BK1002` 有一个）、`container-events.json`、
`port-status.json`，所有时间戳都以 `Z` 结尾。`npm run agent` 把一个 prompt 交给真实模型。四组运行，均使用 `deepseek-flash`：

1. 原样运行 `BK1001`。
2. `BK1001`，临时从 `data/port-status.json` 删除 `CNSHA` 条目（之后恢复）。
3. `BK1001`，设置 `LAB04_PORT_STATUS_DELAY_MS=800`，只延迟 `get_port_status`。
4. `BK1002`（一个集装箱）和 `BAD_ID`（不存在的订单）。

## 测量结果

每组各一次 live 运行（第 2 轮的调用；耗时来自 `[Timeline]` 块）：

| 运行 | 第 2 轮的调用 | `get_port_status` | 每个 `get_container_events` | 最终答案 |
| --- | --- | --- | --- | --- |
| `BK1001` | 3 个一起 | 成功，6 ms | 成功，6 ms | 两个箱子都延误；拥堵为 high，未被当作原因 |
| 删除 port status | 3 个一起 | `status=error`，7 ms | 成功，6–7 ms | 两个箱子都延误；"no port status found"，没有给拥堵读数 |
| 800 ms 延迟 | 3 个一起 | 成功，811 ms | 成功，9–10 ms | 与第一行相同 |
| `BK1002` | 2 个一起（一个集装箱） | 成功 | 成功 | 无延误：`LOAD` 早于计划离港 |
| `BAD_ID` | 无；第 2 轮后结束 | – | – | "Booking not found"，没有编造任何内容 |

- **每次运行的第 1 轮都只有 `get_booking`。** 后面的调用都是在它的结果进入 transcript 之后才出现的。
- **集装箱调用的个数跟随 `containerNos`**：`BK1001` 两个，`BK1002` 一个。
- **延迟那次运行里，三个调用的启动时间仍相差不到 1 ms**，答案要等最慢的那个。
- **live 运行里被延迟的工具恰好也是最后被请求的**，所以完成顺序和请求顺序一致。要让两者不一致，需要模型先请求 port，
  它没有这么做；下面的离线测试会强制构造这种情况。

离线测试用脚本化的 stream 驱动真实的 Pi `Agent`（不联网）：先请求 `get_port_status` 并延迟它，检查
`tool_execution_end` 按完成顺序到达、而 `toolResult` 消息保持请求顺序；检查失败的工具不会丢掉兄弟调用的结果；
以及 transcript 以 `system` 消息开头、每次调用都完整重发。

## 运行

```bash
cd lab-04-multi-tool-investigation
npm install
cp .env.example .env     # 然后填入 DEEPSEEK_API_KEY
npm run check            # typecheck + 31 个离线测试，不调用模型
npm run agent            # 默认的 BK1001 问题，live
```

手动试试：

```bash
npm run agent -- "Investigate booking BK1002 for departure delay and port risk"
LAB04_PORT_STATUS_DELAY_MS=800 npm run agent
npm run agent -- "Investigate booking BAD_ID"
```

怎么读 trace：`assistant (tool call) <name> call=<id> args=<json>` 是模型的请求；`tool_start`/`tool_end` 是 Pi 在执行它，
`call=` 把两者配对。第 2 轮没有 `user` 行，因为没有新增 user 消息。`[Timeline]` 行显示
`source=` / `transcript=` / `start=` / `end=` / `duration=`，时间相对于 `agent_start`。

## 自测

运行之前先写下 1–3 题的答案，其余的运行后再答：

1. 模型第一个能调用哪个工具？为什么它不能先调另外两个？
2. `BK1001` 有两个集装箱。`get_booking` 之后同一轮最多能有几个调用，分别是什么？
3. 如果 `get_port_status` 失败，答案应该怎么说拥堵？
4. 在延迟那次运行里，任何一个调用的 `source=` 或 `transcript=` 变了吗？为什么变或为什么没变？
5. 哪一行说明模型请求了某个调用，哪一行说明 Pi 执行了它？
6. 即使拥堵读数是 high，答案为什么仍然说"拥堵并未被证明是原因"？

（本 lab 目前没有记录学习者的预测。）

## 值得知道

- **版本：** `pi-agent-core` 和 `pi-ai` 均为 `1.1.0`。默认模型 `deepseek-flash`；如果它不再能在固定版本的 catalog 中解析，
  `npm run check` 会失败。
- agent 有意使用 `toolExecution: "parallel"`；顺序规则在 prompt 和描述里，所以换一个模型，分批方式可能不同。
  具体的 turn 数不属于本 lab 的通过条件。
- `LAB04_PORT_STATUS_DELAY_MS` 只用于这个实验；不设置或设为 `0` 表示不延迟。
- 模型/连接问题见 [Lab 01](../lab-01-pi-agent-loop/README.md)。`Unknown model deepseek/<id>` 表示 `.env` 里的模型不在
  固定版本的 catalog 中；保持 `PI_MODEL=deepseek-flash`。

## 文件位置

```text
src/booking-repository.ts, container-event-repository.ts, port-status-repository.ts   带校验的 fixture 读取
src/get-booking-tool.ts, get-container-events-tool.ts, get-port-status-tool.ts       三个工具
src/create-agent.ts                  模型、system prompt（顺序和证据规则）、并行 Agent
src/investigation-trace-logger.ts    agent/turn/tool 树加 [Timeline] 块
src/cli.ts                           入口；运行失败时以非零退出
tests/agent-loop.test.ts             真实 Agent + 脚本化 stream：顺序、兄弟调用、transcript
```
