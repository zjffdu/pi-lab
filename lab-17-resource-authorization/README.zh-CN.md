# Lab 17 — Resource Authorization 与 Delegated Access

[English](README.md) | 中文

**问题：** 这个已登录的员工，*现在*能不能对这个 booking 执行这个 action？
**本 lab 的答案：** 每次调用都要重新判断，而且在两个不同的地方判断：

- **model 被 offer 什么。** 每次 run 之前，根据用户*今天*的 roles 重新计算 offer 给 model 的 tool。
  用户无权使用的 tool，根本不会被 offer。
- **一次调用能做什么。** 即使 tool 被 offer 了，每次调用仍要对照用户当前的 role、booking 的 owner 和当前 status，
  并且在任何事情发生*之前*先写进 audit log。

可以把它想成：大楼门口的刷卡机（决定你能看到哪些门）加上每个房间的保安（决定*这个*房间今天是不是你的）。

## 一个具体场景

Alice 是 tenant A 的 operator，拥有 booking `BK1001`（两个 container）。同事 Bob 拥有 `BK2001`。

| 时间 | 发生了什么 |
| --- | --- |
| 周一 | Alice 让 assistant 把 `BK1001` 置为 on hold，成功。session 保存了这段对话。 |
| 周二上午 | 管理员撤销了 Alice 的 `operator` role，她只剩 `viewer`。 |
| 周二下午 | Alice 重新打开周一的 session，说"取消它"。历史里能看到 model 昨天用过写 tool。 |

**如果没有本 lab 的做法**，session 会记住"写 tool 是可用的"，重新打开时悄悄把它恢复：Alice 保留了一个她已经没有的权限。
被崩溃打断后再 resume 的 run，也有同样的陷阱。

**用了本 lab 的做法：**

- run 之前，根据今天的 roles 重新计算 offer，并覆盖 session 存下来的那份。model 只被 offer `get_booking`。
- model 仍然会请求 `update_booking_status`，因为昨天的对话还在它的 history 里。系统回答"该 tool 不可用"，
  booking 系统什么都收不到。
- 如果这个 tool *被误 offer 了*，第二道检查仍会拒绝：Alice 没有任何允许它的 role，拒绝记录写进 audit log。
- 请求 Bob 的 `BK2001`，得到的是和"这个 booking 不存在"一模一样的"no booking found"文字。

谁需要理解这个？**你，开发者。** Alice 只看到"我没能取消它"。本 lab 展示这两道检查在哪里，以及为什么两者都不能依赖 session 记住的东西。

| 场景里的东西 | lab 里的对应 |
| --- | --- |
| Alice 今天被 offer 哪些 tool | `resolveCapabilities`，用 `configure({ tools })` 应用 |
| session 记住的东西 | 存下来的 offer，读回来叫 `restoredOffer` |
| "这次调用能不能跑？" | `BookingService` 和 `policy.ts` 里的纯函数 `decide()` |
| 决策的记录 | audit log（actor、roles、resource、action、policy version、decision） |
| booking 系统自己的检查 | 本地 downstream service，根据 token 重新检查 tenant 和 owner |

## 核心想法

```text
request ──► 今天的 roles ──► offer = 这些 roles 允许的 tool ──► 用 configure() 覆盖存下来的 offer
                                                                      │
model 请求某个 tool ──► 没被 offer？ ⊘ 拒绝，什么都不执行              │
                    └─► 被 offer ──► BookingService：role + tenant + owner + status
                                        ├─ deny  → 写 audit，把错误文字给 model，没有 effect
                                        └─ allow → 写 audit，再经 connector → downstream（delegated token）
```

要带走的三点：

1. **session 存的是 offer，不是 permission。** 重新打开的 session 保留它存下的 tool 列表；
   必须在每次 run 之前、任何 model 调用或被恢复的 task 之前替换它。
2. **offer 是便利，检查才是保证。** 两道 gate 都需要：第一道让 tool 不会被请求，第二道确保漏过去的调用仍然是被允许的。
3. **有多个 container 的 booking 是一个 resource。** 权限、audit 和 status 变更都按 booking 算，从不按 container 算。

## 实验

`npm run demo:revocation` 用 scripted model（不联网）重放上面的场景，打印每天的 trace、booking 系统实际改了什么，以及 audit log。
roadmap 的 prediction 已被 waive（见 [WORKSHEET.md](WORKSHEET.md)）；[REFERENCE.md](REFERENCE.md) 给出结果。

一次运行的结果：

| | 周一 | 周二（同一个 session，role 已撤销） |
| --- | --- | --- |
| 重新打开时存下的 offer | — | `get_booking`、`update_booking_status` |
| 实际 offer 给 model 的 | 两个 tool | 只有 `get_booking` |
| model 的请求 | 对 `BK1001` 调 `update_booking_status` | 同一个 tool，同一个 `BK1001` |
| 结果 | 成功 | `⊘ tool_refused … code=tool_unavailable` |
| booking 系统的变更数 | 1 | 仍然是 1 |
| audit 的 decision 记录 | 1 条 allow | 没有新增（只有一条 capability 记录，roles `[viewer]`） |

- 这次拒绝是*结构性*的，所以没有 `deny` 那一行：证据是 capability 记录和 `⊘` 那行 trace。
- 143 个离线测试补上 demo 做不到的部分：写到一半真的 `SIGKILL` 再 resume、其他 tenant 和同事的 booking、
  给 viewer 的过期 offer、audience / scope / 过期不对的 downstream token、以及写不进去的 audit log（此时动作不会发生）。

读懂 trace：

| 行 | 含义 |
| --- | --- |
| `assistant (tool call) <name> call=<id> args=<json>` | model 请求了什么 |
| `⊘ tool_refused … code=tool_unavailable` | 今天没被 offer；我们自己的代码一行都没跑 |
| `⊘ tool_refused … code=invalid_arguments` | 参数没通过 schema（例如编造了 `tenantId`） |
| `▶ tool_start` … `◀ tool_end status=error code=tool_error reason="…"` | 被 offer 并执行了，随后被检查拒绝 |
| `system     tools +[…] -[…]` | offer 发生了变化 |
| `↺ …` | 在一次重启之前就开始了；`↺ tool_interrupted` 是进程死掉时正在执行、且没有被重跑的调用 |

## 运行

```bash
cd lab-17-resource-authorization
npm ci
npm run check             # typecheck + 143 个离线测试，不调用 model
npm run demo:revocation   # 上面的场景
npm run manifest          # 把 evidence manifest 写入 runtime-evidence/
```

手动试试（每条都跑过，数字就是你应该看到的）：

```bash
npx vitest run tests/policy.test.ts                 # 36 passed：role × resource × action 矩阵
npx vitest run tests/harness-trace-logger.test.ts   # 15 passed：上面每一种 trace 行
npx vitest run -t "positive control"                # 1 passed：role 没撤销时，写 tool 确实被 offer
npx vitest run -t "known gap"                       # 1 passed：旧 history 仍会被重放（见下）
```

## 自测

跑 demo 之前先回答 1–3：

1. Alice 重新打开 session 后，存下来的 offer 里有哪些 tool？model 实际拿到哪些？
2. model 仍然请求写 tool。audit log 里会出现 decision 记录吗？为什么？
3. 最后 booking 系统一共看到几次 status 变更？
4. offer 已经是对的了，为什么调用处的检查仍然必须存在？
5. Bob 的 booking 和不存在的 booking 为什么返回同样的文字？
6. 崩溃时有一个读操作在执行中，之后这个 booking 换了 owner。被恢复的 run 会怎样？

## 值得知道的

- **这里没有建立：** 真实的 on-behalf-of token exchange（delegated token 来自本地 stand-in，所以只覆盖了针对本地 mock 的
  audience、scope、delegation 检查）；真实的 Teams/Entra 身份；live model；Lab 15 的联合保证（建本 lab 时该 lab 被跳过）。
- **已知缺口，归属 Lab 19：** 已在 session 里的内容，即使用户已失去该 booking 的访问权，仍会被重放给 model。有一条 characterization test 固定了这一点。
- **未覆盖：** 在决策与 effect *之间*被撤销的 role（只有 booking status 变了会被拦下）。
- **Roles 存放在内存里**（`PermissionDirectory`）。测试里的"昨天"是一个全新进程：directory 变了，session 文件还是同一份。
- **Principal：** 测试和 demo 用 mint 出来的可信 `SecurityContext`；认证是 Lab 16 的事。
- **固定版本：** `pi-durable`、`pi-ai`、`chord` 为 `1.1.0`（`pi-durable` 是 experimental，所以只在 `1.1.0` 上观察过）；`jose` 为 `6.2.12`。
  只用了 scripted provider，所以真实 provider 如何处理"history 里提到了它已不再被 offer 的 tool"，没有测过。
- 逐字节复制的文件（SHA-256 前 12 位 hex）：来自 Lab 16 的 `security-context.ts` `7355f1e0fcf2` 与
  `session-registry.ts` `6fcad0fbc64b`，来自 Lab 13 的 `transcript.ts` `55f4803ed172`。`session-store.ts` 和
  `session-access.ts` 是本 lab 自己的，没有和 Lab 16 的对比过。没有任何代码从其他 lab import。

## 文件在哪里

```text
src/policy.ts                  roles、status 迁移、policy version、纯函数 decide()
src/policy-service.ts          当前 roles + resource -> decision -> audit（fail closed）
src/capability-resolver.ts     今天的 roles -> 被 offer 的 tool 名称
src/booking-service.ts         唯一的 application boundary：先 authorize，再 read / write
src/create-harness.ts          每个请求一个 registry；先读存下的 offer，再 configure() 成今天的
src/chat-service.ts            capabilities -> session -> harness -> offer -> submit / resume
src/booking-connector.ts, delegation.ts, downstream-service.ts   delegated token 与本地 booking 系统
src/harness-trace-logger.ts    trace 树
src/directory.ts, booking-store.ts, audit-log.ts, session-*.ts, app.ts
scripts/revocation-demo.ts     实验；  scripts/crash-child.ts  被 recovery 测试在 tool 执行中途 kill
tests/                         143 个测试；先看 runtime-authorization.test.ts 和 recovery.test.ts
data/directory.json            合成的 principals、roles、bookings（两个 tenant 都有 BK1001）
```
