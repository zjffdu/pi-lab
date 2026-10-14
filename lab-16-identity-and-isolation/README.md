# Lab 16 — Authenticated Principal and Tenant Isolation

English | [中文](README.zh-CN.md)

**Question:** who is asking, and how does that answer keep one company's data, sessions, and cache away from another's?
**Answer this lab shows:** the server decides, once, from a verified token — and then hands that decision down. Two
parts:

- **Identity is created by the server, never read from the request.** A signed token is checked, and only then does
  the server build a `SecurityContext` (tenant, subject, request id). Headers, the request body, the prompt, and the
  model's tool arguments are never asked "who are you?".
- **Everything that stores or returns data is keyed by that identity.** The booking table, the cache, and the session
  registry each include the tenant (and, for sessions, the owner) in their key, so the same booking number in two
  tenants never meets.

Think of a hotel keycard: the front desk checks your ID once and encodes a card; every door afterwards trusts the
card, not what you say at the door.

## A concrete scenario

Two shipping companies use the same assistant. Both have a booking called `BK1001` — different vessel, different
containers. Alice and Bob work at company A, Carol at company B.

| Moment | What goes wrong without this lab | What the lab does |
| --- | --- | --- |
| Carol asks about `BK1001` | A table keyed by booking number alone returns A's record, or the cache serves A's entry | the lookup key is `(tenant, bookingNo)`; the cache key includes the tenant |
| An attacker sends `X-Tenant-Id: tenant-b` with Alice's token | a service that trusts the header now reads B's data | the header is never read; only the verified token decides the tenant |
| Bob learns the ID of Alice's session | "I know the ID" works as a password and he reads her history | the server-side registry says who owns the session; Bob gets the same 404 as for an ID that never existed |
| A token expired an hour ago | an expired login still reaches the model and burns tokens | rejected before any session is opened or any model is called |
| The model is talked into calling `get_booking` with `tenantId: "tenant-b"` | the tool obeys | the tool has no tenant parameter; the schema refuses the call and `execute()` never runs |

Who has to understand this? **You, the developer.** Employees just sign in; the lab teaches you where the identity
is created and which three or four places must carry it.

| In the scenario | In the lab |
| --- | --- |
| the keycard | `SecurityContext` (`src/security-context.ts`) |
| the front desk checking ID | `authenticator.ts` (`jose`: signature, issuer, audience, expiry) |
| who owns which session | `SessionRegistry` + `SessionAccessService` |
| the same number in two companies | `TenantBookingStore` and `ScopedCache` keys |
| a last look at what leaves the building | the pre-flight scan, the boundary recorder, the answer scan |

## The idea

```text
Authorization header ─► authenticator ─► SecurityContext ─► registry says: may this caller open this session?
   (only this input)     (jose + directory)                      │ yes
                                                                 ▼
                       harness built per request: tool closed over the SecurityContext
                         tenant-scoped lookup + tenant-scoped cache  ─► model ─► answer scan ─► response
```

Three takeaways:

1. **Order is the guarantee.** Authenticate, then resolve the session, then build the harness, then call the model.
   A request that fails a step never reaches the next, so a bad token costs no session read and no model call.
2. **Denials say as little as possible.** Every authentication failure returns the same 401 body; an unknown session
   and someone else's session return the same 404 body. The specific reason goes only to the server log.
3. **Isolation and detection are different jobs.** The tenant key, the registry, and the cache key *isolate*. The
   scans only *detect* that isolation already failed — and in Pi 1.1 a `beforeRequest` hook cannot stop a request
   (a throw there is reported and the request is still sent). So the only check that prevents a provider call is the
   pre-flight scan before `submit()`; the in-run recorder can only withhold the response afterwards.

## The experiment

`npm run demo:isolation` starts a real local HTTP server with a scripted model (no live model call) and prints a
table. Write your predictions in [WORKSHEET.md](WORKSHEET.md) first:

1. Alice (tenant A) and Carol (tenant B) each ask about `BK1001`. What does each get, and what does each provider
   request contain?
2. Bob (same tenant as Alice) and Carol both know the ID of Alice's session. Can they read it or continue it? Is a
   model called?
3. Expired token, wrong audience, and a forged `X-Tenant-Id` with no token: what status, and how many model calls?
4. A valid tenant-A token plus a forged `X-Tenant-Id: tenant-b`: whose data does the provider see?

The results are deliberately **not** printed here, because this lab's prediction is still open — they are in
[REFERENCE.md](REFERENCE.md), to read after you have predicted. Evidence from the code is separate: `npm run check`
(82 offline tests).

## Run it

```bash
cd lab-16-identity-and-isolation
npm ci
npm run check            # typecheck + 82 offline tests, no model calls
npm run demo:isolation   # the scenario table (predict first)
npm run manifest         # writes runtime-evidence/manifest-<timestamp>.json
npm run dev              # local server on :3979 with the real model (needs .env; live step)
```

Try it by hand (`npm run dev` in another terminal; none of these call the model):

```bash
curl -s -w ' -> %{http_code}\n' -X POST localhost:3979/v1/chat -H 'content-type: application/json' -d '{"message":"hi"}'
curl -s -w ' -> %{http_code}\n' -X POST localhost:3979/v1/chat -H 'x-tenant-id: tenant-b' -H 'content-type: application/json' -d '{"message":"hi"}'
curl -s -w ' -> %{http_code}\n' localhost:3979/v1/sessions/nope/messages -H "authorization: Bearer $(npm run --silent token -- tenant-a mallory)"
curl -s -w ' -> %{http_code}\n' localhost:3979/v1/sessions/nope/messages -H "authorization: Bearer $(npm run --silent token -- tenant-a alice)"
```

The first three return `{"error":"unauthenticated",…} -> 401` (the server log tells them apart: `missing_token`,
`missing_token`, `unknown_principal`); the fourth returns `{"error":"session_not_found",…} -> 404`. A real chat needs
`DEEPSEEK_API_KEY` in `.env`; `TRACE_TEXT=full npm run dev` prints message text in the trace (synthetic data only).

Reading the trace: one run/turn/tool tree per request, every line tagged `req=<id8> tenant=<t> sub=<s>`. The model's
request (`assistant (tool call) … call=<id>`) and Pi's execution (`▶ tool_start`/`◀ tool_end`) are separate lines
paired by `call=`. A call the harness refused without running it prints `⊘ tool_refused … code=invalid_arguments`.
Message text prints as `chars=N`; tool-result content and the bearer token never print.

## Test yourself

Answer 1–4 before running the demo, the rest after:

1. Why is `(tenantId, bookingNo)` the key, and what would a `bookingNo`-only key return for Carol?
2. A session ID is a long random string. Why is that still not enough to read a session?
3. Why do an expired token and a token naming an unknown user get the same response body?
4. Where does the tenant come from in a request that carries both a token and `X-Tenant-Id`?
5. The model adds `tenantId` to a `get_booking` call. Which component stops it, and does `execute()` run?
6. Why can the in-run recorder not protect the provider, and which check can?
7. The response to a withheld answer is a 502. Is the answer gone? (See "Good to know".)

## Good to know

- **Lab 15 was skipped, on the learner's decision.** This lab uses its own minimal harness (one read tool, no policy
  hooks, no audit log, no telemetry), so none of Lab 15's joint guarantees are claimed.
- **Real Teams/Entra authentication is not covered**, and nothing local implies it. In a real integration, channel
  authentication (the request came from Teams) is not employee identity; employee identity must come from a validated
  Entra token, with `tid` → tenant and `oid` → subject (not UPN or email, which can change). Unverified.
- **Findings for you to decide, left unchanged:** (a) the pre-flight scan is an existence oracle: Alice typing
  another tenant's container number gets a 502 where an ordinary message gets 200; (b) a withheld answer was already
  committed, so the session owner can still read it from the history endpoint (a test marked "KNOWN GAP" pins this
  and should flip when fixed); (c) the trace hides message text by default, unlike Lab 01 — for a purely local run you
  may prefer `full`.
- **Limits:** single process; the registry is append-only JSONL and `pi-durable` does no cross-process locking; no
  token revocation; the scans are substring checks, so a paraphrased leak is not detected; response timing was not
  analyzed.
- Bookings have one or several containers (`containerNos`, non-empty); every container of another tenant's booking is
  a foreign marker. Cleanup runs with the caller's abort signal removed, so a cancelled request cannot replace the
  real failure with an `AbortError`.
- **Pins:** `pi-durable`, `pi-ai`, `chord` `1.1.0`, `jose` `6.2.12`; default model `deepseek-flash`. Provider or
  connection problems: see [Lab 01](../lab-01-pi-agent-loop/README.md).
- Copied, not imported: `provider-boundary.ts` (Lab 12), `settle.ts` (Lab 14), `transcript.ts` (Lab 13).

## Where things are

```text
src/security-context.ts   SecurityContext; only server-minted instances pass assertSecurityContext
src/authenticator.ts      jose validation -> SecurityContext | failure reason (server-side only)
src/token-issuer.ts       local ES256 test issuer (throwaway key in runtime-evidence/)
src/directory.ts          fixture loader + PrincipalDirectory (known tenant/subject pairs)
src/booking-store.ts      table keyed (tenantId, bookingNo); scoped-cache.ts: cache keyed by tenant
src/session-registry.ts   sessionId -> {tenant, owner}; session-access.ts opens storage only if allowed
src/chat-service.ts       authenticate-then-run seam: pre-flight scan, answer by submission record, answer scan
src/create-harness.ts     per-request registry + Harness.open;  get-booking-tool.ts: closed over the context
src/provider-boundary.ts  beforeRequest recorder (detects, cannot block)
src/harness-trace-logger.ts   per-request trace, tagged and redacted;  http-server.ts, app.ts, index.ts
data/tenants.json         two tenants, three principals, colliding BK1001
scripts/isolation-demo.ts the experiment;  tests/ offline proof;  WORKSHEET.md / REFERENCE.md
```
