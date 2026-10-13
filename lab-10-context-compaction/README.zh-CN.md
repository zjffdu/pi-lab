# Lab 10 — Context Compaction

[English](README.md) | 中文

**问题：** 怎样让 model 读到更短的 context，而 session 仍然保存完整对话？
**本 lab 的答案：** compaction 改变的是*下一次请求*携带什么，从不改变*存储*里有什么。

- **存储是只追加的。** compaction 只加一条 `pi.compaction` entry，所有更早的 entry 原样保留，一个字节都不变。
- **请求被重建。** 旧的前缀被 model 写的 summary 取代，最新的几个 turn 保持原文。

好比一场长会议的纪要：完整录音留着，但下一个人拿到的是一页摘要，加上最后几分钟的原话。

## 一个具体场景

你做了一个订舱助手。计划员询问 `BK1001`（两个 container）和 `BK1002`，在第二个 turn 里助手报告 `BK1002` 有 customs hold——
*missing phytosanitary certificate*。随后又聊了六个 turn 的闲话。现在对话约 2,000 token，每提一个新问题都要把它全部重发一遍。

- **不压缩**，每个 turn 都要为整段历史付费，会话够长就会撞上 context 上限。
- **压缩一次**，model 拿到的是 summary 加最后三个 turn。问 *"哪个 booking 有异常备注？"*，它仍能答出
  *BK1002，missing phytosanitary certificate*——答案来自 summary。
- **但是** summary 是 model 自己的转述。有一次它写了 *"USLAX enforces phytosanitary requirements strictly"*：
  这是助手更早做出的猜测，没有任何 tool 返回过，现在却被当作事实陈述。

谁需要理解这件事？**你，开发者**：什么时候压缩、什么必须原样保留、哪些事实绝不能只靠 summary。计划员看到的只是一个更快更便宜的助手。

| 场景里的东西 | lab 里的对应 |
| --- | --- |
| 只在早期说过一次的 customs hold | `BK1002` 的 `customsHoldReason`，第 2 个 turn 由 `get_booking` 返回 |
| 一页纪要 | `pi.compaction` entry 的 `model`（一条 user message） |
| "最后几分钟的原话" | 该 entry 的 `head` 之后的 entries |
| 完整录音 | 所有更早的 entry，仍在 storage 里 |

## 核心思路

```text
entries:  U1 A1 T1 A1' | U2 … | … | U6 A6 | U7 A7 | U8 A8        （全部保存，永远）
                                   ^ head
下一次请求 = [ `head` 之前所有内容的 summary ] + U6 … A8
```

三个要点：

1. **compaction 是一个 task，不是一次调用。** `Conversation.compact()` 返回 task id；task 向 model 要一份 summary；
   然后一次 write submission 把 entry 放进去。`compactConversation()` 封装了这三步。
2. **切点就是 `head` 指向的位置。** 切点由 token 预算（`keepRecentTokens`）决定，可能落在一个 turn 中间。
   demo 根据真实 transcript 计算预算，让切点落在 turn 边界上。
3. **summary 可能失败，而且它不是检索。** 如果 token 用完（`reserveTokens` 太小），task 失败且什么都不写；
   即使成功，它也可能把助手自己的猜测当作事实带进去。

不涉及：崩溃恢复（Lab 08）、fork 与导航（Lab 11）、检索或长期记忆。

## 实验

`npm run demo:compaction` 对 live model 跑两个场景，各自是全新的 session，使用同样的八个 turn。第 3 个 turn 要求查
*`BK1001` 的每个 container* 的事件，所以一条 assistant message 同时请求两个。

1. seed 八个 turn，测量 context。
2. `compact()`——`default` 不带指令，`instructed` 带上"保留每个标识符和 hold"。
3. 提问：*"哪个 booking 有异常备注，内容是什么？"*

## 测量结果

来自一次 live 运行（token：逐条消息的估算 / provider 自己对该请求的计数）：

| 场景 | entries | 估算 前 → 后 | provider 前 → 后 | 是否找回 hold |
| --- | --- | --- | --- | --- |
| default | 26 → 27 | 1995 → 871 | 2468 → 1452 | 是 |
| instructed | 26 → 27 | 2099 → 1007 | 2527 → 1607 | 是 |

- **加了一条 entry，没改任何一条。** 之前的 26 条之后完全相同，`head` 是第 6 个 turn 的 user entry。
  `context({ at })` 能重建旧视图。
- **provider 节省得比估算少**（−36–41% 对 −52–56%），因为 system prompt 和 tool 定义没有被压缩，
  而且 summary 本身就要几百个 token。
- **默认 summary 已经保住了 hold**，四次 live 运行都是如此。本 lab *没有*展示自定义指令挽救默认会丢的事实；
  要看到那种情形，需要一条通用 summary 会当作噪声的事实。
- **标识符安全，说法不一定。** summary 里的每个 booking 号和 container 号都在 fixture 中（有断言）；
  有些说法来自助手自己更早的猜测。

离线测试补上 live 运行不便展示的部分：summary 被 token 上限截断会让 task 失败且什么都不写，预算覆盖整段 transcript 时什么都不压缩，
压缩后的 context 在重启后依然成立。

## 运行

```bash
cd lab-10-context-compaction
npm install
cp .env.example .env            # 然后填入 DEEPSEEK_API_KEY
npm run check                   # typecheck + 40 个离线测试，不调用 model
npm run demo:compaction         # 上面的 live 实验
```

自己动手试（一条命令 = 一个 turn、一次 compaction，或一次只读查看）：

```bash
npm run agent -- --session try --prompt "Look up booking BK1001 and list its containers."
npm run agent -- --session try --prompt "Which container is MSKU2345678 on?"
npm run agent -- --session try --compact --keep-turns 1 --custom-instructions "Keep every identifier and hold."
npm run agent -- --session try --inspect     # entries、head、context 大小、summary
grep -c MSKU2345678 session-data/try/main.jsonl   # 压缩之后仍在 storage 里
```

读懂 trace：`assistant (tool call) <name> call=<id> args=…` 是 model 请求的内容；其下的 `tool_start`/`tool_end` 是 Pi 在执行，
两者靠 `call=` 配对。一条 message 有两个请求就打印两行。不要手工编辑 `session-data/`。

## 自测

运行 demo 之前，先写下 1–3 的答案，其余的之后再答：

1. 压缩之后，哪些 entry 仍在 storage 里，下一次请求携带哪些？
2. customs hold 在压缩之后物理上存放在哪里？
3. 默认 summary 会保住它吗？什么情况会让你怀疑？
4. 为什么 provider 的节省比估算的小？
5. trace 里哪几行是 model *请求*某个 container，哪几行是 Pi *执行*它？
6. 为什么 summary 不能代替重新查一次事实？

（本 lab 没有记录学习者的预测。）

## 值得知道

- **版本：** `pi-durable`、`pi-ai`、`chord` 均为 `1.1.0`；`pi-durable` 是 experimental，所以这里依据的是它的类型声明，再经过实际观察。默认 model 是 `deepseek-flash`。
- **预算：** `reserveTokens` 同时是 summary 的输出预算（80%）。取 `300` 和 `1000` 时 live summary 触到上限而失败；lab 默认 `2000`。自动 compaction 已关闭。
- **意外，有测试固定：** 压缩之后，请求里 system message 出现在最新 user 输入*之后*，尽管 pi-durable 的 changelog 说 baseline 现在排在最前。原因没有调查。
- 切在 turn 中间会留下一条没有问题的 assistant 回答；不会为它另写 summary。
- provider 问题见 [Lab 01](../lab-01-pi-agent-loop/README.md)。如果 demo 因 token 上限失败，调大 `COMPACT_RESERVE_TOKENS`；如果什么都没压缩，调低 `COMPACT_KEEP_RECENT_TOKENS` 或传 `--keep-turns`。

## 文件位置

```text
src/compaction.ts              compactConversation、keepRecentTokensForLastTurns、token 估算
src/create-harness.ts          registry、prompt、model 选择、compaction policy
src/harness-trace-logger.ts    run/turn 树；请求行与执行行；compaction 事件
src/booking-repository.ts、container-event-repository.ts、get-*-tool.ts、session-store.ts、transcript.ts、cli.ts
scripts/compaction-demo.ts     live 实验
tests/compaction.test.ts       核心离线证明（脚本化 model，真实 storage）
```
