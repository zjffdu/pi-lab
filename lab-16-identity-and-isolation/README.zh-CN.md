# Lab 16 — Authenticated Principal 与 Tenant Isolation

[English](README.md) | 中文

**问题：** 谁在发请求？这个答案如何让一家公司的数据、session 和 cache 与另一家公司隔开？
**本 lab 给出的答案：** 由服务端根据已验证的 token 决定一次，然后把这个结果一路传下去。分两部分：

- **身份由服务端创建，而不是从请求里读取。** 先校验签名 token，之后服务端才构造 `SecurityContext`（tenant、
  subject、request id）。Header、请求体、prompt、模型给出的 tool 参数，都不会被拿来回答“你是谁”。
- **所有存储或返回数据的地方，都以这个身份为 key。** Booking 表、cache、session registry 的 key 里都包含
  tenant（session 还包含 owner），所以两个 tenant 里相同的 booking 号永远不会撞在一起。

可以把它想成酒店房卡：前台核对一次证件，然后制一张卡；之后每扇门只认卡，不听你在门口怎么说。

## 一个具体场景

两家船运公司共用同一个 assistant。两家都有一个叫 `BK1001` 的 booking——船不同，container 也不同。Alice 和
Bob 在公司 A，Carol 在公司 B。

| 时刻 | 没有本 lab 的做法会怎样 | 本 lab 怎么做 |
| --- | --- | --- |
| Carol 查询 `BK1001` | 只用 booking 号做 key 的表会返回 A 的记录，或者 cache 把 A 的条目给她 | 查询 key 是 `(tenant, bookingNo)`；cache key 包含 tenant |
| 攻击者拿着 Alice 的 token 再加一个 `X-Tenant-Id: tenant-b` | 信任这个 header 的服务就会去读 B 的数据 | 这个 header 根本不读；只有已验证的 token 决定 tenant |
| Bob 得知了 Alice 的 session ID | “知道 ID”等于密码，他读到了她的历史 | 服务端 registry 记录 session 属于谁；Bob 得到的 404 与一个从未存在的 ID 完全相同 |
| token 一小时前就过期了 | 过期的登录仍能进到模型，白白消耗 token | 在打开任何 session、调用任何模型之前就被拒绝 |
| 有人诱导模型用 `tenantId: "tenant-b"` 调用 `get_booking` | tool 照做 | tool 没有 tenant 参数；schema 拒绝这次调用，`execute()` 不会运行 |

谁需要理解这个？**你，开发者。** 员工只需要登录；本 lab 教你的是身份在哪里创建，以及哪三四个地方必须带着它。

| 场景里的东西 | lab 里对应 |
| --- | --- |
| 房卡 | `SecurityContext`（`src/security-context.ts`） |
| 前台核对证件 | `authenticator.ts`（`jose`：signature、issuer、audience、expiry） |
| 哪个 session 属于谁 | `SessionRegistry` + `SessionAccessService` |
| 两家公司里相同的号码 | `TenantBookingStore` 与 `ScopedCache` 的 key |
| 离开前最后再看一眼带出去的东西 | pre-flight 扫描、boundary recorder、answer 扫描 |

## 核心思路

```text
Authorization header ─► authenticator ─► SecurityContext ─► registry 判断：这个调用者能打开这个 session 吗？
   （唯一的输入）         (jose + directory)                      │ 能
                                                                 ▼
                       每个请求构建 harness：tool 闭包持有 SecurityContext
                         按 tenant 查询 + 按 tenant 的 cache  ─► 模型 ─► answer 扫描 ─► 响应
```

三个要点：

1. **顺序本身就是保证。** 先认证，再解析 session，再构建 harness，最后才调用模型。某一步失败的请求不会进入
   下一步，所以一个无效 token 不会产生任何 session 读取，也不会产生模型调用。
2. **拒绝信息尽量少。** 所有 authentication 失败返回同一个 401 body；未知 session 和别人的 session 返回同一个
   404 body。具体原因只写进服务端日志。
3. **Isolation 和 detection 是两件事。** tenant key、registry、cache key 负责*隔离*；各种扫描只能*发现*隔离已经
   失效——而在 Pi 1.1 里，`beforeRequest` hook 无法阻止请求（里面抛错只会被 report，请求照样发出）。所以唯一
   能阻止 provider 调用的检查是 `submit()` 之前的 pre-flight 扫描；运行中的 recorder 只能事后扣下响应。

## 实验

`npm run demo:isolation` 启动一个真实的本地 HTTP server，配脚本化的模型（不调用真实模型），并打印一张表。
请先在 [WORKSHEET.md](WORKSHEET.md) 写下你的预测：

1. Alice（tenant A）和 Carol（tenant B）各自查询 `BK1001`。各自得到什么？各自的 provider 请求里有什么？
2. Bob（与 Alice 同一个 tenant）和 Carol 都知道 Alice 的 session ID。他们能读取或继续这个 session 吗？会
   调用模型吗？
3. 过期 token、错误的 audience、没有 token 却伪造 `X-Tenant-Id`：各是什么状态码，模型被调用几次？
4. 有效的 tenant-A token 再加伪造的 `X-Tenant-Id: tenant-b`：provider 看到的是谁的数据？

结果在这里有意**不**展示，因为本 lab 的预测还没有记录——请先预测，再去看 [REFERENCE.md](REFERENCE.md)。
来自代码的证据是另一回事：`npm run check`（82 个离线测试）。

## 运行

```bash
cd lab-16-identity-and-isolation
npm ci
npm run check            # typecheck + 82 个离线测试，不调用模型
npm run demo:isolation   # 场景表（先预测）
npm run manifest         # 写入 runtime-evidence/manifest-<timestamp>.json
npm run dev              # 在 :3979 用真实模型启动本地 server（需要 .env；live 步骤）
```

手动试试（另开一个终端运行 `npm run dev`；下面这些都不会调用模型）：

```bash
curl -s -w ' -> %{http_code}\n' -X POST localhost:3979/v1/chat -H 'content-type: application/json' -d '{"message":"hi"}'
curl -s -w ' -> %{http_code}\n' -X POST localhost:3979/v1/chat -H 'x-tenant-id: tenant-b' -H 'content-type: application/json' -d '{"message":"hi"}'
curl -s -w ' -> %{http_code}\n' localhost:3979/v1/sessions/nope/messages -H "authorization: Bearer $(npm run --silent token -- tenant-a mallory)"
curl -s -w ' -> %{http_code}\n' localhost:3979/v1/sessions/nope/messages -H "authorization: Bearer $(npm run --silent token -- tenant-a alice)"
```

前三条返回 `{"error":"unauthenticated",…} -> 401`（服务端日志能区分它们：`missing_token`、`missing_token`、
`unknown_principal`）；第四条返回 `{"error":"session_not_found",…} -> 404`。真正的聊天需要在 `.env` 里设置
`DEEPSEEK_API_KEY`；`TRACE_TEXT=full npm run dev` 会在 trace 里打印消息文本（仅限 synthetic data）。

如何读 trace：每个请求一棵 run/turn/tool 树，每行都带 `req=<id8> tenant=<t> sub=<s>` 标签。模型的请求
（`assistant (tool call) … call=<id>`）与 Pi 的执行（`▶ tool_start`/`◀ tool_end`）是分开的行，用 `call=` 配对。
harness 没运行就拒绝掉的调用会打印成 `⊘ tool_refused … code=invalid_arguments`。消息文本只打印 `chars=N`；
tool result 的内容和 bearer token 从不打印。

## 自测题

1–4 请在运行 demo 之前回答，其余运行之后再答：

1. 为什么 key 是 `(tenantId, bookingNo)`？如果只用 `bookingNo`，Carol 会得到什么？
2. session ID 是一长串随机字符，为什么这仍然不足以读取一个 session？
3. 为什么过期的 token 和指向未知用户的 token 得到相同的响应 body？
4. 一个请求同时带有 token 和 `X-Tenant-Id`，tenant 从哪里来？
5. 模型在 `get_booking` 调用里加了 `tenantId`。哪个组件拦下了它？`execute()` 会运行吗？
6. 为什么运行中的 recorder 保护不了 provider？哪个检查可以？
7. 被扣下的 answer 返回的是 502。这个 answer 就消失了吗？（见“值得知道”。）

## 值得知道

- **状态：** 确定性检查通过（82 个测试）。本 lab 没有建立在 Lab 15 之上，两者没有联合验证。实验验证和学习者完成情况尚待进行；没有真实的 Teams/Entra 证据。
- **Lab 15 被跳过了，这是学习者的决定。** 本 lab 使用自己的最小 harness（一个只读 tool，没有 policy hooks、
  audit log、telemetry），因此不声称 Lab 15 的任何联合保证。
- **真实的 Teams/Entra authentication 没有覆盖**，任何本地结果都不能暗示它。真实集成里，channel authentication
  （请求来自 Teams）不等于员工身份；员工身份必须来自经过校验的 Entra token，`tid` → tenant、`oid` → subject
  （不用 UPN 或 email，它们会变）。未验证。
- **留给你决定的发现，均未改动：** (a) pre-flight 扫描是 existence oracle：Alice 输入别的 tenant 的 container
  号会得到 502，而普通消息得到 200；(b) 被扣下的 answer 早已提交，所以 session 的 owner 仍能从 history 接口读到
  它（标为 “KNOWN GAP” 的测试固定了这一点，修复后它应当翻转）；(c) trace 默认隐藏消息文本，与 Lab 01 不同——
  纯本地运行时你可能更想用 `full`。
- **局限：** 单进程；registry 是 append-only JSONL，`pi-durable` 也不做跨进程加锁；没有 token revocation；扫描
  只是子串检查，改写过的泄露检测不到；没有分析响应时间。
- Booking 有一个或多个 container（`containerNos`，非空）；其他 tenant 的 booking 的每个 container 都是 foreign
  marker。清理时去掉了调用方的 abort signal，所以被取消的请求不会用 `AbortError` 盖掉真正的失败。
- **固定版本：** `pi-durable`、`pi-ai`、`chord` 为 `1.1.0`，`jose` 为 `6.2.12`；默认模型 `deepseek-flash`。
  provider 或连接问题：见 [Lab 01](../lab-01-pi-agent-loop/README.md)。
- 拷贝而非 import：`provider-boundary.ts`（Lab 12）、`settle.ts`（Lab 14）、`transcript.ts`（Lab 13）。

## 文件位置

```text
src/security-context.ts   SecurityContext；只有服务端创建的实例能通过 assertSecurityContext
src/authenticator.ts      jose 校验 -> SecurityContext | 失败原因（仅服务端可见）
src/token-issuer.ts       本地 ES256 测试 issuer（一次性 key，存放在 runtime-evidence/）
src/directory.ts          fixture loader + PrincipalDirectory（已知的 tenant/subject 组合）
src/booking-store.ts      以 (tenantId, bookingNo) 为 key 的表；scoped-cache.ts：以 tenant 为 key 的 cache
src/session-registry.ts   sessionId -> {tenant, owner}；session-access.ts 只有允许时才打开 storage
src/chat-service.ts       “先认证再运行”的衔接层：pre-flight 扫描、按 submission 记录取 answer、answer 扫描
src/create-harness.ts     每个请求一个 registry + Harness.open；get-booking-tool.ts：闭包持有 context
src/provider-boundary.ts  beforeRequest recorder（只发现，不能阻止）
src/harness-trace-logger.ts   每个请求的 trace，带标签且已脱敏；http-server.ts、app.ts、index.ts
data/tenants.json         两个 tenant、三个 principals、相互冲突的 BK1001
scripts/isolation-demo.ts 实验；tests/ 离线证明；WORKSHEET.md / REFERENCE.md
```
