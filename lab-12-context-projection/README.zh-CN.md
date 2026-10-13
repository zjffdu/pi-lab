# Lab 12 — Durable Entry 与 Model Context Projection

[English](README.md) | 中文

**问题：** 每一条 durable 的应用记录，都应该进入 model 的 context 吗？
**本 lab 的答案：** 不应该。有两层相互独立的保护：

- **写入时的决定。** 写一条 note 时，你决定它带不带 `model` 字段。带，下一次请求就会包含这条 note 的文本；不带，这条 note 只存在于磁盘上，model 永远看不到。
- **每次请求前的检查。** 这个决定以后可能出错（新增了绕过投影函数的写入口，或者投影函数本身有 bug），而 Pi 不会发现。所以有一个 hook 在每个请求发出前
  检查它的全部 message，发现禁止文本就记录下来。它只能发现问题，不能阻止请求。

可以类比成：给文件贴"可共享/不可共享"的标签，再加上出门前翻一遍包。

## 一个具体场景

你做了一个订单助手，替客户回答关于 booking `BK1001` 的问题。运营同事在工单系统里给这个 booking 留备注，所有备注都存进同一个 session：

| Note | 谁写的 | `text` —— 助手可以知道 | `internalOnly` —— 助手绝不能知道 |
| --- | --- | --- | --- |
| `CN-001`（shared） | 运营 A | "客户要求加急清关，列为服务优先。" | "授权折扣码 `DISC-AUTH-7734`，最高 12%，不能告诉客户。" |
| `CN-002`（internal） | 运营 B | "这条航线和承运人关系紧张，处理要谨慎。" | "升级联系人口令 `ESC-CONTACT-4471`。" |

助手应该知道客户要加急清关，这样回答才贴切。但如果折扣码和升级口令进了 model 的上下文，客户问一句*"能不能给我打个折？"*，就可能得到"12%"。

**不用本 lab 的做法**时，最省事的是把整条记录放进上下文。**用了之后：**

- `CN-002` 是 internal，写入时**不带 `model` 字段**：只存在磁盘上，助手看不到。
- `CN-001` 写入时的 `model` 只放"Case note CN-001 … 客户要求加急清关 …"。折扣码留在 `data` 里，从不进入上下文。
- 问助手*"你有没有权限给折扣？有没有内部升级联系人？"*，它回答：*"我没有这些信息。CN-001 只提到客户要求加急清关……"*——没有折扣码，没有 12%，没有口令。
- 下个月有同事加了个批量导入脚本，图省事把整条记录写进 `model`。Pi 不会拦。请求前的检查会扫描请求、发现 `DISC-AUTH-7734`、记一条违规，
  你因此发现并修掉这个脚本。
- 如果之后你决定 `CN-001` 其实不该让助手看到，追加一条带 `edits` 的 entry：助手立刻看不到它，而这条 note 仍留在磁盘上供审计。

谁需要理解这些？**你，开发者。** 运营只会在备注上看到一个"AI 可见 / 仅内部"的选项（如果你提供的话），客户则什么都看不到。这个 lab 教你把这个决定放在代码的哪里，
以及如何用一道检查为它兜底。

| 场景里的事 | lab 里的概念 |
| --- | --- |
| 运营的一条备注 | 一个 `app.case_note` entry |
| 助手可以知道的部分 | `text` → 写入 `model` |
| 助手不能知道的部分 | `internalOnly`，只存在 `data` 里 |
| 决定助手能知道什么 | `projectCaseNote`，在写入时 |
| 出门前翻一遍包 | `beforeRequest` 检查 |

## 核心思路

Session 里存的是 *entry*。在 Pi 1.1 里，一个 entry 有两份 payload：

| 字段 | 含义 |
| --- | --- |
| `data` | 完整记录，给你的应用用。model 永远不读它。 |
| `model` | 这个 entry 贡献给 model context 的 message。**没有 `model` 就是 durable-only。** |

本 lab 加入一种自定义 entry：`app.case_note`（一条内部工单备注），并用两种方式写入：

```text
note（data = 完整记录，包括 internalOnly 机密）
  ├─ "durable-only"  → entry 只有 data，没有 model              → model 什么都看不到
  └─ "projected"     → model = projectCaseNote(note)
        ├─ shared note   → 一条只含被批准文本的 user message
        └─ internal note → 没有 model                           → model 什么都看不到
```

要带走的三点：

1. **Projection 发生在写入时，并且被存下来。** `projectCaseNote` 是纯函数，从不读 `internalOnly`，所以机密不可能进入 `model`。
   Pi 里没有任何东西把 `model` 和 `data` 绑在一起——一个粗心的写入方完全可以把整条记录塞进 `model`。
2. **你可以观察 model 将要看到什么。** `conversation.context()` 返回在 context 里的 entry，以及每个 entry 贡献了什么。
   之后想撤回某个 projection，就追加一条带 `edits`（`omit`/`replace`）的 entry；原来的 entry 原封不动留在 storage 里。
3. **你可以检查 provider 实际收到了什么。** `beforeRequest` hook 能看到每个请求最终的 message。这里它是一道*检查*：
   只记录违规，不能拦截——因为 hook 里 throw，Pi 只会报告错误，请求照样发出（有测试固定住）。

不涉及：retrieval/记忆、把 system prompt 当作安全边界、真实机密（fixture 里所有"机密"都是合成 token）。

## 实验

每条 note 都有 `internalOnly` 字段，shared 和 internal 的 note **都有**——有意思的情形是：一条 `text` 被批准给 model 的 note，
同一条记录里的另一个字段却没有被批准。Fixture：[`data/case-notes.json`](data/case-notes.json)；`BK1001` 有两个 container。

`npm run demo:context-projection` 用真实 model 跑两个场景。两者写入同样的两条 `BK1001` note（`CN-001` shared、`CN-002` internal），
只有写入策略不同：

1. 让 model 有依据："Look up booking BK1001…"（一次真实的 tool call）。
2. 写入两条 note（不调用 model），然后**关闭并重新打开 storage**。
3. 从 durable 数据重建禁止列表（所有 `internalOnly` 值），再问一个只有泄露才答得出的问题：
   *"is there any discretionary discount or internal escalation contact you know of?"*

## 测量结果

来自一次真实运行（`stored` = entry 自己的 `model`，`contributed` = 它给下一个请求加了什么）：

| 场景 | CN-001（shared）stored/contributed | CN-002（internal）stored/contributed | 后续请求 | guard 违规 | 回答里有机密 |
| --- | --- | --- | --- | --- | --- |
| durable-only | 0 / 0 | 0 / 0 | 6 条 message | 0 | 否 |
| projected | 1 / 1 | 0 / 0 | 7 条 message | 0 | 否 |

- **两个请求之间唯一的区别是多了一条 `user` message**——`CN-001` 被批准的文本。两个场景在 durable 层面都持有两条 note。
- **即使在 projected 场景里，`CN-002` 也留在外面**，因为 `projectCaseNote` 拒绝了它，所以它是不带 `model` 写入的。
- **每个机密在磁盘上只出现一次**，在 `main.jsonl` 的 `data.internalOnly` 下；被批准的文本也只出现一次，在 `CN-001` 的 `model` 里。
- **重启不改变任何东西**：重新打开后证据完全一致，guard 的禁止列表是从 note 自己的 `internalOnly` 字段重建的，没有任何东西需要重新提供。
- 回答只在措辞上不同：projected 的回答会提到 `CN-001` 中不含机密的内容；两个回答都没有泄露机密。

离线测试补上了真实运行不适合安全演示的部分：一个把整条记录塞进 `model` 的写入方，会让 guard 恰好记录一个违规（请求照样发出）；
未装填的 guard 什么都不记录（所以 demo 会断言它被装填过）；一条 `edits` entry 能把 note 从 context 里拿掉，而它仍留在 storage 里。

## 运行

```bash
cd lab-12-context-projection
npm install
cp .env.example .env            # 然后填入 DEEPSEEK_API_KEY
npm run check                   # typecheck + 46 个离线测试，不调用 model
npm run demo:context-projection # 上面的真实实验
```

手动试试：

```bash
npm run agent -- --session try --add-note BK1001 shared "Customer wants a call back." --internal-only "TOKEN-A"
npm run agent -- --session try --add-note BK1001 shared "Same, durable-only." --internal-only "TOKEN-B" --durable-only
npm run agent -- --session try --inspect     # 每条 note 的 stored / contributes，以及下一个请求的规模
npm run agent -- --session try --prompt "Any discount you know of?"
grep -c 'TOKEN-A' session-data/try/*.jsonl   # 只有一行，在 data.internalOnly 下
```

读 trace：和 Lab 11 是同一种 run/turn 树（model 的 tool call 请求与 Pi 的执行分成两行，用 `call=` 配对）。note 打印成
`case_note CN-001 visibility=shared projects 1 model message`——从不打印它的文本或 `data`，因为 Pi 为它发出的事件里带着整条记录。
`[Request]` 行来自 guard，只显示数量和 role。不要手工编辑 `session-data/`。

## 自测

运行 demo 之前，先写下 1–3 题的答案；其余的运行之后再答：

1. 在每个场景里，哪些 note 是 durable 的？哪些会到达 provider？
2. 两个场景里后续请求各带多少条 message？多出来的那条是什么？
3. 每个 `internalOnly` 值在磁盘上的哪里、出现几次？
4. 是哪一个字段决定 model 能不能看到一条 note？由谁来设置？
5. 为什么 system prompt（"没被展示的东西要如实说不知道"）*不是*把机密挡在外面的东西？
6. guard 拦不住请求。真正的屏障需要什么？为什么本 lab 仍然保留 guard？

（本 lab 没有记录 learner 的预测。）

## 补充说明

- **版本：** `pi-durable`、`pi-ai`、`chord` 均为 `1.1.0`（`pi-durable` 是实验性的，所以先读它的类型再实际观察）。默认 model 是 `deepseek-flash`。
- 带 `model` 写入的 note 在事件流里表现为 `message_end`；不带的表现为 `entry_appended`。写一条 note 就是一次普通 commit：没有 run、没有 task、没有 submission。
- Compaction 是关闭的。`beforeRequest` 是 generation task 的 hook，所以按它的类型，它不覆盖 compaction 发出的请求——这里没有测试。
- model/provider 连接问题见 [Lab 01](../lab-01-pi-agent-loop/README.md)。如果 demo 在 `violations` 上失败，说明有禁止文本到达了 provider：
  先看 `projectCaseNote`，再看写这个 entry 的那段代码。如果 guard 报告 0 个违规，先看 `forbiddenCount`——禁止列表为空什么都不会记录。

## 文件位置

```text
src/case-note-entries.ts       entry 类型、projectCaseNote（纯函数）、appendCaseNote、revokeProjection
src/case-note-evidence.ts      逐 note 的 stored/contributed 数量；来自 durable 数据的禁止列表
src/provider-boundary.ts       beforeRequest 检查（只含数量和 role；违规按下标记录）
src/harness-trace-logger.ts    run/turn trace；note 打印时不带文本和 data
src/create-harness.ts, session-store.ts, transcript.ts, booking-repository.ts, get-booking-tool.ts, cli.ts
scripts/context-projection-demo.ts   真实实验
tests/context-projection.test.ts     核心离线证明（context 与收到的 transcript 一致）
```
