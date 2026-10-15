# Lab 21 — 持久的外部 Effect

[English](README.md) | 中文

如果下游系统已经完成了一个动作，但它的响应丢了，应用如何避免重复 effect，并确定真实的 outcome？

Roadmap：[ROADMAP-PHASE-3.md](../docs/design/ROADMAP-PHASE-3.md)，Lab 21（一个 lab 内连续两个实验）。

## 先读这里

- **预测关卡。** 在读过下面的"预测关卡"标题之后的内容之前，请先在 [WORKSHEET.md](WORKSHEET.md) 里记录你的预测（或者写 `waived`）。该标题之后的一切都在描述机制，
  因此会泄露答案，测试、`npm run demo:effects` 以及 [RUNBOOK.md](RUNBOOK.md) 里的表格同样如此。目前还没有 `REFERENCE.md`：它在预测被记录之后才会撰写。
- **前置条件以及声明了什么。** roadmap 列出的是 Lab 18 的已批准 action、Lab 20 的 connector 契约，以及本地 PostgreSQL。
  - **Lab 18** 是 action / approval / digest / 状态机代码的来源，这些代码被**复制**进本 lab（原文件的 hash 在 [SOURCES.sha256](SOURCES.sha256)；Lab 18 本身没有被改动）。
    改动见下面的"从 Lab 18 复制了什么"。
  - **Lab 20 的 connector 代码没有被复用。** 它的 interface 是只读的，而写操作的失败语义不同。它的*经验*被沿用：一组封闭的、有类型的失败类别、且只有一个重试责任方，
    以及对 cancellation 和 timeout 不能承诺什么保持诚实。
  - Lab 15（联合 runtime）、17（resource authorization）和 19（文档、provenance、egress）**没有**作为基础，也**不**在这里做声明，与 Lab 18–20 一样。
    Lab 18 刻意做得很小的 role 检查（[src/policy.ts](src/policy.ts)）代替了 Lab 17 的 policy。
- **没有 model，没有 Pi。** 本 lab 里没有任何东西调用 model，所以没有 Pi 依赖，也没有 live-model 运行。Pi 的 JSONL session 没有被触碰（见"存储与并发边界"）。
- receiver 是本地的替身。这些测试确立的是*应用*面对具有既定属性的 receiver 时会做什么；它们对真实下游系统的行为没有任何说明。

## Scope

**实验 A — 单个 action 的投递与对账**

- Lab 18 的已批准 action 在**一个** PostgreSQL 事务里被*准入（admit）*：记录执行意图、消耗 approval、插入一条 outbox 记录。这个事务里不发送任何东西。
- 由业务 action 的身份派生出一个稳定的 idempotency key，并在传输层重试、对账重发和 worker 重启之间保持不变。
- 一个本地 receiver，拥有自己的 schema 和自己的事务：按 key 幂等，按 key 查询结果。
- 投递 outcome 被分类，outbox 区分 `pending`、`in_flight`、`unknown`、`succeeded`、`failed` 和 `manual_review`。
- 未知 outcome 先通过 receiver 的状态接口对账，再考虑是否再次投递；无法判定的进入显式的人工复核。

**实验 B — 多个投递 worker**

- worker（不同对象，以及不同的 OS 进程）用 lease 和原子的条件 UPDATE 认领 outbox 行；之后的每一次写入都带 fencing token。
- 注入 lease 过期、worker 崩溃（包括 `SIGKILL`）以及旧 worker 的迟到响应。
- 在 receiver 处去重；在一个契约变体里，receiver 的写边界还会检查 fencing。
- 有界重试；`failed`（死信）与 `manual_review` 状态。

交付物：outbox、投递 worker、本地 receiver、reconciler、具名 checkpoint 的故障 harness、[人工修复 runbook](RUNBOOK.md)，以及一份把 attempt、business effect、durable result 分开的报告。

未覆盖：真实的下游系统；多实例共享 Pi session 或事务性的 session append（之后需要专门的 lab）；Lab 17 的 policy；Lab 19 的内容控制；真实的 Teams/Entra 审批体验；
任何 HTTP 前门（审批步骤是 service 调用；`npm run outbox` 是一个运维 CLI）。

## 目录结构

```text
data/tenants.json               Lab 18 的 fixture + 12 个额外的 tenant-a booking（BK3001–BK3012），用于并发测试
migrations/app/                 001/002：Lab 18 的 bookings、actions、approvals、events（有改动）；003：outbox + outbox_events
migrations/receiver/001_...sql  receiver 自己的表：bookings、effects、idempotency key、fence、请求日志
src/action-*.ts, policy.ts, ...  复制自 Lab 18（见下）
src/idempotency.ts              key 派生（action ID + 已批准 digest 的纯函数）
src/outbox.ts                   认领、lease 扫描，以及带 fencing 的写入（`settle`）
src/delivery-worker.ts          deliver + reconcile + 决策规则；唯一的重试责任方
src/receiver-client.ts          HTTP client，不做重试；对每种 outcome 分类
src/receiver/contract.ts        wire 类型、校验器，以及 ReceiverContract 假设
src/receiver/server.ts          本地 receiver（idempotency / lookup / fencing 可切换）
src/checkpoints.ts              具名 checkpoint 与故障计划
src/manual-review.ts            解决 manual_review 行的唯一途径
src/report.ts                   attempt / business effect / durable result 并排展示
scripts/                        db-up/down、effects-demo、worker-process（作为 OS 进程的 worker）、outbox-cli、write-manifest
tests/                          units、admission、delivery、faults、workers（含子进程）、manual-review、review-findings（独立 review 发现问题的回归测试）
RUNBOOK.md                      人工修复流程
WORKSHEET.md                    空白的学习者 worksheet
```

### 从 Lab 18 复制了什么

未改动：`action-digest.ts`、`security-context.ts`、`directory.ts`、`migrations 002`。有改动：

- `action-state.ts`、`action-service.ts`、`migrations/app/001_init.sql`：`execute` → `admit`，状态 `executed` → `admitted`；本地 `effects` 表和本地 booking 更新被移除；
  `admit()` 改为写一条 outbox 行；重复调用返回 `already_admitted`；新增 checkpoint `admit.before_commit`。
- `policy.ts`：新增 `mayResolveReview`（approver，且不能是 requester）。
- `db.ts`：两套 migration（app 与 receiver），各自通过自己的 pool 访问。
- `data/tenants.json`：多了 12 个 booking。

## 命令

在本目录下运行。需要 Node >= 24.5（在 Node v25.8.1、npm 11.11.0 上测试），以及 podman 或 docker 来运行本 lab 的 Postgres。

```bash
npm ci
npm run db:up                 # 在 127.0.0.1:5545 启动容器 pi-lab-21-pg，并把 DATABASE_URL 写入 .env
npm run check                 # typecheck + 全部测试；需要数据库，缺失时不会跳过
npm run demo:effects          # 在一次性 schema 上的场景表（先记录你的预测）
npm run manifest              # 写入 runtime-evidence/manifest-<timestamp>.json
npm run db:down               # 删除容器及其数据
```

每个测试文件使用自己的一对一次性 schema（一个给应用，一个给 receiver）。多进程测试会启动真实的 `node` 子进程（每个约 10 秒）。

运维 CLI（见 [RUNBOOK.md](RUNBOOK.md)）：

```bash
npm run --silent outbox -- list manual_review
npm run --silent outbox -- show <outboxId>
```

---

## 预测关卡

**在你于 [WORKSHEET.md](WORKSHEET.md) 里记录预测（或 `waived`）之前，请停在这里。** 本文件的其余部分陈述设计与证据。

---

## 设计与证据

### 三层，永不合并

| 层 | 问题 | 位置 |
| --- | --- | --- |
| **Attempt** | 应用尝试了多少次？多少个请求真正到达了 receiver？ | `outbox_events`（认领、过期、被丢弃的写入）；receiver 的请求日志 |
| **Business effect** | 下游 booking 实际改变了多少次？ | receiver 的 `receiver_effects`（ground truth——只有 receiver 知道） |
| **Durable result** | 应用把 outcome 记录成了什么？ | `outbox.status` + `result`，以及本地 `bookings` 视图 |

[src/report.ts](src/report.ts) 把它们并排打印，并标出不一致（重复 effect、没有 effect 的 `succeeded` 行）。`pending`、`in_flight`、`unknown` 或 `manual_review` 的行天然是诚实的：它不声称自己不知道的事。

### Admission（实验 A，步骤 1）

`ActionService.admit` 在对 action 加行锁之后，于一个事务里依次执行：role 与 policy 检查 → approval 期限 → 重新计算 digest → 双方当前的 role → 本地资源版本 → 消耗 approval →
插入 outbox 行（带其 idempotency key 和不可变的请求）→ 记录事件 → 把 action 移到 `admitted`。在 `admit.before_commit` 处崩溃会整体回滚；重复或同时的确认只会准入一行
（`already_admitted`，由 `outbox.action_id UNIQUE` 兜底）。请求在这个事务里从不离开进程。

### Idempotency key

`wb1-` + `(action ID, 已批准 digest)` 的 hash。它不涉及 worker、attempt、lease、fencing token 或时间，因此每次重试、对账重发和重启都出示同一个 key，
而两个不同的 action 永远不会共用一个 key。

### Outbox 生命周期

```text
pending --claim(deliver)--> in_flight --applied-------------------------> succeeded
   ^                          |  |  \--rejected / retries exhausted------> failed
   |                          |  \--connection refused (backoff)--------> pending
   |                          \--ambiguous | lease expired---------------> unknown
   |                                                                         |
   +----- reconcile: 无记录，且 receiver 按 key 去重 -> 重发 --------------+
          reconcile: receiver 确认 ---> succeeded | failed
          reconcile: 无法安全判定 --> manual_review --(人)--> succeeded | failed | pending
```

`succeeded` 和 `failed` 是终态（由 trigger 强制）。`failed` 的意思是"已知没有发生，且不再计划投递"（`rejected_by_receiver`，或 `retries_exhausted`——即死信）。
只有当**每一次**尝试都是连接被拒绝时才会到达死信：如果更早的某次尝试是 ambiguous 或丢了 lease，达到上限时会转 `manual_review`，因为 effect 可能已经存在。

### 每种 outcome 证明了什么

| worker 看到了什么 | 分类为 | 证明 effect 没有发生吗？ |
| --- | --- | --- |
| 2xx 且带有合法的 `applied` body | `applied` | 它说发生了 |
| 4xx 且带有合法的 `rejected` body | `rejected` | 是——receiver 处理并拒绝了 |
| 409 `stale_fence` | `stale_fence` | 该 token 没有生效；worker 停止 |
| Connection refused | `not_sent` | **是**——没有任何字节到达 receiver |
| Timeout、连接被重置、5xx、无法读取/意外的 body | `ambiguous` → `unknown` | **否** |
| Lease 过期 | `unknown` | **否**——连请求是否发出都不知道 |

### 按 receiver 契约对账

`ReceiverContract { idempotency: key | none, lookup, fencing }` 是应用*假设*的内容；它是配置，不是探测。

| Receiver | lookup 返回 | 决策 |
| --- | --- | --- |
| 有 lookup | applied | `succeeded`（来源 `reconciliation`），不重发 |
| 有 lookup | rejected | `failed` |
| 有 lookup + 幂等 | 无记录 | 用同一个 key 重发（因为有去重，所以安全） |
| 有 lookup，**不**幂等 | 无记录 | `manual_review`——原始请求可能还会到达 |
| 无 lookup，幂等 | — | 用同一个 key 重发 |
| 无 lookup，**不**幂等 | — | `manual_review` |
| lookup 不可达 | — | 带 backoff 重试，有界 → `manual_review` |
| lookup 与请求不符，或报告同一 key 有多个 effect | — | `manual_review`（不被信任） |
| 投递得到"key 被用于不同的请求" | — | `manual_review` |

一旦达到 `maxDeliveryAttempts`，重发会被拒绝（转 `manual_review`），因此总投递次数有界。

### Lease 与 fencing

- 一次**认领**是一个原子的条件 `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`，同时递增 `fencing_token`。两个 worker 永远不会拿到同一行。
- **Lease 过期**把行送到 `unknown`，而不是 `pending`：它只说明持有者没有续期，不说明它已停止，也不说明它是否已发送。
- worker 的每一次写入都是 `UPDATE … WHERE id AND fencing_token AND lease_owner AND status`。失去认领的 worker 匹配到零行；它的结果被丢弃，并记录为 `stale_write_rejected`。
  fence 是 token、owner 和期望状态三者的合取。一个停顿超过 lease、但其行没有被任何人扫描或重新认领的 worker，仍然可以记录它（真实的）结果；一旦扫描或更新的认领移动了该行，
  这次写入就会被丢弃。token 用来区分同一个 worker ID（重启后的进程）发出的两次同类认领；由时钟驱动的扫描同样参与其中。owner 检查与 token 是冗余的（每次认领都会提高 token），作为纵深防御保留。
- 这道 fence 保护的是**应用**的状态。**receiver** 的写边界是另一回事：在 `fencing` 契约变体里，它会拒绝小于该 key 已接受过的 token。
  Fencing 不是去重：一个只检查 token 的 receiver，如果较旧的 token 先到，仍会把同一个请求应用两次。
- lease 必须比一次 receiver 请求活得更久（在构造时校验）。

### Checkpoint

| Checkpoint | 在这里崩溃 / 注入故障意味着 |
| --- | --- |
| `admit.before_commit` | approval 已消耗、outbox 行已插入，但未提交 → 回滚 |
| `worker.after_claim` | 持有 lease，什么都没发 |
| `worker.before_send` / `worker.after_response` | 即将调用 / 答案在内存里，什么都没记录 |
| `worker.before_result_commit` | 同上，紧邻带 fencing 的写入之前 |
| `worker.after_result_commit` | 结果已持久 |
| `receiver.before_apply` | receiver 读到了请求；在此 `delay`、`http 503` 或 `drop` |
| `receiver.after_apply` | effect 已在 receiver 处提交；在此 `drop` 或 `http 503` 会丢失响应 |

故障计划按名字安装（`Checkpoints`），子进程则通过环境变量 `FAULTS`；`kill` 会向进程发送 `SIGKILL`。

### 每个保证背后的 receiver 假设

| 保证（在测试中） | 只有当 receiver…… 时才成立 |
| --- | --- |
| 同一个 action 的重试只产生一个 business effect | 按 key 去重（`idempotency: key`），且 key 与请求相同 |
| 丢失的响应无需重发即可解决 | 提供按 key 报告 effect 的状态 lookup |
| 过期的 worker 无法覆盖更新的应用状态 | —（由应用自己的数据库强制） |
| 过期 worker 的迟到请求不会重复应用 | 按 key 去重，或校验 fencing token 且较旧的 token 后到 |
| timeout 之后的重发是安全的 | 按 key 去重 |
| 没有上述 receiver 支持的行不会被盲目重发 | —（应用把它交给人） |

在假设不成立时钉住*失败*的测试：`delivery.test.ts`（"assumed idempotent but the receiver is not"）、`workers.test.ts`（"fencing is not deduplication"）、
`manual-review.test.ts`（"redeliver … can double the effect"）。

### 验收标准 → 证据

| Roadmap 标准 | 检查位置 |
| --- | --- |
| 在 receiver 的 idempotency 契约下，同一 action 的重试只产生一个 effect | `delivery.test.ts`（重复投递、key 复用）；`faults.test.ts`（每个崩溃/丢失场景都止于一个 effect）；`workers.test.ts`（并发认领、SIGKILL） |
| 未知 outcome 既不显示为成功，也不被当作失败盲目重发 | `faults.test.ts`（"response lost…"、"timeout does not prove…"）；`workers.test.ts`（既无 idempotency 也无 lookup；有界重试） |
| 过期 worker 无法覆盖更新的状态 | `workers.test.ts`（"lease expiry and a stale worker"） |
| 未解决的 outcome 有可检视的人工复核路径 | `manual-review.test.ts`、[RUNBOOK.md](RUNBOOK.md)、`npm run outbox` |
| 报告区分 attempt、business effect 和 durable result | `src/report.ts`；在 `delivery.test.ts`、`faults.test.ts`、`manual-review.test.ts` 中断言 |
| 测试写明每个 effect 保证背后的 receiver 假设 | 上面的表，以及"假设不成立"的测试 |
| Admission 是事务性的；重复确认只准入一次 | `admission.test.ts` |

### 存储与并发边界

本 lab 里的多个 worker 投递的是业务 action。Pi 的 JSONL session 仍然是单写者：outbox 上的 lease 不会让 session 文件对并发访问变得安全。
本 lab 的 outbox 事务**不**包含 Pi session 的写入，也不包含 receiver 自己的事务——这是三次彼此独立的提交，这正是"响应丢失"这类场景存在的原因。
多实例共享 session、事务性 session append 和 session 后端迁移，需要之后基于已验证的公开 SDK interface 的专门 lab。

### 已知限制

- **前置 lab：** 没有建立在 Lab 15、17、19 之上，也没有复用 Lab 20 的 connector 代码（未联合验证）。
- Lease 和 backoff 使用 worker 自己的时钟。不同主机上、时钟有偏差的 worker 会缩短或延长 lease；*状态*的正确性由 token 保护，但及时性没有。生产版本应从数据库取时间。
- 以 `confirmed_applied` 解决一行时，会记录复核者的报告，但本地视图永远不会被往回拨；审计事件会说明视图是否移动过。
- 对不幂等的 receiver，lookup 报告最新的 effect 及 effect 数量；数量正是暴露重复 effect 的依据。
- 应用本地的 booking 视图只和最近一次 durable result 一样新。真正保护远端 booking 的是 receiver 的版本前置条件（`expectedVersion`）：针对同一版本批准的两个 action 可以都被准入，由 receiver 决定谁赢。
- 这里 receiver 的 idempotency 记录永不过期。真实系统有保留窗口；窗口之后的重发就是 worksheet 里的 transfer 问题。
- 人工复核的结果信任复核者对下游状态的报告（note 就是证据）。
- 没有真实的下游系统，也没有 live-model 运行（不适用）。

### 证据状态

| 项目 | 状态 |
| --- | --- |
| 确定性检查（`npm run check`） | 71 个测试通过（Node v25.8.1，Postgres 16 容器）；放宽两个对计时敏感的测试后，连续 5 次完整运行稳定 |
| 双进程与 SIGKILL 实验 | 属于测试套件 |
| 削弱控制（mutation）检查 | 逐个削弱 35 个控制点：33 个被检出。2 个作为等价 mutant 存活：在带 fencing 的写入里忽略 `lease_owner`（与 token 冗余，作为纵深防御保留），以及 lookup 读最旧而非最新的 effect（`effectCount > 1` 转人工后已不可达）。最初的两个存活项（token 检查、admission 处的 digest 复核）促成了新测试 |
| 独立 review | 由独立 reviewer 完成：1 个 HIGH + 5 个 MEDIUM + 5 个 LOW。HIGH（更早一次 ambiguous 尝试之后写出终态 `failed`）、各 MEDIUM 以及 3 个 LOW 已修复并有回归测试（`review-findings.test.ts`）；这些修复尚未经过第二次独立 review。作为已记录的限制保留：CLI 的 `list`/`show` 没有按 tenant 限定范围 |
| Demo 输出 / `REFERENCE.md` | 在预测被记录之前不提供 |
| 真实的下游系统 | 未运行（待定；需要有文档的 idempotency 与 lookup 语义） |
| Live model | 不适用 |
