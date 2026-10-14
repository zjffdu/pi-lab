# Lab 08 — Crash Recovery

[English](README.md) | 中文

**问题：** 进程在 tool 调用进行到一半时被杀掉，session 被重新打开后，Pi 会怎么做？
**本 lab 的答案：** 已提交的东西不会丢，缺失的结果不会被猜出来，默认也不会把 tool 再跑一遍。有两件事共同保证了这一点：

- **磁盘上已经有什么。** 用户的消息、模型的 tool 调用请求、以及"要运行这个 tool"的 *intent*，都在 tool 函数体开始之前就已提交。重启后能看到
  这一切，并且能在任何东西运行*之前*，就看到哪些工作没做完。
- **恢复怎么处理缺失的结果。** tool 的结果从来没有产生过，所以恢复把这件事如实记下来：一个失败的 tool task，加一条写着调用
  "was interrupted and may have partially run" 的错误结果。模型再从这个事实继续往下说。

想想餐厅的点菜单：菜单在厨房开火之前就已经写好。厨房做到一半着火了，菜单还在，服务员会告诉客人"那道菜没做出来"，而不是端上一盘编出来的菜。

## 一个具体场景

你做了一个货运助手。客户问：*"集装箱 MSKU1234567 的流转事件有哪些？"* 查这个的 tool 很慢，查询过程中服务器正好重新部署：

| 时刻 | 发生了什么 |
| --- | --- |
| 10:00:00 | 问题被提交。模型请求调用 `get_container_events`；这个请求也被提交。 |
| 10:00:01 | tool task 以 pending 状态被提交，然后 tool 开始运行。**进程被杀。** |
| 10:05:00 | 新进程打开同一个 session。在运行任何东西之前，它能列出留下了什么：一个没完成的问题、一个 pending 的 tool task、一个在等待的模型请求。 |
| 10:05:01 | 它继续。tool **没有**再跑一遍。一条错误结果被提交，模型被再问一次，然后告诉客户这次查询没有完成。 |
| 10:06:00 | 有人再来问系统这个问题。它返回已存储的答案，什么都不再运行。 |

**没有这套机制**，客户的问题会丢，或者服务器编一个答案，或者悄悄把一次可能带副作用的查询再跑一遍。**有了它**，结果是明确的，审计轨迹也是完整的。

谁需要理解这个？**你，开发者**：重启之后给客户看什么、哪些 tool 允许被重跑（那是 Lab 09），都由你决定。客户只会看到"这次查询没有完成"。

| 场景里的东西 | lab 里对应的东西 |
| --- | --- |
| 客户的问题 | 一个 `submission`，被杀之后状态是 `placed`（已受理、未完成） |
| 点菜单 | `phase=execute` 的 `pi.tool` task |
| 列出留下了什么 | `harness.inspect()` |
| "继续" | `harness.resume()` + `harness.submission(id).wait()` |
| 已存储的答案 | 对一个已 settle 的 submission 调用 wait |

## 核心思路

```text
submit -> user entry、submission(placed)
  模型请求一个 tool -> assistant entry（tool call）
    pi.tool task 已提交（intent）-> tool 函数体开始         <- 在这里被杀
重新打开 -> inspect(): [pi.tool pending] [pi.generation waiting] [submission placed]   （什么都还没运行）
resume -> tool 不重跑 -> 错误结果 entry -> 模型给出回答 -> submission done
```

1. **durable 比你想的更早。** 被杀的那一刻，除了 tool 的结果，其余全都已提交。
2. **`inspect()` 是只读的。** 刚打开的 harness 是 `scheduling=paused`；`resume()`、`submit()`、`wait()` 会把调度打开。所以你可以先看崩溃现场。
3. **恢复的终点是一个已 settle 的 submission，而不是一个返回值。** `resume()` 什么都不返回。你等的是 submission，而对一个已 settle 的 submission 等待，只会返回它已存储的记录。

不覆盖：选择 replay 策略（Lab 09）、compaction、fork、随机的杀进程时机、provider 切换。

## 实验

`npm run demo:crash` 用三个子进程跑一个 live 场景。父进程从不靠 sleep 猜时机：它读子进程的 stdout，一看到 `[Checkpoint] tool_dispatched`
（slow tool 开始运行时打印的一行）就立刻发 `SIGKILL`。

1. 子进程 1 提出问题，在 checkpoint 处被杀。
2. 子进程 2 重新打开 session，打印 `inspect()` 找到的东西，然后 resume 并等待 submission。
3. 子进程 3 再次打开它，等待同一个（已 settle 的）submission。

## 测量结果

来自一次 live 运行：

| | entry 数 | 未完成 task | 未 settle 的 submission | tool 执行次数 | 最终回答 |
| --- | --- | --- | --- | --- | --- |
| 被杀之后（子进程 2，resume 之前） | 4 | 2（`pi.tool` pending，`pi.generation` waiting） | 1（`placed`） | 1，由被杀的进程执行 | 无 |
| resume 之后（子进程 2） | 6 | 0 | 0 | 1（没有重跑） | "The lookup for container MSKU1234567 did not complete…" |
| 再问一次之后（子进程 3） | 6（最新 entry 不变） | 0 | 0 | 1 | 同一条已存储的记录 |

- **恢复新增了两条 entry**：错误的 `pi.tool-result` 和新的回答。`pi.user` entry 恰好一条，所以恢复从未把问题再问一遍。
- **`[Checkpoint]` 行带着 tool 的 `taskId`**，而 `inspect()` 报告的未完成 task 正是同一个：被杀的调用和被恢复的调用是同一次调用。
- **task 记录以 `failed` 结束**，消息是 "…was interrupted and may have partially run"；`grep -c "was interrupted" session-data/<id>/main.jsonl` 能找到它。
- **最新 entry 变了，能标识这项工作的 id 没变**：user entry、submission 和各 task 的 id 都保持不变。
- 离线测试不杀任何进程，通过在 checkpoint 处拷贝 session 目录，复现了同样的崩溃。

把你记录的预测对照这次运行：

| 预测 | 实际发生了什么 |
| --- | --- |
| "user message is already durable" | 对，而且更多：tool 调用请求和 tool task 的 intent 也都是 durable 的。只缺结果。 |
| "recover the state" | `resume()` 打开调度；缺失的结果被记为失败，而不是被重建。 |
| "tip ID stay stable" | 最新 entry 变了；user entry、submission 和 task 的 id 没变。 |
| "replay the cached result" | 对已 settle 的 submission：是的，返回它已存储的记录。`resume()` 本身什么都不返回。 |

## 运行

```bash
cd lab-08-crash-recovery
npm install
cp .env.example .env     # 然后填入 DEEPSEEK_API_KEY
npm run check            # 类型检查 + 35 个离线测试，不调用模型
npm run demo:crash       # 上面的 live 实验
```

手动试试（demo 之后，使用 `--session try`）：

```bash
npm run demo:crash -- --session try
npm run agent -- --session try --resume --settled        # unfinishedTasks=0、已存储的记录、entry 不变
grep -c "was interrupted and may have partially run" session-data/try/main.jsonl   # 1
```

不要手动编辑 `session-data/`。

## 自测

运行 demo 之前先回答 1–3：

1. 被杀的那一刻，什么已经提交，什么没有？
2. 在新进程里 `resume()` 之前，`inspect()` 会列出什么？为什么它不用运行任何东西就能列出来？
3. tool 会再跑一遍吗？模型会被告知什么？
4. 为什么第三次再问什么都不会改变？
5. `[Checkpoint]` 行由 tool 打印、由父进程监听。它会往 storage 写任何东西吗？

## 需要知道

- 版本固定：`pi-durable`、`pi-ai`、`chord` 均为 `1.1.0`；默认模型 `deepseek-flash`。`pi-durable` 是实验性的。
- checkpoint 行只是两个进程之间的信号。恢复读的是 task 自己保存的状态。
- 出现 `interrupted` 结果之后，模型可能会再请求一次查询。那是一次*新*调用，不是 replay；demo 只断言被杀的那次调用不会跑两次。
- 同一时刻一个 session 只能有一个进程：`pi-durable` 不会给 storage 加锁。Provider 问题见 [Lab 01](../lab-01-pi-agent-loop/README.md)。

## 文件位置

```text
src/slow-container-events-tool.ts   慢速 tool；打印带 taskId 和 callId 的 checkpoint
src/cli.ts                          --prompt，或 --resume [--settled]
src/create-harness.ts               registry、Harness.open()、inspect()
src/harness-trace-logger.ts         run/turn 树；重启前就开始的 span 用 ↺ 标出
scripts/crash-recovery-demo.ts      父进程：启动、等 checkpoint、SIGKILL、resume、再读取
tests/crash-recovery.test.ts        同样的崩溃，离线、基于磁盘快照
```
