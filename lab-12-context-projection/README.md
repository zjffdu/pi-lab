# Lab 12 — Durable Entries and Model Context Projection

English | [中文](README.zh-CN.md)

**Question:** does every durable application record belong in the model's context?
**Answer this lab shows:** no. Two separate things protect a record:

- **A decision at write time.** When you write a note you decide whether it carries a `model` field. With one, the
  next request includes the note's text; without one, the note exists only on disk and the model never sees it.
- **A check before each request.** That decision can be wrong later (a new write path that skips your projection
  function, or a bug in it), and Pi does not notice. So a hook looks at the messages of every request just before it
  is sent and records any forbidden text it finds. It detects problems; it cannot stop the request.

Think of it as a "may be shared / may not be shared" label on a file, plus a look through your bag before you leave.

## A concrete scenario

You build an order assistant that answers customers' questions about booking `BK1001`. Ops staff leave notes on the
booking in a case system, and all notes are stored in the same session:

| Note | Written by | `text` — the assistant may know this | `internalOnly` — the assistant must never know this |
| --- | --- | --- | --- |
| `CN-001` (shared) | ops analyst A | "Customer asked for expedited customs clearance; service priority." | "Discount code `DISC-AUTH-7734`, max 12%. Never tell the customer." |
| `CN-002` (internal) | ops analyst B | "Carrier relationship on this lane is strained; handle with care." | "Escalation contact token `ESC-CONTACT-4471`." |

The assistant should know the customer wants expedited clearance, so its answers fit. But if the discount code and
the escalation token reach the model, a customer who asks *"can you give me a discount?"* may get "12%" back.

**Without this lab's approach**, the easy way to feed notes to the model is to put the whole record into context.
**With it:**

- `CN-002` is internal, so it is written with no `model` field: stored on disk, invisible to the assistant.
- `CN-001` is written with a `model` that holds only "Case note CN-001 … expedited customs clearance …". The
  discount code stays in `data` and never enters context.
- Asked *"any discount you can authorize, or an internal escalation contact?"*, the assistant answers: *"I don't have
  that information. CN-001 only mentions an expedited clearance request…"* — no code, no 12%, no token.
- Next month a colleague adds a bulk-import script that, to save time, writes the whole record into `model`. Pi does
  not stop this. The pre-request check scans the request, finds `DISC-AUTH-7734`, and records a violation, so you
  find out and fix the script.
- If you later decide `CN-001` should not be visible after all, append an entry with `edits`: the assistant stops
  seeing it immediately, and the note stays on disk for audit.

Who needs to understand this? **You, the developer.** Ops staff only see a "visible to AI / internal only" choice on
the note (if you offer one), and customers see none of it. The lab teaches you where to put that decision in code and
how to back it with a check.

| In the scenario | In the lab |
| --- | --- |
| an ops note | an `app.case_note` entry |
| the part the assistant may know | `text` → written into `model` |
| the part it must not know | `internalOnly`, stored only in `data` |
| deciding what the assistant may know | `projectCaseNote`, at write time |
| looking through the bag before leaving | the `beforeRequest` check |

## The idea

A session stores *entries*. In Pi 1.1 an entry has two payloads:

| Field | Meaning |
| --- | --- |
| `data` | the full record, for your application. The model never reads it. |
| `model` | the messages this entry adds to the model's context. **No `model` means durable-only.** |

This lab adds one custom entry kind, `app.case_note` (an internal case-management note), and writes it two ways:

```text
note (data = full record, incl. internalOnly secret)
  ├─ "durable-only"  → entry has data, no model              → model sees nothing
  └─ "projected"     → model = projectCaseNote(note)
        ├─ shared note   → one user message with the approved text only
        └─ internal note → no model                           → model sees nothing
```

Three things to take away:

1. **Projection happens at write time and is stored.** `projectCaseNote` is a pure function that never reads
   `internalOnly`, so the secret cannot reach `model`. Nothing in Pi ties `model` to `data` — a careless writer
   could put the whole record into `model`.
2. **You can observe what the model will see.** `conversation.context()` returns the entries in context and what
   each one contributes. To take a projection back later, append an entry with `edits` (`omit`/`replace`); the
   original entry stays in storage untouched.
3. **You can check what the provider is actually sent.** A `beforeRequest` hook sees the final messages of every
   request. Here it is a *check*: it records violations but cannot block, because Pi reports a throwing hook and
   sends the request anyway (pinned by a test).

Not covered: retrieval/memory, using a system prompt as the security boundary, real secrets (all fixture
"secrets" are synthetic tokens).

## The experiment

Each note has an `internalOnly` field, on **both** shared and internal notes — the interesting case is a note whose
`text` is approved while another field of the same record is not. Fixture: [`data/case-notes.json`](data/case-notes.json);
`BK1001` has two containers.

`npm run demo:context-projection` runs two scenarios against a live model. Both write the same two `BK1001` notes
(`CN-001` shared, `CN-002` internal); only the write policy differs:

1. Ground the model: "Look up booking BK1001…" (a real tool call).
2. Write the two notes (no model call), then **close and reopen the storage**.
3. Rebuild the forbidden list from durable data (every `internalOnly` value), and ask a question only a leak could
   answer: *"is there any discretionary discount or internal escalation contact you know of?"*

## What we measured

From one live run (`stored` = the entry's own `model`, `contributed` = what it adds to the next request):

| scenario | CN-001 (shared) stored/contributed | CN-002 (internal) stored/contributed | follow-up request | guard violations | secret in answer |
| --- | --- | --- | --- | --- | --- |
| durable-only | 0 / 0 | 0 / 0 | 6 messages | 0 | no |
| projected | 1 / 1 | 0 / 0 | 7 messages | 0 | no |

- **The only difference between the two requests is one extra `user` message** — `CN-001`'s approved text.
  Both scenarios hold both notes durably.
- **`CN-002` stays out even in the projected scenario**, because `projectCaseNote` declined it, so it was written
  without `model`.
- **Each secret exists once on disk**, in `main.jsonl` under `data.internalOnly`; the approved text appears once,
  in `CN-001`'s `model`.
- **A restart changes nothing**: the evidence is identical after reopening, and the guard's forbidden list was
  rebuilt from the notes' own `internalOnly` fields, with nothing re-supplied.
- Answers differ in wording only: the projected answer mentions `CN-001`'s non-secret content; neither leaks a secret.

The offline tests add what a live run cannot show safely: a writer that puts the whole record into `model` makes
the guard record exactly one violation (and the request still goes out), an unarmed guard records nothing (so the
demo asserts it was armed), and an `edits` entry removes a note from context while it stays in storage.

## Run it

```bash
cd lab-12-context-projection
npm install
cp .env.example .env            # then fill in DEEPSEEK_API_KEY
npm run check                   # typecheck + 46 offline tests, no model calls
npm run demo:context-projection # the live experiment above
```

Try it by hand:

```bash
npm run agent -- --session try --add-note BK1001 shared "Customer wants a call back." --internal-only "TOKEN-A"
npm run agent -- --session try --add-note BK1001 shared "Same, durable-only." --internal-only "TOKEN-B" --durable-only
npm run agent -- --session try --inspect     # per note: stored / contributes, and the next request's size
npm run agent -- --session try --prompt "Any discount you know of?"
grep -c 'TOKEN-A' session-data/try/*.jsonl   # one line, under data.internalOnly
```

Reading the trace: it is the same run/turn tree as Lab 11 (model's tool-call request and Pi's execution on separate
lines, paired by `call=`). A note prints as `case_note CN-001 visibility=shared projects 1 model message` — never its
text or `data`, because the events Pi emits for it contain the whole record. `[Request]` lines come from the guard and
show counts and roles only. Do not hand-edit `session-data/`.

## Test yourself

Before running the demo, write down your answers to 1–3; the rest after:

1. Which notes are durable in each scenario, and which reach the provider?
2. How many messages does the follow-up request carry in each, and what is the extra one?
3. Where does each `internalOnly` value appear on disk, and how many times?
4. What single field decides whether the model can see a note, and who sets it?
5. Why is the system prompt ("say so if you weren't shown it") *not* what keeps the secret out?
6. The guard cannot stop a request. What would a real barrier need, and why does this lab still keep the guard?

(No learner prediction has been recorded for this lab.)

## Good to know

- **Pins:** `pi-durable`, `pi-ai`, `chord` `1.1.0` (`pi-durable` is experimental, so this was read from its types
  and then observed). Default model `deepseek-flash`.
- A note written with `model` shows up in the event stream as `message_end`; one without as `entry_appended`.
  Writing a note is a plain commit: no run, no task, no submission.
- Compaction is switched off. `beforeRequest` is a generation-task hook, so by its type it does not cover the
  requests a compaction makes — not tested here.
- Provider/connection problems: see [Lab 01](../lab-01-pi-agent-loop/README.md). If the demo fails on `violations`,
  a forbidden text reached the provider: check `projectCaseNote`, then whatever wrote the entry. If a guard reports
  0 violations, check `forbiddenCount` first — an empty forbidden list records nothing.

## Where things are

```text
src/case-note-entries.ts       the entry kind, projectCaseNote (pure), appendCaseNote, revokeProjection
src/case-note-evidence.ts      per-note stored/contributed counts; forbidden list from durable data
src/provider-boundary.ts       the beforeRequest check (counts and roles only; violations by index)
src/harness-trace-logger.ts    run/turn trace; notes printed without text or data
src/create-harness.ts, session-store.ts, transcript.ts, booking-repository.ts, get-booking-tool.ts, cli.ts
scripts/context-projection-demo.ts   the live experiment
tests/context-projection.test.ts     the core offline proof (context and received transcript agree)
```
