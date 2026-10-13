# Lab 09 — Tool Replay Safety

[English](README.md) | 中文

**问题：** 进程在某次 tool 调用可能已经改动了外部状态之后死掉，Pi 可以再运行一次这个 tool 吗？
**本 lab 的答案：** 取决于 tool 作者声明的一个词，而 Pi 只信任它，不会校验。

- **`replay: "safe"`** —— 恢复时会再次运行 `execute()`。这次调用沿用原来的 task id 和 call id，最终提交一个真实结果。
- **`replay: "unsafe"`**（默认值）—— 恢复时不会进入 `execute()`，而是提交一条 `interrupted` 错误结果。

`"unsafe"` 能避免同一次调用被运行两遍，但不会告诉你第一遍到底有没有发生：`interrupted` 的意思是*结果未知*，不是*没有发生*。
可以类比：重发一个只读的报表请求，和重发一笔付款，完全不同——只有作者知道是哪一种，这个标签就是作者的承诺。

## 一个具体场景

一个运营助手可以查询集装箱动态，也可以给订舱单加 hold。10:02 用户问：*"给 `BK1001` 加一个 hold，原因是海关审查，并告诉我 hold id"*。

| 时刻 | 发生了什么 |
| --- | --- |
| 10:02:01 | 模型调用 `request_booking_hold`，hold 被写进 outbox（相当于"订舱系统"）。 |
| 10:02:01 | 服务器在 tool 返回之前被杀，用户没拿到 hold id。 |
| 10:02:30 | 服务器重启，恢复这次未完成的 run。 |

Pi 该怎么处理这次没完成的调用？

- **再运行一次** → 同一个请求产生第二个 hold。对查询无害，对 hold 就是错的。
- **不去动它** → 不会重复，但没人知道 hold 是否存在，所以助手必须如实说明，让人去确认。

Pi 无法判断哪个对，所以由 tool 作者来声明：

| 场景中 | 本 lab 中 |
| --- | --- |
| 查询集装箱动态 | `get_container_events`，`replay: "safe"` |
| 加 hold | `request_booking_hold`，`replay: "unsafe"`，副作用是 outbox 里的一行 |
| 订舱系统 | `runtime-evidence/outbox-*.jsonl` |
| "这个 tool 真正运行了几次？" | attempt 日志，`runtime-evidence/attempts-*.jsonl` |
| 作者的承诺 | tool 定义里的 `replay` 字段 |

谁需要理解这件事？**你，写 tool 的开发者。** 终端用户只会看到两种结果：一个真实的答案，或"结果未知，请确认"。

## 核心想法

一次调用开始时，Pi 会在 `execute()` 运行**之前**提交这次调用的 intent（一个 `pi.tool` task，包含 tool 的 `replay` 值）。被杀的进程会留下这条记录。恢复时：

```text
pi.tool task，intent 已提交，没有结果
  ├─ replay "safe"   → 再次运行 execute()：同一个 taskId、同一个 callId → 一条真实的 pi.tool-result
  └─ replay "unsafe" → 不进入 execute() → 一条 isError 的 "interrupted" pi.tool-result
```

三个要点：

1. **replay 是同一次调用，不是新调用。** 两次执行共享 `taskId` 和 `callId`。如果模型读到 `interrupted` 结果后再请求一次，那是带新 call id 的 *retry*，是另一回事。
2. **Pi 执行这个声明，但无法检查它是否属实。** 一个有副作用却被错误声明为 `"safe"` 的 tool 会被再次运行并重复副作用（有一个离线测试正是这样做的）。
3. **`replay` 不等于幂等。** 让重复的副作用无害（幂等键、条件写入）是 tool 自己的事。

不覆盖：真实通知或 API、provider/HTTP 重试、跨越 Pi 无法控制的系统的 exactly-once。本 lab 从不展示 exactly-once 执行。

## 实验

`npm run demo:replay` 对真实模型跑两个场景。每个场景里，父进程启动一个子 CLI，等待它 stdout 上一条具名的 `[Checkpoint]` 行（不靠 sleep），发送 `SIGKILL`，再启动新的子进程来恢复：

| 场景 | 在哪里被杀 | 为什么是这里 |
| --- | --- | --- |
| `safe`：`get_container_events` | `tool_dispatched` | 调用已持久化，什么都还没提交 |
| `unsafe`：`request_booking_hold` | `effect_appended` | outbox 那一行已经存在，但结果还没提交 |

之后它会检查 session、恢复，再对一个已结算的 session 再恢复一次。checkpoint 行带着 `taskId` 和 `callId`，所以被杀的那次调用可以和 `inspect()` 报告的 task、attempt 日志、outbox 记录对上。

## 测量结果

来自一次真实运行：

| tool | replay | 被杀调用的执行次数 | replay 次数 | 模型发起的新调用 | outbox 副作用 | 已提交结果 | 已提交结果是 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `get_container_events` | safe | 2 | 1 | 0 | 0 | 1 | 真实结果 |
| `request_booking_hold` | unsafe | 1 | 0 | 0 | 1 | 1 | interrupted（`isError`） |

- **Safe：** 同一行 `[Checkpoint] tool_dispatched … taskId=12 callId=…` 被打印了两次（每个进程一次），因为 `execute()` 确实运行了两遍。但只提交了一个结果，而且是真实的。
- **Unsafe：** 一次执行、一行 outbox，且 `taskId`、`callId` 相同。transcript 说这次调用"被中断，可能已部分执行"，outbox 里却有一个副作用；两者都为真。
- **`resume()` 之前的 `inspect()`** 就已经在未完成的 `pi.tool` task 上显示 `replay=safe` 或 `replay=unsafe`，以及它等待中的 `pi.generation`：generation 拥有这个 tool task，task 没结束它就不能结束。
- **两条恢复后的 trace 里都没有 `▶ tool_start`：** 对于上一个进程启动的调用，事件流不会再发。你要靠 `tool_end` 那一行区分策略（`↺ … recovery ran the call again` 对 `↺ interrupted …`）。
- **出现 `interrupted` 之后**，模型可能用新的 call id 再次请求这个 hold。那是 retry；Pi 不会拦，本 lab 也不拦。发生时，`模型发起的新调用` 这一列会体现出来。

离线测试（`tests/replay-recovery.test.ts`）不杀任何进程就复现了这次崩溃：在每个 tool 的 checkpoint 处复制 session 目录、attempt 日志和 outbox，再用一个新的 `Harness` 从副本恢复。它们也覆盖了错误声明的情形：hold tool 被声明为 `"safe"` 时会被重跑，同一次调用的 outbox 里有**两条**记录。

## 运行

```bash
cd lab-09-tool-replay-safety
npm install
cp .env.example .env     # 然后填入 DEEPSEEK_API_KEY
npm run check            # typecheck + 54 个离线测试，不调用模型
npm run demo:replay      # 上面的真实实验
```

手动试试：

```bash
npm run agent -- --session try --prompt "What are the movement events for container MSKU1234567?"
cat runtime-evidence/attempts.jsonl                  # 一行：真实执行了一次
grep -c 'pi.tool-result' session-data/try/main.jsonl # 1
npm run agent -- --session try --resume --settled    # 重新读取已结算的 submission，不会运行任何东西
```

`SAFE_TOOL_DELAY_MS` 和 `HOLD_TOOL_DELAY_MS`（默认 8000）决定每个 tool 启动后等待多久；demo 用的是 15000。不要手改 `session-data/` 或 `runtime-evidence/`（已 git-ignore，可重新生成）。

## 自测

运行 demo 之前，先写下 1–3 的答案；其余运行之后再答：

1. 被杀之后，声明 `"safe"` 的 tool 在恢复时会怎样？声明 `"unsafe"` 的呢？
2. 哪两个 id 说明一次 replay 是同一次逻辑调用，而不是两次？
3. 想数一个 tool 真正运行了几次，该去哪里看？为什么 Pi 自己的 session 不够？
4. `interrupted` 和一条 outbox 记录同时出现，两者矛盾吗？`interrupted` 承诺了什么？
5. 一个 hold tool 被错误声明为 `"safe"`。是谁犯的错？哪一层本该防止重复？
6. 模型用新的 call id 再次请求这个 hold。这算 replay 吗？哪一层必须拦住它？

（本 lab 没有记录学习者的预测。）

## 值得了解

- **版本：** `pi-durable`、`pi-ai`、`chord` 均为 `1.1.0`（`pi-durable` 是实验性的，所以这里的内容是先读它的类型和 `dist` 再实际观察得到的）。默认模型 `deepseek-flash`。
- 省略 `replay` 等于 `"unsafe"`。本 lab 在 hold tool 上显式声明它，让对比一眼可见。
- 只有当调用 intent 里存的策略**和**当前已安装的 tool 都是 `"safe"` 时，恢复才会重跑。后一个条件是从 `dist/harness/tool.js` 读到的，`tests/replay-recovery.test.ts` 两个方向都钉住了（崩溃时 safe、恢复时 unsafe，以及反过来）。
- `execute(args, api, context)` 没有 invocation id：一次逻辑调用就是 `api.taskId` 加 `api.callId`。`api.memo` 存在但这里没用到，因为 memo 无法让外部副作用变得幂等。
- `resume()` 没有返回值；对一个已结算的 session 再 resume，返回的是它已存储的记录，而不是报错。
- 不支持两个进程同时操作同一个 session id：`pi-durable` 不会跨进程给 storage 加锁。
- Provider/连接问题：见 [Lab 01](../lab-01-pi-agent-loop/README.md)。如果 demo 一直卡着没有出现 checkpoint，说明模型没有调用该 tool；重跑即可。

## 文件位置

```text
src/get-container-events-safe-tool.ts   replay: "safe"：只读、慢、记录每一次 attempt
src/request-booking-hold-tool.ts        replay: "unsafe"：先追加到 outbox，再等待
src/attempt-log.ts, outbox-repository.ts   次数和副作用，记录在 Pi 自己的 JSONL 之外
src/checkpoint.ts                       tool 打印、demo 等待的标记
src/create-harness.ts, session-store.ts, transcript.ts, cli.ts, harness-trace-logger.ts, booking-repository.ts, container-event-repository.ts
scripts/replay-safety-demo.ts           在每个 checkpoint 杀进程、恢复、重新读取
tests/replay-recovery.test.ts           离线证明（在 checkpoint 处做磁盘快照）
```
