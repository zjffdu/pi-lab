# Lab 03 — Teams 接入 Pi

[English](README.md) | 中文

把已验证的 Lab 01 Agent Loop 和已验证的 Lab 02 Teams transport 组合起来：一个很薄的 adapter，把一条 Teams 消息交给一个全新的 Pi agent，再把 Pi 的最终回答返回。

本 lab 运行在 `@earendil-works/pi-agent-core` / `pi-ai` **1.1.0** 上。Teams 部分（`@microsoft/teams.apps`、Agents Playground）来自 [Lab 02](../lab-02-teams-echo/README.zh-CN.md)。

## 学习目标

完成本 lab 后，你应当能用同一个 request ID 追踪一条请求穿过两层的全过程：

```text
Teams message
  -> thin adapter (create-app.ts / message-handler.ts)
  -> new Pi Agent for this request (agent-runner.ts)
  -> DeepSeek
  -> get_booking
  -> final answer
  -> Teams reply
```

本 lab 的 non-goals：

- 不止一个 tool（仍然只有来自 [Lab 01](../lab-01-pi-agent-loop/README.zh-CN.md) 的 `get_booking`）
- 不按 conversation 复用 agent，也没有多轮上下文——每条消息都用一个全新的 agent（那是 [Lab 05](../ROADMAP.md)）
- 不处理并发的用户消息
- 不部署到真实 Teams tenant，不做 SSO，不做持久化

## 架构边界

```text
src/
  booking-repository.ts   fixture lookup, copied from Lab 01
  get-booking-tool.ts      the one tool, copied from Lab 01
  create-agent.ts          builds a fresh Pi Agent for one request
  pi-trace-logger.ts        Indented agent/turn/tool tree logger, every line tagged [Pi][req:<id>]
  agent-runner.ts          the AgentRunner boundary — never rejects
  teams-trace-logger.ts     Teams lifecycle logging, prefixed [Teams][req:<id>]
  message-handler.ts        pure delegation: trace + call the runner
  create-app.ts             Teams App wiring: ctx -> message-handler -> ctx.reply
  index.ts                  process entrypoint
```

`AgentRunner` interface 是本 lab 真正要讲的那条边界：

```typescript
interface AgentRunner {
  run(input: { text: string; requestId: string }): Promise<{ answer: string }>;
}
```

`createPiAgentRunner()` 是真实实现，包装了 Lab 01 的 agent。它**保证永远不会 throw**——provider 配置错误、model 无法解析、`agent.prompt()` 抛出的意外异常，都会在 `run()` 内部被捕获，变成同一个固定的 `INFRASTRUCTURE_ERROR_ANSWER` 字符串。`create-app.ts` 里的 Teams handler 不需要区分成功回答、有界的"booking not found"回答（它产生于 Pi 自己的 tool-error 处理*内部*）和被捕获的基础设施故障——它只是把 `AgentRunner.run()` 返回的字符串发回去。

`message-handler.ts` 把委托逻辑（追踪入站 activity、调用 runner）写成一个不依赖 Teams SDK 的普通 async 函数，因此可以用 fake `AgentRunner` 做单元测试——和 Lab 02 不起真实 server 就测 `formatEcho` 是一个思路。真实的 `AgentRunner`（实际调用 DeepSeek）只在下面的 live Playground 冒烟测试里运行，不会进入 `npm test`。

## 前置条件

- Node.js 22.19 或更高版本
- npm
- 已配置好的 `.env`（复制 `.env.example`；如何获取 DeepSeek API key 见 [Lab 01](../lab-01-pi-agent-loop/README.zh-CN.md)）

## 1. 运行前先预测

开始任何操作之前，先写下你的答案：

1. 哪些日志行属于 Teams，哪些属于 Pi？在 console 里你怎么分辨一对匹配的日志？
2. 如果缺少 `DEEPSEEK_API_KEY`，失败会在哪一步暴露——是 `agent.prompt()` 内部、一个抛出的异常，还是 `agent.state.errorMessage`？`AgentRunner` 在哪里捕获它？
3. 当你询问 `BK1001` 时，在 Teams 回复发出之前，你预计会看到多少条 `[Pi][req:...]` 的 turn_start 行？

## 2. 安装依赖

```bash
cd lab-03-teams-pi
npm install
cp .env.example .env   # 然后填入 DEEPSEEK_API_KEY
```

Pi 依赖固定在 `1.1.0`。`.env` 必须使用 Pi 1.1 的 model id：

```dotenv
PI_PROVIDER=deepseek
PI_MODEL=deepseek-flash
DEEPSEEK_API_KEY=...
```

Pi `1.1.0` 把这个模型登记为 `deepseek-flash`。绝不要 commit `.env`。

## 3. 验证确定性的部分

```bash
npm run check
```

它覆盖：booking fixture、`get_booking` tool、Teams trace 的格式、`message-handler.ts` 在 **fake** `AgentRunner` 下的委托逻辑，以及默认 model 能在固定版本的 Pi 1.1 catalog 里解析。

它还会通过 `createPiAgentRunner`，用一个 scripted stream function 驱动**真实**的 Pi `Agent`，这样 runner 的三种结果都能在不接真实模型的情况下，针对 Pi `1.1.0` 本身得到检查：

- 成功的 tool call 返回模型的最终文本，并且每一行 `[Pi]` trace 都带着 request ID；
- 未知 booking（`BAD_ID`）是一个 tool error，变成模型自己给出的 not-found 回答——它**不会**被转成基础设施错误回答；
- provider 失败（`stopReason: "error"`）在 runner 内部被捕获，trace 记为 `provider_error`，并返回有界的基础设施错误回答；
- 无法解析的 provider/model 会返回基础设施错误回答，而不是 throw（`setup_error`）。

这些都不会发起网络调用。

## 4. 运行 app

```bash
npm run dev
```

预期输出里会有和 Lab 02 相同的未认证请求警告，因为本 lab 仍然只和本地 Agents Playground 通信。

## 5. 运行 Microsoft 365 Agents Playground

在第二个终端里：

```bash
npm run playground
```

打开打印出来的 Playground URL。

## 6. 正常路径

提问：

```text
What are the details for BK1001?
```

`pi-trace-logger.ts` 渲染的缩进 agent/turn/tool 树和 Lab 01 的 logger 相同，每一行都带 `[Pi][req:<id>]` 标签——在这里这个标签至关重要，因为这个 server 可能同时有多个 Teams activity 在处理中。预期的终端 trace（仅作示意——最终回答的具体措辞随模型而异）：

```text
[Teams][req:<id>] activity_received type=message conversation=<conv> text="What are the details for BK1001?"
[Pi][req:<id>] ▶ agent
[Pi][req:<id>]   ▶ turn #1
[Pi][req:<id>]     user       "What are the details for BK1001?"
[Pi][req:<id>]     [Assistant] I'll look that up.
[Pi][req:<id>]     ▶ tool_start get_booking call=call-1 args={"bookingNo":"BK1001"}
[Pi][req:<id>]     ◀ tool_end get_booking status=success
[Pi][req:<id>]     toolResult get_booking status=success
[Pi][req:<id>]   ◀ turn_end #1 tool_results=1
[Pi][req:<id>]   ▶ turn #2
[Pi][req:<id>]     [Assistant] ...fixture-backed answer...
[Pi][req:<id>]   ◀ turn_end #2 tool_results=0
[Pi][req:<id>] ◀ agent_end
[Teams][req:<id>] reply_sent conversation=<conv> text="..."
```

这一条请求里的每一行都共享同一个 `req:<id>`——这就是 Lab 02 做不到的关联，因为它没有 Pi 层可供关联。

## 7. 注入故障——未知 booking

提问：

```text
What are the details for BK9999?
```

观察 tool 在 Pi 内部报错（`tool_end get_booking status=error`），最终回答是有界的"booking not found"陈述，而不是编造的内容。这一路径不会进入 `AgentRunner` 自己的错误处理——它完全在 Pi agent loop 内部被处理，和 Lab 01 的 `BAD_ID` 情形一样。

## 8. 注入故障——缺少 provider 配置

停止 app。把 `.env` 里的 `DEEPSEEK_API_KEY` 注释掉（或者把 `PI_PROVIDER` 改成一个无效值）。重启 `npm run dev`，在 Playground 里问任意问题。

观察：

- app **不会**崩溃——它继续监听下一条消息。
- 终端显示 `[Pi][req:<id>] setup_error ...` 或 `provider_error ...` 行，绝不是 `handler_error` 行——故障在 `agent-runner.ts` 内部被捕获，还没到达 Teams handler。
- Teams 回复是固定的基础设施错误句子，而不是卡住或编造的回答。

之后恢复 `.env`。

## 9. 解释 trace

用你的终端输出回答：

1. 哪一行日志证明 Teams 层把请求交给了 Pi，哪一行证明 Pi 把最终回答交了回来？
2. 在缺少 provider 的情形下，为什么 trace 显示的是 `setup_error`/`provider_error` 而不是 `handler_error`？`agent-runner.ts` 要怎么改，provider 失败才会变成 `handler_error`？
3. 为什么 `create-app.ts` 里永远不需要 `if (answer is an error) ...` 这样的分支？

## 完成标准

- `npm run check` 通过。
- 针对 `BK1001` 的 Playground 请求产生了完整的 Pi 生命周期（`agent_start` ... `agent_end`），且恰好一条 Teams 回复，并由同一个 request ID 关联。
- `BK9999` 的回复是有界的 not-found 陈述，基于 fixture，没有编造。
- 移除 provider 配置后 transport 依然存活，并返回固定的基础设施错误回答，且有证据表明捕获发生在 `agent-runner.ts` 内而不是 Teams handler 里。
- 你只凭 console 输出，就能追踪一条请求穿过 transport、runtime、tool 和 response 这几条边界。

## 值得知道

- **system prompt 是 transcript 的一部分。** `agent.state.messages` 以一条 `system` 消息开头，接着是 `user`、`assistant`、`toolResult`、`assistant`。它不会触发 `message_*` 事件，所以永远不会出现在 `[Pi][req:<id>]` 树里。`agent-runner.ts` 里的 `latestAssistantText` 仍然能选对消息，因为它按 `role === "assistant"` 过滤。
- **过期的 model id 不会让 server 崩溃。** `createBookingAgent` 抛出 `Unknown model`，`agent-runner.ts` 把它捕获，每条 Teams 消息都会得到有界的基础设施错误回答，并带一行 `setup_error` trace。这就是 `tests/create-agent.test.ts` 要断言默认 model 能在 catalog 里解析的原因。
- **`createBookingAgent` 和 `createPiAgentRunner` 接受一个可选的 `streamFn`**，只在测试里用来给模型编写脚本。
- **provider 失败**表现为一条 `stopReason: "error"` 的 `assistant` 消息加上 `agent.state.errorMessage`，runner 把它转成 `provider_error` 加基础设施错误回答。

## 故障排查

model/provider 错误见 [Lab 01](../lab-01-pi-agent-loop/README.zh-CN.md)，Playground 连接问题见 [Lab 02](../lab-02-teams-echo/README.zh-CN.md)——两者在这里原样适用。

### `setup_error Unknown model ...`

`.env` 里的 `PI_MODEL` 值已过期。把 `.env` 里的 `PI_MODEL` 设为 `deepseek-flash`，然后重启 `npm run dev`。在此期间 Teams 回复的是固定的基础设施错误回答，因为 runner 捕获了这个 setup 失败。

### 明明设置了 `DEEPSEEK_API_KEY`，却出现 `provider_error Connection error.`

`npm run dev` 运行的是 `node --use-env-proxy --import tsx src/index.ts`，让 Node 的 `fetch` 遵循 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`，和 Lab 01 的 `npm run agent` 脚本一致。如果你用其他方式调用 `src/index.ts`（自定义脚本、调试器启动配置、直接用 `tsx`），请把 `--use-env-proxy` 加回去，否则 DeepSeek 请求会绕过你的 proxy/VPN，即使 API key 有效也连不上。
