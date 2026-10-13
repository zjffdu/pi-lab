# Lab 15 — Integrated Runtime Contract

[English](README.md) | 中文

**问题：** 当 governance、audit、telemetry、egress 检查和 durable session 在同一个 runtime 里同时运行时，每一个的保证还成立吗？
**这个 lab 给出的答案：** 只有在有东西把它*重新装上*的地方才成立。session 存了一些东西，没存另一些：

- **存在 session 里：** 对话历史、提供给模型的 tool 集合、note 的 projection。
- **不存：** hook、tool 代码、egress 配置、tool 背后的业务数据。

所以第二类里的每个保证，都只和那一个负责装配的函数（*composition root*）一样可靠；第一类里的每个保证，则可能和你的应用*今天*想要的不一致。

像搬家：家具（历史）会跟你走，但报警器和门锁（hook）得重新装；搬运车上可能还带着旧的钥匙架（存下来的 tool 集合）。

## 一个具体场景

你运营一个订舱操作助手。`BK1001` 有两个 container。运营人员让它修改 booking 状态；policy 禁止取消；每个决定都要 audit；
并且 case note 里的折扣码绝不能泄漏。

1. **周一。** 员工说“cancel BK1001”。模型调用 `update_booking_status`。policy 拒绝，一条 audit 记录写着 `blocked`，什么都没变，
   模型告诉员工原因。trace 里是 `⊘ tool_refused … code=blocked`。
2. **周一晚些时候。** “把 BK1001 设成 in_transit。”记录一个 effect——针对的是**整个 booking**，所以覆盖两个 container。
3. **周二。** 服务重启，重新打开 session。历史回来了。但 hook 和 tool 代码在进程里，不在 session 里，必须在第一个请求之前重新装上。
4. **周三。** 一次发布不再提供写 tool。session 仍然*存着*旧的 tool 集合，除非应用去替换，否则 Pi 会保留它。
   如果模型仍然请求已下架的 tool，这个调用会在任何 hook 运行之前被拒绝。
5. **周四。** 写 note 的某处 bug 把折扣码复制进了模型的 context。所有环节都报告成功——除非配置了 egress 检查。

**谁需要理解这些？你，开发者。** 员工看不到这些；审阅者看 audit 和 result。

| 场景里的事 | lab 里的对应 |
| --- | --- |
| “谁对哪个请求做了什么决定” | audit 记录，用 request / session / conversation / task / call 的 id 关联 |
| “到底有没有真的改东西” | effect ledger——和 answer、tool outcome 分开 |
| “重启后重新装上” | `openIntegratedRuntime()`（`src/composition.ts`），即 composition root |
| “旧的 tool 集合还存着” | `ToolSetReconciliation`，通过 `configure({ tools })` |
| “出门前翻一下包” | `src/egress.ts` 里的三层 egress |

## 核心想法

一个请求返回四个事实，有意分开（`src/run-result.ts`）：

| 事实 | 来源 |
| --- | --- |
| **operation** —— completed / failed / rejected | submission 的 settle 记录（`done` / `unanswered`），或提交前就被拒绝 |
| **answer** | Pi 记为答案的那个 entry——绝不是更早的开场白 |
| **tool outcomes** —— ok / error / blocked / unavailable / invalid_arguments | Pi 存在每个 tool result 上的 `code` |
| **business effects** | 只有变更真正发生时才写入的 ledger |

`mechanism`（机制是否完整运转？）与行为（结果是否是我们想要的？）分开判断。安装三个 extension：`booking`（prompt）、
`booking-governance`（**两个 tool 以及守卫它们的 hook**）、`egress-backstop`。

三个要点：

1. **把 tool 和它的守卫放进同一个 extension。** conversation 存的是 extension 的*名字*。重开时少了 governance extension，
   就完全没有 booking tool——调用被以 `tool_unavailable` 拒绝。与守卫分开安装的 tool 会无治理、无 audit 地运行（有测试固定这个对照）。
2. **默认拒绝。** governance hook 看得到每一个 tool，包括之后在另一个 extension 里新增的；没有 policy 条目的 tool 会被 block 并 audit。
3. **没有任何 hook 能阻止 provider 请求**，所以 egress 是三层：写入时拒绝有泄漏的 projection；提交前扫描已提交的 context（0 个请求）；
   以及一个 `beforeRequest` backstop，它只能*withhold* 该值——请求仍会发出。

不涉及：用户是谁、能碰什么（Lab 16–17）、审批（18）、真实的外部服务。

## 实验

`npm run demo:integrated` 是脚本化的（无网络、无 live model：一个假 provider 返回预设答案）。它在真实的 `Harness` 和真实的 JSONL session
上跑五个场景，并为每个请求打印 trace、result、audit、provider 收到的内容和 span。每一行 trace 都带有 request id 前缀。

| 场景 | Provider 请求数 | 发生了什么 |
| --- | --- | --- |
| 1. 允许的写入 `BK1001` | 3 | 一个覆盖两个 container 的 effect；audit `allowed` + `executed`；mechanism ok |
| 2. cancel `BK1001` | 2 | 无 effect；audit `blocked`；trace `⊘ tool_refused code=blocked`；span 写 `refused` |
| 3. 重开，应用现在只提供只读 | 2 | 存的是两个 tool → 对账成一个；写调用是 `unavailable`，没有 audit 行 |
| 4a. 有泄漏的 note，没有 egress 配置 | 1 | 秘密**到达了 provider**；一切仍显示成功 |
| 4b. 同上，preflight + backstop | **0** | 请求在提交前被拒绝 |
| 4c. 同上，只有 backstop | 1 | provider 拿到的是 withheld 标记；`mechanism` **失败**（上游某层漏过了） |
| 5. 复用的 request id | 总共 1 | 第二个 prompt **没有运行**；结果标记为 `deduplicated` |

- **audit 说明原因，span 和 trace 只说“被拒绝”。** 被 block 的调用和 policy *异常* 都以 `blocked` 结束；只有 audit（有决定 vs. 没有）能区分，
  而异常会让 `mechanism` 失败。
- **失败的 run 不等于没有 effect。** 测试里，写入之后 provider 报错，是 `failed`、没有 answer、有一个 effect。
- **Pi 把 request id 当作幂等键**，而且是 durable 的：即使重启，复用的 id 也会返回原来的答案。

`npm run evidence` 把每条 roadmap criterion 绑定到固定它的测试上（测试被改名会让它变成 `unmapped` 并使运行失败），并写入
`runtime-evidence/{manifest,experiments,acceptance}.json`：

| | Criterion | 状态 |
| --- | --- | --- |
| AC1 | 一个请求可沿 runtime、policy、tool、audit、outcome 追踪 | verified |
| AC2 | 被 block 的调用不产生 business effect | verified |
| AC3 | provider 失败得到 failed run，而不是 success 或开场白 | verified |
| AC4 | reopen 后在任何 tool 运行前重装 governance | **partial** |
| AC5 | 含禁止字段的 payload 导致 0 个 provider 请求 | **partial** |
| AC6 | 去掉必需的 governance 组件会让 contract test 失败 | verified |
| AC7 | 缺失的 SDK correlation 字段已映射；各 id 不可互换 | verified |

- **AC4 是 partial：** 崩溃发生在 run 中途、随后 resume 的情形没有演练；在 composition root 之外组装、自带无治理 tool 的 registry 得不到保护。
- **AC5 是 partial：** “0 个请求”只对提交时已提交的内容加 prompt 成立。run *过程中*才出现的内容——tool result，或 system prompt 和 tool 声明——
  只能被 withhold，无法被预防。

## 运行

```bash
cd lab-15-integrated-runtime
npm ci
npm run check                # typecheck + 90 个离线测试，不调用模型
npm run demo:integrated      # 上面的脚本化演练
npm run evidence             # acceptance + manifest；任何失败都会 exit 1
../scripts/verify-labs.sh    # 在仓库根目录：运行每个 lab 自己的 check
```

动手试：

```bash
npm run demo:integrated | grep tool_refused        # 两个被拒绝的调用：code=blocked 和 code=tool_unavailable
npm run demo:integrated | grep "provider saw"      # 场景 4：true、false、false
npx vitest run -t "blocks a tool that has no policy entry"
npx vitest run tests/egress.test.ts                # 16 个测试
cat runtime-evidence/acceptance.json               # 先运行 `npm run evidence`
```

## 自测

运行 demo 之前先回答 1–3：

1. 一次被 policy 拦下的写入：有几条 audit、几个 business effect，哪一行 trace 标记了它？
2. 重启之后，应用必须重新装什么？session 自己会还回什么？
3. session 存的是两个 tool；这次发布只提供读 tool。provider 的下一个请求声明了什么？如果模型仍然调用写 tool 会怎样？
4. 为什么 governance extension *之外*的 tool 也会被 block？audit 里写的原因是什么？
5. 为什么 backstop 不能做到“0 个请求”？它转而做了什么？
6. 同一个 request id 配上不同的 prompt 再次提交。哪个 prompt 会运行？结果怎么告诉你？

## 值得知道

- **版本固定：** `pi-durable`、`chord`、`pi-ai`、`pi-telemetry` `1.1.0`。`pi-durable` 是实验性的。没有 live-model 入口；默认模型 id 只在测试里对照 catalog 检查。
- **状态：** learner 的预测已豁免，worksheet 的迁移题（T1–T3）尚未作答。没有做 live-model 运行，也没有独立评审；源码基线未提交，所以 manifest 记录为 `dirty`。
- **脚本化，不是 live：** 事件顺序、token 数和失败形态都来自假 provider。只试了 `model_error` 这一种失败；限流和超时没试。
- **guard 的局限：** 只匹配原样文本，不匹配改写；请求到 entry 的 join 假定每个 conversation 同时只有一个请求在途。hook 无法从 Pi 读到自己属于哪个请求，所以由应用绑定。
- **未纳入：** session fork（Lab 11）和 Lab 14 的 evaluation case 不在这个 composition 里。
- worksheet 的答案在 `REFERENCE.md`——请先尝试 T1–T3。

## 文件位置

```text
src/composition.ts           composition root：request()、appendCaseNote()、close()
src/create-harness.ts        registry（三个 extension）、openHarness、tool 集合对账
src/governance-hooks.ts      两个 tool + beforeTool/afterTool；默认拒绝的 policy 表
src/run-result.ts            四个事实、verifyMechanism、evaluateBehavior
src/correlation.ts, audit-log.ts, effect-ledger.ts   每个 id 由谁提供；audit 行；effect
src/egress.ts                写入时检查、preflight、withhold 的 backstop
src/harness-trace-logger.ts  run/turn 树：request-id 标签、⊘ tool_refused、code
src/harness-telemetry.ts     事件流 → lab.* span（来自 Lab 14）
scripts/integrated-demo.ts, evidence.ts, acceptance-map.ts
tests/                       11 个文件；scripted-runtime.ts 在假 provider 之上构建真实的 harness
```
