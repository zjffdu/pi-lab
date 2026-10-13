# Lab 11 — Session Tree 与导航

[English](README.md) | 中文

**问题：** 当你回到对话中更早的一点、改变一个前提时，你离开的那段对话会怎样？
**本 lab 展示的答案：** 什么都不会发生。往回走就是一次 `fork`，而 fork 是**同一个 storage 里的第二个 conversation**：

- **fork 共享到分叉点为止的历史。** 它能看到 parent 直到并包含那条 entry 的所有 entry，看不到 parent 之后追加的任何东西。
- **每个 conversation 就是一个有自己 tip 的 branch。** 两个都保持打开、都接受 prompt、都能在重启后存活，并且谁也看不到对方之后的 turn。

可以把它想成在文档的某一段复制一份再改副本：原件不动，副本从头到那一段都和原件一样。

## 一个具体场景

一个运营 agent 正在查 booking `BK1001`（船 `MAERSK TEST`，两个 container）。问到第三个问题时，客户说：*"抱歉，我说的是 `BK1002`。"*

- **没有这种做法时**，你要么在同一份 transcript 里继续——model 现在同时有 BK1001 和 BK1002 的船和 container，可能会混在一起——要么把 BK1001 的调查扔掉。
- **有了它**，你就在第一个 BK1001 答案之后 fork。新 conversation 有 BK1001 的查询（共享）和接下来 BK1002 的查询（自己的）。旧 conversation 仍然有查 container 事件和风险判断的那些 turn。
  向两边问同一句*"我们在讨论哪艘船？"*：一个答 `MAERSK TEST`，另一个答 `MAERSK SECOND`。
- 明天进程重启。两个 conversation 都还在，按 id 找到，fork 继续往下走。

谁需要理解这个？**你，开发者。** 用户只会注意到"从那里重新来"不会丢掉之前的工作。

| 场景里的东西 | lab 里的对应 |
| --- | --- |
| BK1001 的调查 | root conversation |
| "回到第一个答案之后" | 在那条 entry 处 `fork(entryId)` |
| "我说的是 BK1002" | fork 自己的第一个 turn |
| 第一个答案上的书签 | label（应用层，见下） |
| 两个不能混在一起的案子 | 两个 conversation，各自只发送自己的祖先链 |

## 核心思路

```text
  conversation A:  … ── entry [带标签] ── entry … ── entry …   (tip)
                              │
  conversation B:             └── entry … ── entry …           (tip)
```

| 概念 | 是什么 |
| --- | --- |
| conversation | 一份由 entry 组成的 transcript；这里就是一个 branch |
| `fork(entryId)` | 新建一个 conversation，继承直到 `entryId` 的 entry；它的 `ConversationRecord.parent` 是 `{ conversationId, at }` |
| tip | conversation 能看到的最新 entry——**不是**存下来的指针，每个 conversation 一个 |
| `head` | reset 或 compaction 之后 model *context* 的起点——**不是** branch 标记 |

三个要点：

1. **一个 branch 就是一个 conversation。** "切换 branch"就是选另一个 conversation id；没有可以移动的 tip。
2. **继承来的 entry 只存一份。** fork 的 `entries()` 先列出它们，仍带着 parent 的 `conversationId`；它自己的 entry 带它自己的。靠这一个字段就能画出这棵树。
3. **隔离可以不靠 model 来证明。** 脚本化的 model 可以记录每个 branch 下一次请求实际携带的 messages。

label 是应用层状态：一个把 entry id 映射到名字的小 document（[`src/labels.ts`](src/labels.ts)）。它从不进入 transcript，所以 model 永远看不到。
不涉及：合并 branch、给被放弃的 branch 做摘要，以及 compaction（这里是关掉的）。

## 实验

`npm run demo:session-tree` 跑一个 live session：

1. 问 `BK1001`，给那个答案打标签，再让它查两个 container 的事件并做一次风险判断（root）。
2. 预览在带标签的 entry 处 fork 会以什么开始（不创建任何东西）。
3. 在那里 fork，改问 `BK1002`（fork）。
4. 向两个 conversation 问完全相同的问题：哪艘船、哪些 container。
5. 关闭进程，重新打开 storage，在 fork 里继续工作。

## 测量结果

来自一次 live 运行：

| 检查项 | 结果 |
| --- | --- |
| fork 之后的 conversation / tip 数 | 2 / 2（`c1:30`、`c31:44`） |
| fork 继承的 entry | 5 条（entry 7、10、11、13、15），都带 root 的 `conversationId` |
| fork 之后以及 fork 继续之后的 root entry | 逐字节不变 |
| root 的答案 | `MAERSK TEST`、`MSKU1234567`、`MSKU2345678`；没有 BK1002 的事实 |
| fork 的答案 | `MAERSK SECOND`、`MSKU7654321`；没有 BK1001 的事实 |
| 重启之后 | 两个 conversation 都找到，fork 的 `parent` 完好，fork 回答 `SGSIN` |

- 离线测试检查的是同样的隔离，但检查的是每次请求**携带**了什么，而不是 model 说了什么。
- entry id 在 branch 之间交错（root 是 17–30，然后 45–48，夹着 fork 的 37–44），所以 id 不能说明一条 entry 在哪个 branch；`conversationId` 才能。
- 在 `main.jsonl` 里，一个 fork 是一条记录：`{"type":"conversation","value":{"id":31,"parent":{"conversationId":1,"at":15}}}`。entry 没有 `parentId`，继承来的也没有被复制。

## 运行

```bash
cd lab-11-session-tree
npm install
cp .env.example .env            # 然后填写 DEEPSEEK_API_KEY
npm run check                   # 类型检查 + 48 个离线测试，不调用 model
npm run demo:session-tree       # 上面的 live 实验
```

手工试试（第一条命令会调用 model；entry id 来自 `--inspect`，在一次记录下来的运行里是 15）：

```bash
npm run agent -- --session try --prompt "Look up booking BK1001 and tell me its route, vessel, and containers."
npm run agent -- --session try --inspect                 # 整棵树：conversation、entry、tip
npm run agent -- --session try --preview 15              # 在 entry 15 处 fork 会以什么开始
npm run agent -- --session try --fork 15                 # 打印：[Fork] conversation N forked from conversation 1 at entry 15
npm run agent -- --session try --label 15 "after-lookup" # 一个 label，在树里显示为 [label="after-lookup"]
npm run agent -- --session try --prompt "Which vessel is this?" --conversation N
npm run agent -- --session try --fork 999999             # [Fatal] Entry 999999 is not visible from conversation 1
```

读 trace：和前面几个 lab 一样的 run/turn 树。每个 conversation 有自己的 logger，它的行带有 `[c1]`、`[c31]` 标签。创建 fork 不会发出事件，
所以 CLI 和 demo 自己打印 `[Fork]` 那一行。不要手工编辑 `session-data/`。

## 自测

运行 demo 之前先写下 1–4 的答案，其余的之后再答：

1. 在带标签的 entry 处 fork 并继续之后，有几个 conversation 和几个 tip？
2. fork 在追加任何东西之前包含哪些 entry，哪个字段说明它们是继承来的？
3. fork 继续时，root 里有什么变化吗？之后 root 继续时呢？
4. 对于"我们正在讨论的 booking"，每个 conversation 说出哪艘船、哪些 container？
5. 为什么两边的 id 是交错的，真正画出这棵树的是什么？
6. 为什么离线测试能比 live 答案更有力地证明隔离？

（本 lab 没有记录任何 learner 的预测。）

## 值得知道的

- **版本固定：** `pi-durable`、`pi-ai`、`chord` 都是 `1.1.0`（`pi-durable` 是实验性的，所以这里先读了它的类型，再做了观察）。默认 model 是 `deepseek-flash`。
- `fork(at)` 接受 turn 的结尾、一条 tool result、以及 parent 最新的 entry。它也接受*请求了* tool call 的那条 assistant entry；此时 fork 继承一个没有结果的调用，
  它的 context 会补上一个合成的 `toolResult`。它拒绝未知 id 或别的 conversation 的 entry：`Entry N is not visible from conversation M`。
  以上都由测试固定。parent 在运行中途处于忙碌时 fork 的行为没有确认。
- `scanConversations` 在 `Storage` 上，不在 `Harness` 上；重启之后 tool 能工作，只是因为 `openHarness` 重新安装了 registry——conversation 存的是 extension 名字，不是代码。
- provider/连接问题：见 [Lab 01](../lab-01-pi-agent-loop/README.md)。如果 live 的隔离断言失败，先读离线的请求捕获测试：它展示了每个 branch 实际被发送了什么。

## 文件在哪

```text
src/branches.ts          forkAt、listConversationRecords、loadBranches
src/tree-view.ts         纯函数：自有/继承的 entry、tip、describeFork、renderTree
src/labels.ts            应用层状态的 label（一个 Session 作用域的 document）
src/transcript.ts        listEntries（感知 fork、分页）、summarizeEntry
src/harness-trace-logger.ts   每个 conversation 一棵带 tag 的 run/turn/tool 树
src/create-harness.ts, session-store.ts, booking-repository.ts, get-*-tool.ts, cli.ts
scripts/session-tree-demo.ts  live 实验
tests/navigation-mechanics.test.ts   核心离线证明（继承、隔离、重启、label）
```
