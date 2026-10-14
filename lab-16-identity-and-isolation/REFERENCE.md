# Lab 16 — Reference Explanations

**Read this only after you have recorded your predictions in `WORKSHEET.md`** (or written
`waived`). It states the expected outcomes.

## 1. Two tenants, one `BK1001`

Each tenant gets its own record. Alice sees `ALPHA EXPRESS`, carol sees `BRAVO VOYAGER`; the two
answers differ and neither provider request contains the other tenant's vessel or container
number. The cache ends with two entries — same booking number, different scope.

What enforces it: `TenantBookingStore.findByBookingNo` filters on the `SecurityContext`'s
`tenantId` (the key is `(tenantId, bookingNo)`, not `bookingNo`), and `ScopedCache` keys entries
by tenant. The tool has no tenant parameter to fill in.

## 2. Knowing a session ID

Not sufficient. Bob and carol get `404 session_not_found` for both history and chat, and the body
is identical to the one for a session ID that never existed. No model call happens.

What enforces it: `SessionRegistry.find` returns the record only when both tenant and owner match
the caller's `SecurityContext`; an unknown ID and someone else's ID are the same `undefined`. The
check runs in `SessionAccessService.open`, before a harness exists.

## 3. Identity failures

Expired token, wrong audience, wrong issuer, wrong signature, unknown principal, and no
credentials all produce the same `401 {"error":"unauthenticated"}` and cause zero model calls and
zero session reads or writes. The specific reason is visible only in the server-side log. A
forged `X-Tenant-Id` header is never read; alongside a valid token it changes nothing.

## Where the guarantee lives (and where it does not)

| Guarantee | Owner |
| --- | --- |
| Who the caller is | `authenticator.ts` (jose: signature, issuer, audience, expiry, pinned alg) |
| Only server-minted identity is accepted downstream | `security-context.ts` (`assertSecurityContext`) |
| Which session the caller may touch | `session-registry.ts` + `session-access.ts` |
| Which rows the caller may read | `booking-store.ts` (composite key) |
| Cache entries stay in scope | `scoped-cache.ts` (JSON-array key) |
| Foreign data does not reach the provider or the response | *prevention only for stored/input text*: the pre-flight scan in `chat-service.ts` runs before `submit()`. `provider-boundary.ts` (a Pi 1.1 `beforeRequest` recorder) and the answer scan are *detectors*: the recorder sees a request that has already been sent, they withhold the response of that request, and neither repairs a scoping failure. The withheld answer is still in the session's stored history (README, "Findings to decide on") |

## Transfer hint

A shared conversation breaks the "exactly one owner" rule in `SessionRegistry`. You would need an
explicit membership record (who may read, who may append), a decision about whose tool results a
member may see, and per-message attribution — and Lab 17's per-resource authorization becomes
necessary, because tenant + owner is no longer enough to decide access.

## Evidence and provenance notes

- Mutation pass over the final code (28 single-line changes): 25 made tests fail as they should. The three survivors are
  equivalent or unreachable: the `jose` algorithm pin (`jose` already rejects other algorithms for an EC key), accepting an
  `unanswered` run (the next check still fails it), and closing the harness when `root()` fails (no public way to trigger it).
- Lab 15 was skipped. An untracked `lab-15-integrated-runtime/` directory appeared during the work; nothing here uses it.
- `provider-boundary.ts` (Lab 12), `settle.ts` (Lab 14) and `transcript.ts` (Lab 13) were copied while their sources were
  uncommitted, so sha256 prefixes identify them: `d73f5b4a`, `ea2a062e`, `55f4803e`.
