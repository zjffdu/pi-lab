# Lab 11 — Session Tree and Navigation

English | [中文](README.zh-CN.md)

**Question:** when you go back to an earlier point in a conversation and change a premise, what happens to the
conversation you left?
**Answer this lab shows:** nothing. Going back is a `fork`, and a fork is a **second conversation in the same
storage**:

- **The fork shares history up to the fork point.** It sees the parent's entries up to and including that one,
  and nothing the parent adds afterwards.
- **Each conversation is a branch with its own tip.** Both stay open, both accept prompts, both survive a restart,
  and neither ever sees the other's later turns.

Think of copying a document at one paragraph, then editing the copy: the original is untouched, and the copy starts
with everything up to that paragraph.

## A concrete scenario

An operations agent is looking into booking `BK1001` (vessel `MAERSK TEST`, two containers). Three questions in, the
customer says: *"sorry, I meant `BK1002`."*

- **Without this approach**, you either carry on in the same transcript — the model now has BK1001's vessel and
  containers sitting next to BK1002's and may mix them — or you discard the BK1001 investigation.
- **With it**, you fork right after the first BK1001 answer. The new conversation has the BK1001 lookup (shared) and
  then BK1002's lookup (its own). The old conversation still has the container-events turn and the risk call. Ask
  both *"which vessel are we discussing?"*: one says `MAERSK TEST`, the other `MAERSK SECOND`.
- Tomorrow the process restarts. Both conversations are still there, found by id, and the fork carries on.

Who needs to understand this? **You, the developer.** The user only notices that "start over from there" does not
lose the earlier work.

| In the scenario | In the lab |
| --- | --- |
| the BK1001 investigation | the root conversation |
| "go back to after the first answer" | `fork(entryId)` at that entry |
| "I meant BK1002" | the fork's own first turn |
| a bookmark on that first answer | a label (app-level, see below) |
| two cases that must not mix | two conversations, each sending only its own ancestry |

## The idea

```text
  conversation A:  … ── entry [labeled] ── entry … ── entry …   (tip)
                              │
  conversation B:             └── entry … ── entry …            (tip)
```

| Piece | What it is |
| --- | --- |
| conversation | a transcript of entries; here, one branch |
| `fork(entryId)` | a new conversation that inherits entries up to `entryId`; its `ConversationRecord.parent` is `{ conversationId, at }` |
| tip | the newest entry a conversation can see — **not** a stored pointer, and one per conversation |
| `head` | where the model's *context* starts after a reset or compaction — **not** a branch marker |

Three takeaways:

1. **A branch is a conversation.** "Switching branches" means picking another conversation id; there is no movable tip.
2. **Inherited entries are stored once.** A fork's `entries()` lists them first, still carrying the parent's
   `conversationId`; its own entries carry its own. That one field is how the tree is drawn.
3. **Isolation is provable without a model.** A scripted model can record the exact messages each branch's next
   request carries.

Labels are application state: a small document mapping an entry id to a name ([`src/labels.ts`](src/labels.ts)).
They never enter a transcript, so the model never sees them. Not covered: merging branches, summarizing an
abandoned branch, and compaction (it is switched off here).

## The experiment

`npm run demo:session-tree` runs one live session:

1. Ask about `BK1001`, label that answer, then ask for the events of both containers and for a risk call (root).
2. Preview what a fork at the labeled entry would start with (nothing is created).
3. Fork there and ask for `BK1002` instead (the fork).
4. Ask both conversations the identical question: which vessel and which containers.
5. Close the process, reopen the storage, and keep working in the fork.

## What we measured

From one live run:

| Check | Result |
| --- | --- |
| conversations / tips after the fork | 2 / 2 (`c1:30`, `c31:44`) |
| entries the fork inherited | 5 (entries 7, 10, 11, 13, 15), all with the root's `conversationId` |
| root entries after forking and after the fork continued | byte-for-byte unchanged |
| root's answer | `MAERSK TEST`, `MSKU1234567`, `MSKU2345678`; no BK1002 fact |
| fork's answer | `MAERSK SECOND`, `MSKU7654321`; no BK1001 fact |
| after restart | both conversations found, fork's `parent` intact, fork answers `SGSIN` |

- The offline tests check the same isolation on what each request **carries**, not on what the model says.
- Entry ids interleave across branches (the root has 17–30, then 45–48, around the fork's 37–44), so ids do not
  say which branch an entry is in; `conversationId` does.
- In `main.jsonl` a fork is one record, `{"type":"conversation","value":{"id":31,"parent":{"conversationId":1,"at":15}}}`.
  Entries have no `parentId` and the inherited ones are not copied.

## Run it

```bash
cd lab-11-session-tree
npm install
cp .env.example .env            # then fill in DEEPSEEK_API_KEY
npm run check                   # typecheck + 48 offline tests, no model calls
npm run demo:session-tree       # the live experiment above
```

Try it by hand (the first command calls the model; entry ids come from `--inspect`, and were 15 in a recorded run):

```bash
npm run agent -- --session try --prompt "Look up booking BK1001 and tell me its route, vessel, and containers."
npm run agent -- --session try --inspect                 # the tree: conversations, entries, tips
npm run agent -- --session try --preview 15              # what a fork at entry 15 would start with
npm run agent -- --session try --fork 15                 # prints: [Fork] conversation N forked from conversation 1 at entry 15
npm run agent -- --session try --label 15 "after-lookup" # a label, shown as [label="after-lookup"] in the tree
npm run agent -- --session try --prompt "Which vessel is this?" --conversation N
npm run agent -- --session try --fork 999999             # [Fatal] Entry 999999 is not visible from conversation 1
```

Reading the trace: the same run/turn tree as the earlier labs. Each conversation has its own logger and its lines are
tagged `[c1]`, `[c31]`. Creating a fork emits no event, so the CLI and demo print the `[Fork]` line themselves. Do not
hand-edit `session-data/`.

## Test yourself

Write down your answers to 1–4 before running the demo; the rest after:

1. After forking at the labeled entry and continuing, how many conversations and tips are there?
2. Which entries does the fork contain before it adds any, and which field says they were inherited?
3. Does anything in the root change when the fork continues? When the root continues afterwards?
4. What vessel and containers does each conversation name for "the booking we are discussing"?
5. Why are the two ids interleaved, and what actually draws the tree?
6. Why can the offline test prove isolation more strongly than the live answer?

(No learner prediction has been recorded for this lab.)

## Good to know

- **Pins:** `pi-durable`, `pi-ai`, `chord` `1.1.0` (`pi-durable` is experimental, so this was read from its types
  and then observed). Default model `deepseek-flash`.
- `fork(at)` accepts the end of a turn, a tool result, and the parent's newest entry. It also accepts the assistant
  entry that *requested* a tool call; the fork then inherits a call with no result, and its context adds a synthetic
  `toolResult`. It rejects an unknown id or another conversation's entry: `Entry N is not visible from conversation M`.
  All of this is pinned by tests. Forking a parent that is busy mid-run was not established.
- `scanConversations` is on `Storage`, not on `Harness`; the tools work after a restart only because
  `openHarness` installs the registry again — a conversation stores extension names, not code.
- Provider/connection problems: see [Lab 01](../lab-01-pi-agent-loop/README.md). If a live isolation assertion fails,
  read the offline request-capture test first: it shows what each branch was actually sent.

## Where things are

```text
src/branches.ts          forkAt, listConversationRecords, loadBranches
src/tree-view.ts         pure: own/inherited entries, tips, describeFork, renderTree
src/labels.ts            application-state labels (a Session-scoped document)
src/transcript.ts        listEntries (fork-aware, paged), summarizeEntry
src/harness-trace-logger.ts   one tagged run/turn/tool tree per conversation
src/create-harness.ts, session-store.ts, booking-repository.ts, get-*-tool.ts, cli.ts
scripts/session-tree-demo.ts  the live experiment
tests/navigation-mechanics.test.ts   the core offline proof (inheritance, isolation, restart, labels)
```
