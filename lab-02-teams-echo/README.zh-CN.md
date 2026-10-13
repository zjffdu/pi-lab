# Lab 02 — Teams Transport，暂无 Agent

[English](README.md) | 中文

构建最小的 Teams SDK app，在引入任何 LLM 或 Pi agent 之前，先证明 transport 层能端到端跑通。

## 学习目标

完成本 lab 后，你应当能根据自己的 console 输出和 Agents Playground 的日志面板解释下面这条序列：

```text
Teams user sends "hello"
  -> HTTP POST /api/messages (Bot Framework activity, type=message)
  -> app.on("message", ...) handler runs
  -> handler computes a reply synchronously (no LLM call)
  -> ctx.reply(...) sends the reply back through the same channel
  -> Teams user sees "you said: hello"
```

本 lab 刻意**不包含 Pi agent、LLM 和 tool**。回复只是输入文本的纯函数。目的是把 Teams SDK 隔离成一个
transport adapter——请求进来、activity 被解析、回复发出去——然后再在后续 lab 里把真正的 agent runtime 接到它后面。

本 lab 的 non-goals：

- 没有 `@earendil-works/pi-agent-core` 的 `Agent`，没有 model provider，没有 tool call（那是
  [Lab 01](../lab-01-pi-agent-loop/README.zh-CN.md) 的内容；它会在 Lab 03 回来）
- 没有真实的 Teams tenant、App Registration、manifest 或 SSO——一切都跑在本地的 **Microsoft 365 Agents Playground** 上
- 没有部署、没有 dev tunnel、没有 `AgentHarness`、重启后不做持久化

## 前置条件

- Node.js 22.12 或更新版本（`@microsoft/teams.apps@2.1.0` 在其 `engines` 字段里声明的版本）
- npm

不需要 API key 或凭证。app 以 `dangerouslyAllowUnauthenticatedRequests: true` 运行，这只有在它仅与你本机上的
本地 Agents Playground 通信、从不接触真实 Teams 服务时才是安全的。

### Pi 版本

本 lab 不依赖 Pi，因此不受 Pi `0.85.1` → `1.1.x` 变化的影响，也不需要 Pi 1.1 重建版。agent loop 的 Pi 1.1 重建版是
[`lab-01-pi-agent-loop-pi-1.1`](../lab-01-pi-agent-loop-pi-1.1/README.md)；从 Lab 03 开始的 Pi 类 lab，所固定的 Pi 版本才会起作用。

## 1. 运行前先预测

在启动任何东西之前，先写下你的答案：

1. Teams SDK app 默认监听哪个 HTTP endpoint 和 method？
2. 入站 activity 的哪个字段携带 message 文本？
3. 如果你发送空消息或只有空白字符的消息，handler 应该 crash、什么都不 echo，还是回复别的内容？
4. `ctx.reply(...)` 是与 HTTP response 同步的，还是一次独立的出站调用？

在写下这些答案之前，不要查看源码。

## 2. 安装依赖

```bash
cd lab-02-teams-echo
npm install
```

## 3. 验证确定性的部分

```bash
npm run check
```

这些测试覆盖 `formatEcho`（回复逻辑）和 trace logger 的格式化。它们不启动 server，也不发起网络调用。

## 4. 运行 app

```bash
npm run dev
```

预期输出：

```text
[WARN] @teams/app No credentials configured (CLIENT_ID / CLIENT_SECRET / TENANT_ID), but dangerouslyAllowUnauthenticatedRequests is enabled. Bot will accept unauthenticated requests on /api/messages.
[INFO] @teams/app listening on port 3978 🚀
```

让它在一个终端里保持运行。

## 5. 运行 Microsoft 365 Agents Playground

在第二个终端里：

```bash
npm run playground
```

这会启动一个本地的 mock Teams client（无 tenant、无需登录），使用它自己的端口（输出里会打印，默认 `56150`），
并把它连接到你的 app 的 `http://localhost:3978/api/messages`。在浏览器中打开那个 URL。

## 6. Happy path

在 Playground 的聊天框中发送：

```text
hello lab 2
```

观察：

- Playground 的 **Log Panel** 显示一个发往你的 app 的 `message 200` 请求，以及一个返回的 `message 201` 回复。
- 聊天里显示 `you said: hello lab 2`。
- 你的 `npm run dev` 终端打印：

```text
[Teams] activity_received type=message conversation=<id> text="hello lab 2"
[Teams] reply_sent conversation=<id> text="you said: hello lab 2"
```

重要的不变量不是确切的措辞——而是确实发生了一次真实的 HTTP 往返（在 Playground 的日志面板中可见），
并且你的 app 自己的 trace log 确认它在同一个 conversation ID 上收到并回复了消息。

## 7. 注入失败

发送一条只含空白字符的消息（输入几个空格，然后发送）。

观察：

- handler 不会 throw，也不会出现 `handler_error` trace 行。
- 回复是 `I received an empty message. Send some text and I will echo it back.`——而不是对空白文本的编造式 echo。
- 这与 Lab 01 的 `BAD_ID` 场景是同一种"不编造、不在边界情况上 crash"的纪律，只不过这次应用在 transport 层的输入上，
  而不是 tool call 上。

## 8. 解释 trace

用 Playground 日志面板和你的终端输出回答：

1. 哪一行日志证明请求确实离开了 Playground 进程，并通过真实的 HTTP 打到了你的 Node 进程？
2. 为什么在每种情况下，甚至包括空消息路径，`activity_received` 都出现在 `reply_sent` 之前？
3. 一旦有真正的 Pi agent 处于 `activity_received` 和 `reply_sent` 之间，你预期这条 trace 会发生什么变化（turn、
   tool call、多次 LLM 往返）？现在不需要构建它——只需预测，因为这正是 Lab 03 要引入的内容。

## 完成标准

- `npm run check` 通过。
- 在 Playground 里发送一条普通消息，会产生一条 `you said: ...` 回复，以及一对匹配的 `activity_received` / `reply_sent` trace。
- 发送只含空白的文本会产生空消息回复，而不是 crash，也不是编造的 echo。
- 你能指着 Playground 的日志面板和你的终端 trace，解释每一行为什么出现在它所在的位置。

## 项目结构

```text
src/echo.ts         纯回复逻辑，不依赖 SDK 或网络
src/trace-logger.ts 生命周期观察，形状与 Lab 01 的 trace-logger 相呼应
src/create-app.ts   Teams App 的构造与 message handler
src/index.ts        进程入口（app.start()）
tests/              不启动 server、不发起网络调用的测试
```

## 故障排查

### 端口 3978 或 Playground 的端口上出现 `EADDRINUSE`

已有另一个进程在监听。停掉它，或者给 `app.start(port)` / `npm run playground -- -p <port>` 传入不同的端口
（如果你同时更改了 app 的端口，记得同步更新 `-e` endpoint）。

### Playground 日志面板显示连接错误，而不是 `200`

确认 `npm run dev` 仍在运行，并且在启动 Playground 之前已经打印了 `listening on port 3978`。

### 聊天里始终没有出现回复，但你的终端显示了 `reply_sent`

在 Playground 日志面板里查看这次出站调用的状态码。如果不是 `2xx`，可能是 Playground 发送的 conversation ID
与 `ctx.reply` 所指向的不一致——重启两个进程，让它们就一个全新的 conversation 达成一致。
