# Lab 01 — 观察 Pi Agent Loop

[English](README.md) | 中文

**问题：** 从用户提问，到模型请求调用 tool，再到模型给出最终答案，Pi 在中间做了什么？
**本 lab 的答案：** 模型从不执行任何东西，它只是*提出请求*。让这个循环跑起来的有两件事：

- **Pi 负责执行请求。** 模型的回复里带了 tool call，Pi 就去运行你写的函数，并把结果作为 `toolResult` message 追加进 transcript。
  模型的"请求"和 Pi 的"执行"是两个独立的事件，由 `call=` id 配对。
- **Pi 自动开始下一个 turn。** 执行过 tool 的 turn 之后，会紧跟着另一个 turn，读取更新后的 transcript，不需要新的用户消息。
  第一个不再请求 tool 的 turn 结束时，整次运行就结束了。

可以类比成：模型是顾客，Pi 是服务员，tool 是后厨：顾客点菜，服务员去取菜，顾客再决定接下来说什么。

## 一个具体场景

你做了一个订舱助手。客户输入*"What are the details for booking BK1001?"*。模型从没见过 `BK1001`，没有 tool 的话它只能瞎猜船名和箱号，而且说得很自信。

用了这个循环：

1. **Turn #1。** 模型还没回答，只回复一条请求：用 `{"bookingNo":"BK1001"}` 调用 `get_booking`。
2. Pi 对着 `data/bookings.json` 运行 `get_booking`，把查到的记录追加进 transcript。
3. **Turn #2。** 手里有了记录，模型回答：箱号 `MSKU1234567` 和 `MSKU7654321`，船名 `MAERSK TEST`，等等。
4. 客户问 `BAD_ID`。tool 失败，Pi 追加错误，模型说找不到这个 booking，没有编造任何细节。
5. provider 的 key 填错了。运行在 turn #1 就以错误结束，CLI 以非零退出码退出，而不是打印一个空答案。

谁需要理解这些？**你，开发者。** 客户只看到最终答案，trace 是让你看清助手*为什么*这么说的办法。

| 场景里的事 | lab 里的概念 |
| --- | --- |
| 模型请求去查一下 | `assistant (tool call)` 那一行 |
| 查询真正发生 | `tool_start` / `tool_end`（`get_booking`） |
| 模型读到的查询结果 | `toolResult` message |
| 第二次回答自己开始 | turn #2 |
| 什么都没查到 | `status=error`，然后给出"没找到"的回答 |

## 核心思路

```text
用户提问 ─▶ turn #1：模型 ─▶ tool call 请求 ─▶ Pi 运行 tool ─▶ toolResult 进入 transcript
                                                                        │
                    最终答案 ◀─ turn #2：模型读取 transcript ◀───────────┘
```

三点要记住：

1. **请求不等于执行。** `assistant (tool call)` 是模型提出的请求，带着它自己选的参数；`tool_start`/`tool_end` 才是 Pi 在执行。
   如果模型没有提出请求，这些行就不会出现。
2. **transcript 就是状态。** `agent.state.messages` 依次是 `system`、`user`、`assistant`、`toolResult`、`assistant`。
   system message 携带 prompt 和 tool 声明，每次调用都会发给模型，但它不产生事件，所以 trace 里看不到它。
   Turn #2 没有 `user` 行，是因为没有新增 user message；它的输入就是 turn #1 累积起来的 transcript。
3. **失败只是普通消息。** tool 失败会变成 `status=error` 的 `toolResult`。provider 失败则让运行以一条 `stopReason` 为 `error` 的
   `assistant` message 结束，并设置 `agent.state.errorMessage`。

不涉及：Teams、多个 tool、持久化、并行 tool、steering。

## 实验

下面每个 prompt 都对着真实模型各运行一次：

1. 查询已知 booking（`BK1001`）。
2. 查询不存在的 booking（`BAD_ID`）。
3. 问一个不需要查询的问题。
4. 用无效的 API key 运行第一个 prompt。

每种各一次真实运行的结果（用一个一次性脚本统计，不在仓库里）：

| prompt | turn 数 | tool 执行 | transcript 角色 | 答案提到两个箱号 | 运行以错误结束 |
| --- | --- | --- | --- | --- | --- |
| `BK1001` | 2 | 1（success） | system, user, assistant, toolResult, assistant | 是 | 否 |
| `BAD_ID` | 2 | 1（error） | system, user, assistant, toolResult, assistant | 否 | 否 |
| "what is a shipping booking?" | 1 | 0 | system, user, assistant | 否 | 否 |
| `BK1001`，无效 key | 1 | 0 | system, user, assistant | — | 是（401），退出码 1 |

- **turn 数取决于模型的选择**，不是固定值：没有请求 tool 时，循环一个 turn 就结束。
- **`BAD_ID` 的形状和 `BK1001` 完全一样**，只有 tool 的状态不同，答案里也没有任何箱号。
- **provider 调用失败也能干净地结束**：错误出现在 trace 里和 `agent.state.errorMessage` 里，CLI 把它变成退出码 1。
- 每次运行措辞会不同。Turn #1 有时会在 tool call 那行之前多一行简短的 `[Assistant]` 开场白，结构没有变。

21 个离线测试补充了真实运行无法固定的东西：它们用脚本化的 stream function 驱动真实的 `Agent`，断言精确的 trace 树、transcript 角色、
tool 报错路径和 provider 失败路径，并检查默认模型 id 能在固定版本的 catalog 里解析出来。

## 怎么运行

```bash
cd lab-01-pi-agent-loop
npm install
cp .env.example .env            # 然后填入 DEEPSEEK_API_KEY
npm run check                   # typecheck + 21 个离线测试，不调用模型
npm run agent -- "What are the details for booking BK1001?"
```

自己动手试试：

```bash
npm run agent -- "What are the details for booking BAD_ID?"        # tool_end ... status=error，答案说没找到
npm run agent -- "In one sentence, what is a shipping booking?"    # 一个 turn，没有 tool 的行
DEEPSEEK_API_KEY=invalid npm run agent -- "hi"; echo "exit=$?"     # assistant (error) 401 ...，exit=1
PI_MODEL=nope npm run agent -- "hi"                                # Unknown model deepseek/nope. Available ...
```

怎么读 trace（call id 和答案文本已省略）：`▶`/`◀` 在同一缩进处打开和关闭一个 span。

```text
▶ agent
  ▶ turn #1
    user       "What are the details for booking BK1001?"
    assistant (tool call) get_booking call=call_00_... args={"bookingNo":"BK1001"}
    ▶ tool_start get_booking call=call_00_... args={"bookingNo":"BK1001"}
    ◀ tool_end get_booking status=success
    toolResult get_booking status=success
  ◀ turn_end #1 tool_results=1
  ▶ turn #2
    [Assistant] ...根据记录生成的答案...
  ◀ turn_end #2 tool_results=0
◀ agent_end
```

## 自测

运行 agent 之前先写下 1–3 题的答案，其余的运行后再答：

1. `BK1001` 你预计有几个 LLM turn？对一个不需要查询的问题呢？
2. 哪一行表示模型在请求，哪一行表示 Pi 在执行，什么把它们配对？
3. booking 号不存在时应该发生什么？
4. Turn #2 没有 `user` 行。模型在 turn #2 读到的是什么？
5. 哪个事件能证明是 Pi 执行了 tool，而不是模型编造了数据？
6. 为什么 `agent_end` 只在最终的 assistant 回复之后才出现？

## 值得知道

- **版本：** `@earendil-works/pi-agent-core` 和 `pi-ai` 固定为 `1.1.0`，Node 24.5 或更新。默认模型是 `deepseek-flash`；
  如果这个 id 在固定版本的 catalog 里解析不出来，`npm run check` 会失败。
- **其他 provider：** `.env` 里的 `PI_PROVIDER` 和 `PI_MODEL` 决定用哪个模型，每个 provider 读它自己的 key（例如 `ANTHROPIC_API_KEY`）。
  catalog 里有 42 个 provider；这个 lab 只用 DeepSeek 做过真实运行。
- **隐私：** booking 数据留在本地 fixture 里，但用户 prompt 和 tool transcript 会发给 provider。
- **代理：** `npm run agent` 用 `--use-env-proxy` 启动 Node，所以 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 会生效。
  没有它，在有代理的网络里，测量这个 lab 时每次运行都以错误结束。
- **一次一个 tool：** `toolExecution: "sequential"` 让 trace 保持线性。并行执行是后面某个 lab 的主题。
- **确定性的查询：** 只有模型是否调用 tool、以及它的措辞会变；tool 返回的内容不会变。
- **可能遇到的失败：**
  - `Unknown model deepseek/…` — 保持 `PI_PROVIDER=deepseek`、`PI_MODEL=deepseek-flash`。
  - `Provider is not configured: deepseek` — 在 `.env` 里设置 `DEEPSEEK_API_KEY`。
  - `401 … Authentication Fails` — key 不对；排查时不要把它打印出来。
  - `Connection error.` — 检查代理是否在运行，以及 `api.deepseek.com` 是否不在 `NO_PROXY` 里。
- 不要提交 `.env`。

## 文件在哪里

```text
src/booking-repository.ts  加载并校验 data/bookings.json（一个 booking 有一个或多个 container）
src/get-booking-tool.ts    get_booking tool；查不到的 booking 会抛错，Pi 把它变成 tool error
src/create-agent.ts        选模型、system prompt、构造 Agent（测试可传入脚本化的 stream）
src/trace-logger.ts        把事件流渲染成缩进的 agent/turn/tool 树
src/cli.ts                 终端入口；provider 失败时以非零退出码退出
data/bookings.json         唯一的 fixture booking，BK1001
tests/                     离线测试，包括用脚本化 stream 驱动的真实 Agent
```
