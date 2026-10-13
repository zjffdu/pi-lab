# Lab 07 — Durable Harness Session

[English](README.md) | 中文

**问题：** 进程重启之后，一段已经跑完一轮的对话怎么接着往下聊？
**本 lab 的答案：** 对话存在文件里，不在进程里。由此得到两点：

- **文件保存对话。** 每条消息和 tool 结果都提交到一个 JSONL 存储目录。新进程打开同一个目录，读回同样的 entry。
- **进程只保存"机器"。** `Harness`（调模型、跑 tool、调度）每次启动都是新建的，里面没有任何东西需要活过重启。

可以类比成笔记本和笔：笔记本是 storage，笔是 harness。换一支笔，笔记还在。

## 一个具体场景

你做了一个客服助手。客户问了 booking `BK1001` 的情况，十分钟后又问*"它用的是哪个箱子？"*。这期间你的服务重新部署了一次。

| 时刻 | 没有 durable 存储 | 用了本 lab 的做法 |
| --- | --- | --- |
| 客户问 `BK1001` | 助手查订单并回答 | 同样，并且每条消息和 tool 结果都提交到了磁盘 |
| 重新部署 | 进程没了，transcript 跟着没了 | 进程没了，文件还在 |
| 客户问"它用的是哪个箱子？" | 新进程什么都不知道，只能反问"哪个 booking？" | 新进程打开同一个 session，读回 transcript，不用再查订单就说出两个箱子 |
| 另一个客户问同样的追问 | 不适用 | 他的 session 是另一个目录，所以助手会问他指的是哪个 booking |

谁需要理解这些？**你，开发者。** 客户从不会看到 session。你要决定一个 session id 对应什么（一个聊天、一个用户、一张工单），
并保证重启之后同一个 id 还能落到同一个 storage。

| 场景里的东西 | lab 里的东西 |
| --- | --- |
| 客户的这个聊天 | session id（`conversation-a`） |
| 笔记本 | 存储目录 `session-data/<id>/` |
| 笔 | `Harness`，由 `Harness.open(storage)` 打开 |
| 聊天的这条线 | 根 `Conversation` 和它的 `Entry` 记录 |
| 客户的一句话加它的回答 | 一个 `Submission`（`submit()` 然后 `wait()`） |
| "旧进程没有留下做到一半的事" | `harness.inspect()` 报告没有未完成的 task |

## 核心思路

```text
session id ─▶ 存储目录 ─▶ Harness.open() ─▶ root() ─▶ submit() / wait() ─▶ close
              （在磁盘上，保留）  （每次启动重建）
```

| 东西 | 放在哪 | 重启之后 |
| --- | --- | --- |
| entry、document、task、submission | storage 文件 | 原样读回 |
| `Harness`、`Conversation` 句柄 | 进程内存 | 重新创建 |
| tool 和 system prompt 文本 | 你的代码（extension registry） | 你要重新安装 |

三个要点：

1. **一份完成的 transcript 能熬过一次干净的重启，追问直接基于它回答。** 不会再发起第二次 tool 调用。
2. **不同 session id 永远不会碰面。** 每个 id 是自己的目录，从空开始。
3. **"没有未完成的东西"比"未完成的工作可以恢复"弱得多。** 这里 `inspect()` 为空，是因为每次 run 都跑完了。run 进行到一半杀进程
   没有覆盖，那是下一个 lab 的任务。

不覆盖：run 中途崩溃、tool replay、compaction、fork，以及任何 Teams transport。

## 实验

每次 CLI 调用是一个 turn、一个进程，所以再运行一次就是一次真正的重启。Fixture：[`data/bookings.json`](data/bookings.json)；`BK1001` 有两个箱子。

1. Turn 1，新 session `conversation-a`："What are the details for booking BK1001?"（一次真实的 tool 调用）。
2. Turn 2，新进程，同一个 session id："Which container is it using?"
3. 对照，新 session `conversation-b`：同样的追问。

## 测量结果

来自一次 `deepseek/deepseek-flash` 的真实运行：

| 调用 | session | `entries(before)` | tool 调用 | `entries(after)` | 回答 |
| --- | --- | --- | --- | --- | --- |
| turn 1 | `conversation-a` created | 0 | `get_booking` | 5 | 列出两个箱子 |
| turn 2（新进程） | `conversation-a` reopened | 5 | 无 | 7 | "用了两个箱子"，两个都点名 |
| 对照 | `conversation-b` created | 0 | 无 | 3 | 反问是哪个 booking |

- **turn 2 的 `newestEntry(before)` 等于 turn 1 的 `newestEntry(after)`**（都是 `15`）：最新的 entry 是从一个已退出的进程写下的文件里读出来的。
  光看数量看不出这一点。
- **turn 2 恰好新增两条 entry**（一条 `pi.user`、一条 `pi.assistant`，id 是 `16` 和 `19`）。turn 1 的那五条没被动过。
- **entry id 会跳号**（`7, 10, 11, 13, 15, 16, 19`）：entry、task、document、submission 共用一个计数器。要数 `[Entry]` 的行数，别看 id。
  `main.jsonl` 每行的 `seq` 是另一个数字，是 commit 的序号。
- **`conversation-b` 有一条 `pi.system` entry，`conversation-a` 的 turn 2 没有**：system entry 保存 prompt 和 tool 声明，只在它们变化时才写。
- **第二个箱子 `MSKU7654321` 在磁盘上出现于 tool 结果（turn 1）和每条点名它的回答里**，所以 turn 2 不需要再查。

离线测试用脚本化的模型断言同样的事：重开后的 transcript 与第一个进程的 entry 逐条相等；第二次请求带着第一个进程的 tool 结果；
`get_booking` 在两个进程里总共只跑一次；每次挂载时 `inspect()` 都为空；provider 失败以 `unanswered` 结算，CLI 退出码为 1。

## 运行

```bash
cd lab-07-durable-harness-session
npm install
cp .env.example .env            # 然后填入 DEEPSEEK_API_KEY
npm run check                   # typecheck + 25 个离线测试，不调用模型
```

亲手试试（每一行都是独立的进程）：

```bash
npm run agent -- --session try --prompt "What are the details for booking BK1001?"
npm run agent -- --session try --prompt "Which container is it using?"
npm run agent -- --session other --prompt "Which container is it using?"
ls session-data/try                       # main.jsonl 加几个 doc-N.jsonl
grep -c MSKU7654321 session-data/try/main.jsonl   # 3：tool 结果和两条回答
```

看 trace：它和前面几个 lab 是同一种 run/turn 树，由已提交的事件生成。模型的 tool 调用请求（`assistant (tool call) … call=<id> args=<json>`）和
Pi 执行它（`tool_start`/`tool_end`）是不同的行，靠 `call=` 配对。`[Harness] unfinishedTasks=… unsettledSubmissions=…` 是启动时的 `inspect()`。
不要手动编辑 `session-data/`。

## 自测

运行之前先写下 1–3 的答案，其余的运行之后再答：

1. 重启之后，哪些 entry 还在？
2. 重启时哪些是重建的，哪些是从磁盘读回来的？
3. 第二个进程调用什么来拿回"同一个 conversation"，靠什么标识？
4. 为什么 turn 2 不需要 `get_booking` 调用？trace 的哪一行说明了这点？
5. 这里 `unfinishedTasks=0` 证明了什么，没证明什么？
6. 为什么 `conversation-b` 的第一个 turn 会新增 `pi.system` entry，而 `conversation-a` 的 turn 2 不会？

（这个 lab 还没有记录学习者的预测。）

## 值得知道

- **版本：** `pi-durable`、`pi-ai`、`chord` 固定为 `1.1.0`。`pi-durable` 被标为 experimental，所以本 lab 依赖的行为都是先读它的类型再实际观察的。默认模型 `deepseek-flash`。
- `root({ agent })` 只在创建 conversation 时生效。用别的 `PI_MODEL` 重开，仍然沿用存下来的 model。
- extension 的代码从不被存储。conversation 跟随进程里装了哪些 extension，所以每个重开 session 的进程都要重新安装。这里没有测试"忘了安装"的情况。
- 同一时间只有一个进程拥有一个 storage，没有跨进程锁。服务多个 session 的应用必须把一个 session 路由到同一个进程，并自己决定 `Harness`
  保持打开多久。本 lab 是每次调用都打开再关闭。
- 坏 key 之类的 provider 错误不会重试：submission 以 `unanswered`、`reason: "model_error"` 结算。
- `WatchHandle.stop()` 不保证冲刷还没送达的事件，所以 trace 先等 submission 的终态事件，如果一直没来就写一行警告而不是挂起。
- provider/连接问题见 [Lab 01](../lab-01-pi-agent-loop/README.md)。过期的 `PI_MODEL` 会在启动时报 `Unknown model`，请用 `deepseek-flash`。

## 文件位置

```text
src/session-store.ts          session id -> 存储目录；created 还是 reopened
src/create-harness.ts         模型选择、extension registry、Harness.open() + root()
src/get-booking-tool.ts       用 defineTool() 定义的 tool
src/harness-trace-logger.ts   把 watchEvents() 渲染成 run/turn/tool 树
src/transcript.ts             一个 conversation 的全部 entry，从旧到新
src/booking-repository.ts, cli.ts
data/bookings.json            BK1001，有两个箱子
tests/durable-harness-session.test.ts   核心离线证明（关闭、重开、追问、隔离）
```
