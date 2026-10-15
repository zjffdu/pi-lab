> **Historical background — superseded by the roadmaps (themselves now design history; see [the learning path](../learning-path.md)).** This is the original POC proposal (a saved discussion
> from 2026-09-16) that the labs grew out of. It is kept for context only and is **not maintained**: the
> staged plan became [ROADMAP.md](ROADMAP.md) (Labs 01–06), and several recommendations here were later
> changed (the labs use DeepSeek rather than Azure OpenAI, a booking has several containers instead of one
> `containerNo`, and durable runtime work moved to `pi-durable` in Phase 2). Do not use it as a source of
> current behavior.

---

这个 POC 我建议就做，而且要**刻意保持小**。目标不是先证明企业架构，而是打通并理解这一条链：

```text
Teams
  ↓
Teams message adapter
  ↓
Pi Agent
  ↓
LLM decides
  ↓
Tool call(s)
  ↓
Tool result
  ↓
LLM continues
  ↓
Teams reply
```

这条链跑通以后，你对 Pi 的理解会比单纯读源码深很多。

## 1. 第一版架构

我建议全部用 **TypeScript/Node.js**，因为 Teams 当前的 Teams SDK 和 Pi 都很自然地落在这个栈里。Microsoft 当前也提供 `@microsoft/teams.apps`，可以直接把 Teams endpoint 接进现有 Express server；Teams Developer CLI 可以直接 scaffold 一个 TypeScript echo agent。([Microsoft Learn][1])

架构只需要：

```text
┌─────────────────────────┐
│ Microsoft Teams         │
│ Personal App / 1:1 chat │
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│ Node.js POC Service     │
│                         │
│ Teams Adapter           │
│       │                 │
│       ▼                 │
│ Pi Agent                │
│       │                 │
│  ┌────┴────┐            │
│  ▼         ▼            │
│ LLM      Tools          │
│         local TS code   │
└─────────────────────────┘
```

**不要：**

```text
Sandbox
Databricks
PDF
Excel
Workflow engine
Database
RBAC
Artifact store
```

这些全部留到后面的 POC。

---

# 2. Teams 这一层尽量做薄

Teams 代码只做三件事：

```text
1. 接收 message
2. 把 text 交给 Pi
3. 把 Pi 最终 answer 发回 Teams
```

大致：

```typescript
app.on("message", async ({ send, activity }) => {
    const text = activity.text;

    const agent = getAgent(activity.conversation.id);

    await agent.prompt(text);

    const answer = getLatestAssistantMessage(agent);

    await send(answer);
});
```

Microsoft 当前 Teams SDK 允许把它嵌进已有 Express server，所以不需要让 Microsoft SDK 接管你的 Agent 逻辑。([Microsoft Learn][1])

因此职责非常清楚：

```text
Teams SDK
=
Transport Adapter

Pi
=
Agent Runtime
```

这是我建议你从第一天就保持的边界。

---

# 3. 不要一开始使用 Pi `AgentHarness`

我反而建议第一版直接使用：

```text
@earendil-works/pi-agent-core

Agent
```

而不是更复杂的：

```text
AgentHarness
durable session
recovery
SQLite
operation state machine
```

因为你现在真正需要学的是：

```text
prompt
↓
LLM
↓
toolCall
↓
toolResult
↓
next LLM turn
↓
answer
```

Pi 的 `Agent` 已经完整提供这套 loop、消息状态、工具执行和事件流。工具调用后，Agent 会自动把结果放回上下文并启动下一轮模型调用。

等第一版跑通以后，第二个 Lab 再问：

> Server crash 之后，这个 task 怎么恢复？

那时再换 `AgentHarness`。

这样你能真正理解：

```text
Agent
        vs
Durable Agent Runtime
```

的区别。

---

# 4. 第一个 task 我建议不要做 PDF

因为 PDF 会立刻引入：

```text
upload
attachment
storage
parser
OCR
token size
```

你最后很可能是在 debug Teams attachment，而不是学 Pi。

也不要做：

> “1 + 1 等于多少？”

因为那根本展示不出 Agent 的价值。

我建议做一个**假的 Shipment Investigation Agent**。

例如用户在 Teams 问：

> 帮我看看 booking BK1001 有没有延误风险，为什么？

Agent 有三个 tool：

```text
get_booking()

get_container_events()

get_port_status()
```

数据全部放在 repo 里的 JSON fixture。

---

# 5. 一个具体例子

假设本地有：

```text
data/
  bookings.json
  container-events.json
  ports.json
```

Booking：

```json
{
  "bookingNo": "BK1001",
  "containerNo": "MSKU1234567",
  "origin": "CNSHA",
  "destination": "NLRTM",
  "vessel": "MAERSK TEST",
  "plannedDeparture": "2026-09-10",
  "plannedArrival": "2026-10-15"
}
```

Container events：

```json
[
  {
    "containerNo": "MSKU1234567",
    "event": "GATE_IN",
    "time": "2026-09-09T08:00"
  },
  {
    "containerNo": "MSKU1234567",
    "event": "LOAD",
    "time": "2026-09-12T18:00"
  }
]
```

Port status：

```json
{
  "CNSHA": {
    "congestion": "high",
    "averageDelayHours": 36
  }
}
```

用户：

> BK1001 有没有延误风险？

第一次 LLM：

```text
我需要 booking information。

→ get_booking("BK1001")
```

Tool：

```text
container = MSKU1234567
planned departure = Sep 10
```

第二轮 LLM：

```text
我要检查 container events。

→ get_container_events("MSKU1234567")
```

返回：

```text
LOAD = Sep 12
```

LLM 发现：

```text
planned departure = Sep 10
actual load = Sep 12
```

然后可能继续：

```text
→ get_port_status("CNSHA")
```

返回：

```text
high congestion
average delay 36h
```

最后 Pi：

> BK1001 存在延误风险。Container 比计划晚约两天装船，同时 Shanghai 当前处于较高拥堵状态……

这个小例子已经包含了：

```text
Intent understanding
        ↓
Tool selection
        ↓
Tool chaining
        ↓
State propagation
        ↓
Reasoning based on tool result
        ↓
Final synthesis
```

这才是真正值得学的 Pi。

---

# 6. Tool 怎么写

Pi 当前 `AgentTool` 的模型非常简单：

```typescript
const getBookingTool: AgentTool = {
    name: "get_booking",

    description:
        "Get booking information by booking number",

    parameters: Type.Object({
        bookingNo: Type.String()
    }),

    async execute(toolCallId, params) {
        const booking = findBooking(params.bookingNo);

        if (!booking) {
            throw new Error("Booking not found");
        }

        return {
            content: [{
                type: "text",
                text: JSON.stringify(booking)
            }],
            details: {
                bookingNo: params.bookingNo
            }
        };
    }
};
```

Pi 当前就是用 schema 描述工具参数，`execute()` 返回 tool result；如果工具抛异常，Agent runtime 会把它转换成 tool error 提供给模型，而不是要求你把错误伪装成普通文本。

然后：

```typescript
const agent = new Agent({
    initialState: {
        systemPrompt: SYSTEM_PROMPT,
        model,
        tools: [
            getBookingTool,
            getContainerEventsTool,
            getPortStatusTool
        ]
    },

    streamFn: models.streamSimple.bind(models)
});
```

这就是 POC 的核心。

---

# 7. 这里最值得你观察的是 Pi Event Flow

不要只观察最终答案。

把这些事件全部打日志：

```text
agent_start

turn_start

assistant message

tool_execution_start
tool_execution_end

toolResult

turn_end

turn_start

...

agent_end
```

Pi 的 Agent 就是围绕这样的 lifecycle 构建的。

然后当 Teams 用户问：

> BK1001 有没有风险？

你的 console 最好能看到：

```text
[Teams]
user message received

[Pi]
turn #1

[LLM]
toolCall: get_booking
args: BK1001

[Tool]
get_booking → success

[Pi]
turn #2

[LLM]
toolCall: get_container_events
args: MSKU1234567

[Tool]
get_container_events → success

[Pi]
turn #3

[LLM]
toolCall: get_port_status
args: CNSHA

[Tool]
get_port_status → success

[Pi]
turn #4

[LLM]
final answer

[Teams]
reply sent
```

你会立刻把之前读到的：

```text
Agent Loop
Tool Call
Turn
Tool Result
Context
```

全部对应到真实运行时。

---

# 8. Session 第一版也保持最简单

做一个：

```typescript
Map<conversationId, Agent>
```

例如：

```text
Teams Conversation A
        ↓
    Pi Agent A
        ↓
 message history A


Teams Conversation B
        ↓
    Pi Agent B
        ↓
 message history B
```

这样可以测试 multi-turn：

```text
User:
BK1001 有没有问题？

Agent:
...

User:
那它的 container 是哪个？

Agent:
...
```

第二问不需要重新查询所有信息，因为 Pi Agent 已经保留 conversation context。

Pi 的 `AgentState` 本身就包含消息历史、tools、model 等运行状态。

第一版接受这个限制：

```text
server restart
   ↓
conversation lost
```

没关系。

这反而为下一个实验创造了一个天然问题：

> **如何把 Agent 从 in-memory runtime 升级成 durable runtime？**

然后再研究 AgentHarness。

---

# 9. SSO 第一版也不要做复杂

虽然你们 Teams 已经使用 Entra ID，我第一版**不会做完整 delegated OAuth/OBO**。

因为现在：

```text
Tool
=
local JSON
```

根本没有需要访问的企业系统。

先只记录：

```text
Teams user
conversation id
tenant id
```

作为：

```text
session identity
```

而不是 authorization identity。

等以后接：

```text
Databricks
SharePoint
Graph
internal APIs
```

再真正加入：

```text
Entra SSO
delegated token
OBO
RBAC
```

Microsoft 当前 Teams Bot SSO 支持 1:1 和 group chat，不支持 channel scope，因此 POC 直接采用 **Personal App / 1:1 chat** 会最简单。([Microsoft Learn][2])

---

# 10. Model 我会优先选 Azure OpenAI

原因不是 Azure OpenAI 一定比其他模型好，而是你的环境本身就在 Azure。

Pi 当前已经有：

```text
azureOpenAIResponsesProvider()
```

以及对应的 Azure OpenAI Responses API adapter。

所以第一版链路可以非常纯：

```text
Teams
   ↓
Local/Azure Node app
   ↓
Pi
   ↓
Azure OpenAI
```

如果你们之后要统一经过企业 LLM Gateway，只需要把 Pi 的 model/provider 那层替掉。

---

# 11. 开发阶段甚至不用先部署 Azure

第一版可以：

```text
Teams
 ↓
dev tunnel
 ↓
你的 Mac
 ↓
Teams Node app
 ↓
Pi
 ↓
Azure OpenAI
 ↓
local tools
```

Microsoft 当前官方 Teams SDK quickstart 就支持：

```text
Teams Developer CLI
+
local server :3978
+
dev/testing workflow
```

也支持先用 Microsoft 365 Agents Playground 测试本地 endpoint。([Microsoft Learn][1])

因此非常适合做 Lab：

```text
Mac 本地写代码
        ↓
Teams 真客户端发消息
        ↓
本地 Pi 执行
```

等跑通后再：

```text
git push
 ↓
Azure Container Apps / App Service
```

部署不是第一步。

---

# 12. Repo 我建议长这样

非常简单：

```text
workbuddy-poc/

├── src/
│
│   ├── index.ts
│   │
│   │   # start HTTP server
│   │
│
│   ├── teams/
│   │   └── teams-app.ts
│   │
│   │   # Teams → Pi adapter
│   │
│   ├── agent/
│   │   ├── create-agent.ts
│   │   ├── session-registry.ts
│   │   └── system-prompt.ts
│   │
│   ├── tools/
│   │   ├── get-booking.ts
│   │   ├── get-container-events.ts
│   │   └── get-port-status.ts
│   │
│   └── data/
│       ├── bookings.json
│       ├── events.json
│       └── ports.json
│
├── tests/
│   ├── tools/
│   └── agent/
│
└── README.md
```

我甚至会故意把：

```text
teams/
agent/
tools/
```

分开。

因为这三个目录实际上代表未来 WorkBuddy 的三个重要边界：

```text
Channel
Runtime
Capability
```

---

# 13. 按这个顺序做，不要一次完成

我建议把这个 POC 本身也当成一个 Lab。

### Stage 1 — Pi Only

先不碰 Teams。

终端：

```text
$ npm run agent

> BK1001 有没有延误风险？
```

让 Pi：

```text
LLM
→ tools
→ LLM
→ answer
```

目标：

> 真正理解 Pi Agent Loop。

---

### Stage 2 — Teams Echo

先不用 Pi：

```text
Teams
"hello"

↓

Node

↓

"you said hello"
```

目标：

> 理解 Teams transport。

Microsoft 当前甚至直接提供 TypeScript echo scaffold：

```text
teams project new typescript ...
```

用于这种起步。([Microsoft Learn][1])

---

### Stage 3 — Teams → Pi

替换：

```text
send(`You said ${text}`)
```

为：

```text
await agent.prompt(text)

send(finalAnswer)
```

第一次得到：

```text
Teams
   ↓
Pi
   ↓
Azure OpenAI
   ↓
Teams
```

这是第一个真正的 end-to-end milestone。

---

### Stage 4 — 加 Tool

加入：

```text
get_booking
```

观察：

```text
Teams
→ Pi
→ LLM
→ Tool
→ LLM
→ Teams
```

---

### Stage 5 — Multi-tool Task

再加入：

```text
get_booking
get_container_events
get_port_status
```

让模型自主决定调用顺序。

这一步才是真正的：

> **Agent POC 完成。**

---

### Stage 6 — Multi-turn Conversation

测试：

```text
User:
分析 BK1001

Agent:
...

User:
那它为什么晚了？

Agent:
...

User:
它下一步应该关注什么？

Agent:
...
```

观察 Pi message history 和 context。

---

# 14. 故意注入几个 Failure

因为你的目的不是做 Demo，而是学习 Pi。

跑通以后故意破坏它。

例如：

### Failure 1

```text
get_booking("BAD_ID")
```

让 tool throw。

观察：

```text
Tool error
       ↓
Pi
       ↓
LLM 如何恢复
```

---

### Failure 2

让：

```text
get_port_status()
```

sleep 几秒。

同时用户又发一条 message。

观察：

```text
Agent isStreaming
steering
follow-up
```

Pi 本身有 steering/follow-up queue 机制，很值得你后面做实验。

---

### Failure 3

故意让两个工具并行。

例如：

```text
get_container_events()
get_port_status()
```

模型一次返回两个 tool calls。

Pi 默认可以并行执行多个工具，但最终 transcript 中的结果仍保持 assistant 原始调用顺序。

你之前刚刚深入研究过 batching/concurrency，这里会看到另外一种非常直观的并发语义。

---

# 15. POC 完成标准不要用“看起来能聊”

我会定义五个明确的 exit criteria：

| 能力         | 必须做到                               |
| ---------- | ---------------------------------- |
| Teams      | 用户能在 1:1 Teams 中给 Agent 发消息        |
| Pi         | Teams 输入确实进入 Pi Agent runtime      |
| Multi-turn | 第二句话能利用第一轮 context                 |
| Tool       | Pi 自主选择并调用工具                       |
| Multi-tool | 一个 task 可以经历至少两个 LLM→Tool→LLM turn |

外加一个 learning criterion：

> 你能够看日志，完整解释一次 request 为什么经历了每一个 turn。

例如你能够指着日志解释：

```text
为什么这里是 turn 1
为什么 LLM 此时选择 tool
tool result 怎样成为下一轮 context
为什么这里自动触发了 turn 2
什么时候 agent_end
```

如果你能解释清楚这些，**这个 POC 的学习目标就达成了。**

---

## 我认为这就是合适的 POC 边界

```text
V0

Teams Personal App
        │
        ▼
Teams SDK
        │
        ▼
Pi Agent
        │
        ├── Azure OpenAI
        │
        ├── get_booking()
        ├── get_container_events()
        └── get_port_status()
```

**所有数据 local fixture。**

暂时明确不做：

```text
❌ sandbox
❌ file upload
❌ PDF
❌ Excel
❌ Databricks
❌ distributed workflow
❌ persistent session
❌ tool gateway
❌ complex SSO
```

然后你的升级路线会非常自然：

```text
POC 0
Teams → Pi → local tools

        ↓

POC 1
Teams → Pi → PDF / Excel

        ↓

POC 2
Teams → Pi → Databricks

        ↓

POC 3
Durable AgentHarness

        ↓

POC 4
Sandbox + Artifact

        ↓

WorkBuddy Platform
```

这样每一步都会新增**一个你真正想理解的系统概念**，而不是一开始把二十个组件堆起来。

这也非常符合你之前确定的学习闭环：**Mental Model → Small Lab → Failure Injection → Measurement → Design Decision → 下一阶段系统化。**

[1]: https://learn.microsoft.com/en-us/microsoftteams/platform/teams-sdk/getting-started/quickstart "Quickstart | Microsoft Learn"
[2]: https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/authentication/bot-sso-overview "Enable SSO with Microsoft Entra ID - Teams | Microsoft Learn"

