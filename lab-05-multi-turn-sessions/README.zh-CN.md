# Lab 05 — 多轮对话的内存会话

[English](README.md) | 中文

**问题:** 一个 conversation id 怎样为下一条消息选出正确的 transcript?
**这个 lab 给出的答案:** 靠你的代码,不是 Pi。Pi 的 `Agent` 只持有一份 transcript,不认识 conversation id,
所以你自己维护一个 `Map<conversationId, Agent>`,每次 prompt 之前先查表:

- **同一个 id → 同一个 agent → 同一份 transcript。** 追问能看到之前说过的一切,包括工具返回的结果。
- **不同的 id → 不同的 agent。** 它从空白开始,看不到另一个对话的任何内容。
- **重启 → map 为空。** transcript 只存在于该进程的内存里,所以即使 id 相同也要从头开始。

可以想象成:每位客户一本笔记本,放在一个抽屉里,每次下班抽屉都会被清空。

## 一个具体场景

你在聊天工具里运行一个订舱助手。两位同事各在自己的聊天窗口里同时使用它:

| 时间 | 聊天 | 消息 | 应该发生什么 |
| --- | --- | --- | --- |
| 10:00 | 聊天 A | "What are the details for booking BK1001?" | 助手查询订舱并回答。 |
| 10:01 | 聊天 A | "Which container is it using?" | "it" 指 BK1001。它根据之前的查询结果回答,不再查询。 |
| 10:02 | 聊天 B | "Which container is it using?" | 聊天 B 没提过任何订舱。它必须追问是哪一个,而不是借用聊天 A 的。 |
| 10:30 | 服务重启 | | 两本笔记本都没了。 |
| 10:31 | 聊天 A | "Which container is it using?" | id 相同,但助手已经丢失 BK1001。它必须重新追问,而不是猜。 |

**没有 registry** 时,每条消息新建一个 agent(Lab 03 的做法),10:01 的追问就会失败:第二个 agent 从没听说过 BK1001。
**所有人共用一个 agent** 时,10:02 的聊天 B 会回答聊天 A 的 container。两种都不可接受,所以必须有东西把
"这是哪个聊天"映射到"用哪份 transcript"。

谁需要理解这个? **你,开发者。** 两位同事只会看到一个"记得"或者"不记得"的助手。这个 lab 要让你看清:记忆放在哪里、
谁负责查表、重启会带走什么。

| 场景里的东西 | lab 里的对应 |
| --- | --- |
| 一个聊天 | 一个 conversation id(`conversation-a`、`conversation-b`) |
| 笔记本 | 一个 `Agent` 和它的 `agent.state.messages` |
| 抽屉 | `SessionRegistry`,即 `src/session-registry.ts` 里的 `Map` |
| 下班关门 | 进程退出;新的 `npm run agent` 从空 map 开始 |

## 核心想法

```text
conversation-a ─┐                       ┌─ Agent A ── transcript A: system, user, assistant, toolResult, assistant, user, assistant
                ├─ registry.getOrCreate ┤
conversation-b ─┘                       └─ Agent B ── transcript B: system, user, assistant
```

三个要点:

1. **registry 是应用层代码。** `pi-agent-core` 只导出 `Agent`、循环和类型;`Agent.sessionId` 只是传给 provider
   做缓存的字符串。Pi 里没有任何东西把 id 映射到 agent。
2. **历史就是 agent 的消息数组。** 每次 prompt 都把整个数组发给模型。追问之所以成功,是因为之前的工具结果还在数组里;
   新对话之所以成功,是因为它的数组是新的。
3. **没有任何持久化。** 没有文件,没有数据库。重启会清空 map,而且 trace 会明确显示(`created` 而不是 `reused`),
   不会悄悄隐藏。

不涉及:跨重启的持久化、同一对话里的并发消息(Lab 06)、真实的聊天传输层(Lab 03)、授权(谁能打开哪个对话)。

## 实验

CLI 是一个进程内的 harness:对同一个 registry 依次运行一串 `(conversationId, message)`。先做预测:第二条消息能看到什么?
另一个聊天能看到什么?重启后什么还在?

1. `npm run agent` 在一个进程里运行上表的三轮(聊天 A 两次,再聊天 B)。
2. 在一个**新**进程里只运行追问,id 用 `conversation-a`:这就是重启。

## 测到了什么

来自针对 `deepseek-flash` 的真实运行(措辞随模型而变;registry 和工具两列是 trace 里实际显示的):

| 轮次 | conversation | registry | 调用了 `get_booking` | 回答做了什么 |
| --- | --- | --- | --- | --- |
| 1 | `conversation-a` | `created`,size 1 | 是,一次 | 列出 BK1001 的两个 container |
| 2 | `conversation-a` | `reused`,size 1 | 否 | "uses two containers: MSKU1234567 and MSKU7654321" |
| 3 | `conversation-b` | `created`,size 2 | 否 | 追问是哪个订舱号 |
| 重启 | `conversation-a` | `created`,size 1 | 否 | 追问是哪个订舱号 |

- **turn 计数就是复用的证据。** `conversation-a` 的追问是 `turn #3`;`conversation-b` 和重启后的 `conversation-a`
  都从 `turn #1` 开始。计数器在订阅这个 agent 的 logger 里。
- **追问不需要工具调用**,因为工具结果已经在 transcript 里。
- **没有任何回答编造 container。** system prompt 要求模型在没有已建立的订舱时追问;这是 prompt 行为,所以可能随模型而变。

离线测试固定了真实运行无法稳定展示的部分(它们用脚本化的 stream 驱动真实的 `Agent`):

- 追问那次模型调用携带 `system, user, assistant, toolResult, assistant, user`;
- 另一个对话的第一次调用只携带 `system, user`;
- `registry.reset()` 之后,同一个 id 又从 `system, user` 开始。

## 运行

```bash
cd lab-05-multi-turn-sessions
npm install
cp .env.example .env     # 然后填入 DEEPSEEK_API_KEY
npm run check            # typecheck + 23 个离线测试,不调用模型
npm run agent            # 上面的三轮场景
```

手动试试:

```bash
npm run agent -- --conversation try "What are the details for booking BK1001?" --conversation try "How many containers does it have?"
npm run agent -- --conversation try "How many containers does it have?"   # 新进程:created,turn #1
```

读 trace:每一行都带 `[conversation-id]` 标签。`assistant (tool call) ... call=<id>` 是模型的*请求*;
`tool_start`/`tool_end` 是 Pi 在执行它,`call=` id 把两者配对。每次 `prompt()` 会打开自己的
`▶ agent` ... `◀ agent_end` 括号,所以一个对话会出现多个括号。

## 自测

在运行场景之前先回答前三题:

1. 同一对话里的第二条消息能看到什么,是全新对话看不到的?
2. 另一个 conversation id 能看到第一个对话历史的什么?
3. 重启后什么还在?
4. 哪一行日志证明追问复用了同一个 agent?
5. 为什么 `conversation-b` 后运行,却从 `turn #1` 开始?
6. system 消息在每份 transcript 里,却从不出现在 trace 里。为什么?
7. 如果两个聊天共用一个 agent,上表的三种结果里哪一种会出错?

## 值得知道

- **版本:** `pi-agent-core` 和 `pi-ai` 为 `1.1.0`。默认模型 `deepseek-flash`;不在固定目录里的模型 id 会在启动时失败,
  并且有测试检查默认 id 能被解析。
- system 消息携带 prompt 和工具声明。它属于 `agent.state.messages`,也属于每一次模型调用,但不会触发 `message_*`
  事件,所以 trace 里看不到它。
- `pi-durable` 有能跨重启的 conversation,用的是它自己的 id。我读它的 README 没找到按外部聊天 id 查找的接口,
  所以真实服务仍需自己保存这个映射;这一点是读出来的,没有运行验证。
- provider/连接问题:见 [Lab 01](../lab-01-pi-agent-loop/README.md)。`Unknown model` 表示 `.env` 里设置了目录之外的
  模型 id;请保持 `PI_MODEL=deepseek-flash`。

## 文件位置

```text
src/session-registry.ts       Map<conversationId, Agent>:getOrCreate、has、size、reset
src/session-trace-logger.ts   带 conversation id 标签的 agent/turn/tool 树;每个 agent 一个 turn 计数器
src/create-agent.ts           模型选择、system prompt、Agent;可选的脚本化 streamFn
src/cli.ts                    对同一个 registry 运行 (conversationId, message) 序列
src/booking-repository.ts, get-booking-tool.ts   fixture 查询(一个订舱有一个或多个 container)
tests/session-agent-loop.test.ts   核心离线证明:用真实 Agent 验证复用、隔离、重置
```
