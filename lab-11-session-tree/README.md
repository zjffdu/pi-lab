# Lab 11 — Session Tree and Navigation

Labs 07-10 proved that a durable session keeps a complete record of everything that happened,
and that "durable history" and "what the model sees next" are two different things. Both labs
still only ever moved forward, on one line. This lab asks what happens when the learner goes
*back*: it navigates to an earlier entry, continues with a changed premise, and proves that
Pi keeps both continuations as addressable, independent branches of one tree — neither one
overwrites the other, and each one only ever sees its own ancestry.

## Learning objective

By the end of this lab, you can explain this from your own console output and evidence:

```text
entry A -> entry B -> entry C
                  \
                   -> entry D -> entry E

one session tree, two branch tips, no overwritten history
```

This lab extends [Lab 10](../lab-10-context-compaction/README.md)'s `Session -> AgentHarness ->
lane("main")` stack with one new operation kind, `navigateTree()`, and one new entry type,
`branch_summary`. It does **not** cover `SessionRepo.fork()` (a genuinely separate session
file), collaborative editing or branch merging, compaction tuning beyond what Lab 10 already
established, or UI tree rendering.

## Vocabulary (read before predicting)

- **`AgentLane.navigateTree(targetId, options, context): Promise<NavigationResult>`** — moves
  the lane's own tip pointer. `targetId` is an entry id, or `null` for the tree's root.
  `options?: { summarize?: boolean; label?: string; customInstructions?: string }`. Unsummarized
  navigation (`summarize` omitted or `false`) is pure and synchronous under the hood: it never
  calls a model, it only writes the new `branchTip(lane.name)` pointer and, if `label` is given,
  an `entryLabel` value. Summarized navigation (`summarize: true`) does call a model, once, to
  generate a `BranchSummaryEntry` at the new tip.
- **Branch tip** — a leaf: an entry id that no other entry names as its `parentId`. There is no
  dedicated "list every tip" API; [`src/tree-view.ts`](src/tree-view.ts)'s `findBranchTips()`
  computes it directly from the whole entry set, the same way this README's diagrams do.
- **`Session.findEntries()` vs. `AgentLane.findEntries()`** — `AgentLane.findEntries()` defaults
  its `start` to the lane's *own current tip* and walks backward through `parentId`: it is an
  ancestry view of one branch. `Session.findEntries()` (no lane involved) scans every entry the
  storage backend has ever written, across every branch, in one call. This lab's tree diagrams
  and `findBranchTips()` both use the whole-tree `Session` view; only the ancestry-narrowing
  behavior itself is proven the other way, in `tests/navigation-mechanics.test.ts`.
- **`BranchSummaryEntry`** (`{ type: "branch_summary", fromId, summary, usage, fromHook }`) —
  the one new durable entry type a *summarized* navigation appends. `fromId` is the tip that was
  abandoned by the navigation (not necessarily the branch's very first entry); `parentId` is the
  navigation's target, same as an unsummarized navigation's new tip would have been.
- **`harness.getLabel(targetId, context)` / `harness.setLabel(targetId, label, context)`** — a
  label is a separate, named durable value keyed by entry id, independent of navigation. A label
  can be written directly with `setLabel`, or as a side effect of `navigateTree({ label })`.
- **Rejections** — `navigateTree()` returns `Result`, not a thrown error, for invalid requests:
  `InvalidNavigation` with `reason` `"current_tip"` (target already the tip), `"root_label"`
  (labeling `null`), `"target_root"` (summarizing into root), or `"source_root"` (summarizing
  away from a `null` current tip); `UnknownTarget` for an id the session has never seen.

## Prerequisites

- Node.js 24.5 or newer
- npm
- Credentials for a model provider supported by `@earendil-works/pi-ai`

The default configuration uses DeepSeek V4 Flash through the official DeepSeek API, same as
every earlier lab.

## API note (revalidated against the pinned version)

Same pin as Labs 07-10: `@earendil-works/pi-agent-core@0.85.1`. Reverse-engineered from
`node_modules/@earendil-works/pi-agent-core/dist/harness/**/*.d.ts`:

- `AgentLane.navigateTree(targetId: string | null, options: NavigateOptions | undefined,
  context): Promise<NavigationResult>`, where `NavigationResult = Result<{ navigation:
  OperationResultRecord; run?: OperationResultRecord | SuspendedRun }, LaneBusy |
  InvalidNavigation | UnknownTarget | Closed>`.
- `NavigateOptions = { summarize?: boolean; label?: string; customInstructions?: string }`
  (`harness/agent-harness.d.ts`).
- `Entry = MessageEntry | CompactionEntry | BranchSummaryEntry | CustomEntry`
  (`harness/session/types.d.ts`) — `BranchSummaryEntry` carries `fromId: string | null`,
  `summary: string`, and the same optional `usage`/`fromHook` fields `CompactionEntry` has.
- `AgentHarness.getLabel` / `setLabel` (`harness/agent-harness.d.ts`) are plain async
  get/set against a durable value store keyed by entry id — not part of the `Entry` union
  itself.
- The harness's event stream emits `navigation_start` / `navigation_end` around every
  `navigateTree()` call, mirroring `run_start`/`run_end` and Lab 10's
  `compaction_start`/`compaction_end` — see [`src/harness-trace-logger.ts`](src/harness-trace-logger.ts).

## 1. Predict before running

The roadmap's standard gate asks for a written prediction before each new piece of navigation
behavior. This lab registers its predictions as `console.log` calls in
[`scripts/session-tree-demo.ts`](scripts/session-tree-demo.ts) *before* the corresponding
`navigateTree()` call executes — not written after the fact. The three predictions actually
made, verbatim from that run's own log:

> **Before Step 3** — `navigateTree(branchPointId)` should move only the lane's tip pointer back
> to the branch point; it must not delete either of branch A's later entries, and the next
> prompt should parent off the branch point, not off the current branch-A tip.

> **Before Step 5** — switching to branch A's tip and asking "which vessel" should answer
> MAERSK TEST (BK1001); switching to branch B's tip and asking the exact same question should
> answer MAERSK SECOND (BK1002) — each branch must only see its own ancestry, not the other
> branch's tool result.

> **Before Step 7** — `navigateTree(branchPointId, { summarize: true })` from branch B's current
> tip should generate one new `branch_summary` entry — parented at the branch point, with
> `fromId` pointing at branch B's abandoned tip — and make *that* new entry the tip, instead of
> moving the pointer directly to the branch point.

All three were confirmed exactly as predicted; see section 4.

## 2. Install dependencies

```bash
cd lab-11-session-tree
npm install
cp .env.example .env   # then fill in DEEPSEEK_API_KEY
```

## 3. Verify the deterministic parts

```bash
npm run check
```

This is `tsc --noEmit` plus Vitest across the booking and container-event repositories, session
lifecycle, environment/model parsing, `tree-view.ts`'s tip/render helpers, and — the core of this
lab — `tests/navigation-mechanics.test.ts` (10 tests). Recorded run: **6 files, 24 tests, all
passing.**

`navigation-mechanics.test.ts` is a deliberately **network-free** proof of `navigateTree()`
itself. The *unsummarized* path never calls a model — it only moves a durable pointer — so it is
seeded directly with `lane.appendMessage()` (same premise Lab 07-10's durability tests use) and
proven without any live request:

- Navigating back moves the lane's tip and does not delete anything from the whole tree
  (`Session.findEntries()` stays at the same length and same ids), even though the lane's own
  *ancestry view* (`AgentLane.findEntries()`) from the new tip is now shorter.
- A new turn appended after navigating parents off the new tip, creating a second leaf beside
  the untouched original one — the branch point ends up with two children.
- `navigateTree({ label })` persists a label readable via `harness.getLabel()`; `setLabel`/
  `getLabel` also work independently of navigation.
- Navigating to `null` (root) is valid, moves the tip to `null`, and lets a following turn start
  a second, independent root.
- All four `InvalidNavigation`/`UnknownTarget` rejections in the vocabulary section are asserted
  by id and by `reason`.
- The *summarized* path's pure, synchronous pre-flight validation (`target_root`, `source_root`)
  is proven here too; generating the actual `BranchSummaryEntry` text needs a real model, so that
  one live call lives only in `scripts/session-tree-demo.ts`, not in this test file.

## 4. Run the session-tree demo (live evidence)

```bash
npm run demo:session-tree
```

Trimmed to the load-bearing lines from one recorded run:

```text
=== Step 1: seed the shared ancestry both branches will fork from ===
[User] Look up booking BK1001 and tell me its route and vessel.
[Assistant] Booking BK1001: CNSHA -> NLRTM, vessel MAERSK TEST, dep 2026-09-10, arr 2026-10-15,
container MSKU1234567.

=== Step 2: continue forward into a completed investigation on branch A ===
[User] Check the container movement events for MSKU1234567 and summarize them in one sentence.
[Assistant] Container MSKU1234567 gated in at CNSHA on 2026-09-09 22:15Z, was loaded on
2026-09-10 14:30Z, and departed CNSHA on 2026-09-10 15:00Z — with no discharge or gate-out
events recorded yet.
[User] Given what you know so far, is this booking on schedule or at risk? Answer in one sentence.
[Assistant] ... its current status isn't determinable: the only events shown are through
departure from CNSHA, with no arrival, discharge, or later milestones to compare against the
planned arrival.

[Tree] after branch A: entries=10 tips=<branchATipId>
(exactly one tip — the whole tree is still one linear branch, as asserted)

=== Step 3: predict, then navigate back to the branch point ===
[Prediction] navigateTree(branchPointId) should move only the lane's tip pointer back ...
[Harness] navigation_start target=<branchPointId>
[Harness] navigation_end status=completed fromTip=<branchATipId> tip=<branchPointId>
(entriesAfterNav === entriesAfterBranchA: 10 === 10 — unsummarized navigation added nothing)
(harness.getLabel(branchPointId) === "after-bk1001-lookup" — the label persisted)

=== Step 4: continue with a changed premise — this forks branch B off the same branch point ===
[User] Actually, I made an error — the booking we should be discussing is BK1002, not BK1001.
Look it up and tell me its route and vessel.
[Assistant] Booking BK1002: SGSIN (Singapore) -> USLAX (Los Angeles), vessel MAERSK SECOND,
dep 2026-09-12, arr 2026-10-02, container MSKU7654321.

[Tree] after branch B forks: entries=14 tips=<branchATipId>, <branchBTipId>
- seq=4  ... user: (BK1001 lookup)
  - seq=36 ... assistant: I'll look that up now.
    - seq=46 ... toolResult
      - seq=128 ... assistant: Booking BK1001 ... [label="after-bk1001-lookup"]
        - seq=137 ... user: (container events question)              <- branch A
          - ... -> seq=333 ... assistant: ... isn't determinable [TIP]
        - seq=351 ... user: (BK1002 correction)                      <- branch B
          - ... -> seq=467 ... assistant: Booking BK1002 ... [TIP, ACTIVE]
(the branch point now has exactly two children — branch A's and branch B's)

=== Step 5: contrast — ask the identical follow-up from each branch's own tip ===
[Prediction] branch A should answer MAERSK TEST; branch B should answer MAERSK SECOND; neither
should leak the other's vessel.
[User] (navigated to branch A's tip) Which vessel is the booking we are currently discussing on?
[Assistant] MAERSK TEST.
[User] (navigated to branch B's tip) Which vessel is the booking we are currently discussing on?
[Assistant] MAERSK SECOND.

┌─────────┬──────────────┬──────────────────┬────────────────────┬─────────────────────┐
│ (index) │ branch       │ answer            │ mentionsOwnVessel  │ mentionsOtherVessel  │
├─────────┼──────────────┼──────────────────┼────────────────────┼─────────────────────┤
│ 0       │ 'A (BK1001)' │ 'MAERSK TEST.'    │ true               │ false                │
│ 1       │ 'B (BK1002)' │ 'MAERSK SECOND.'  │ true               │ false                │
└─────────┴──────────────┴──────────────────┴────────────────────┴─────────────────────┘

=== Step 6: switching branches again proves neither continuation was overwritten ===
[Tree] final: entries=18 tips=<new A leaf>, <new B leaf>
(both branch A's and branch B's ORIGINAL tips are still present as durable entries — they are
just no longer leaves, since each grew a contrast-question child)

=== Step 7 (bonus): one summarized-navigation experiment ===
[Prediction] navigateTree(branchPointId, {summarize:true}) from branch B's current tip should
generate one new branch_summary entry, parented at the branch point, fromId = branch B's
abandoned tip, and become the new tip itself.
[Harness] navigation_start target=<branchPointId>
[Entry] id=<summaryId> parent=<branchPointId> seq=552 type=branch_summary
[Harness] navigation_end status=completed fromTip=<branchB leaf> tip=<summaryId>
[BranchSummary] fromId=<branchB leaf> parentId=<branchPointId>
[BranchSummary] summary="The user explored a different conversation branch before returning
here. Summary of that exploration: ## Goal Look up booking BK1002 (user corrected from BK1001)
and identify its route and vessel. ..."
[Tree] after summarized navigation: entries=19 tips=<A leaf>, <B leaf>, <summaryId>

=== All Lab 11 session-tree assertions passed ===
```

## 5. Findings worth reading closely

**Finding A — unsummarized navigation is purely a pointer move; it never mutates the tree.**
`entriesAfterBranchA=10` and `entriesAfterNav=10` are identical: navigating back to the branch
point added zero entries. Everything about "going back" happened entirely in a separate
`branchTip` pointer, not in the entry log.

**Finding B — a changed premise after navigating forks a real, second branch, not a rewrite.**
Continuing from the branch point with "Actually, I made an error — it's BK1002, not BK1001"
grew the tree from 10 to 14 entries and gave the branch point exactly two children. Branch A's
four entries (the container-events question and risk assessment) are untouched at their
original sequence numbers; branch B's four new entries are simply new, sibling entries with the
same `parentId`. There is exactly one entry set here, not two competing histories.

**Finding C — each branch's context is genuinely isolated, not merely labeled differently.**
The contrast question — the identical sentence, "Which vessel is the booking we are currently
discussing on?" — got a different, *correct*, non-leaking answer from each tip: MAERSK TEST from
branch A, MAERSK SECOND from branch B, with neither answer mentioning the other vessel. Nothing
in the prompt names a booking; the only thing that could have produced this is
`AgentLane.findEntries()`'s ancestry walk actually differing depending on which tip the lane's
pointer is currently on.

**Finding D — asking a question from an old tip does not "erase" it as a branch; it extends it.**
After step 5, branch A's and branch B's *original* tips (the risk-assessment answer and the
BK1002 lookup answer) are no longer leaves — each grew a one-turn child from the contrast
question. That is expected, and the assertions distinguish it explicitly from deletion: both
original entries are still present in the 18-entry tree, `finalEntries.length >
entriesAfterBranchB.length` (18 > 14), and the *new* leaves are what `findBranchTips()` now
reports.

**Finding E — a summarized navigation is a real, model-generated durable entry, not a
same-as-unsummarized shortcut.** `navigateTree(branchPointId, { summarize: true })` from branch
B's tip added exactly one new entry (19 = 18 + 1): a `branch_summary` entry parented at the
branch point, with `fromId` equal to the tip that was abandoned (branch B's contrast-answer
leaf), and its own generated tip. Both branch A's and branch B's original tip entries are still
present afterward, unmodified — summarization compresses what a *future* request would see if it
continued from the summary; it does not delete or rewrite the history it summarizes.

## 6. Inspect the evidence directly

```bash
find session-data -name '*.jsonl' | sort
```

Confirm by eye, on the demo's session file:

- The branch point entry (seq 128, the BK1001 lookup's final assistant message) has an
  `entryLabel` value of `"after-bk1001-lookup"`, and exactly two other entries in the file name
  it as their `parentId` — branch A's `seq=137` and branch B's `seq=351`.
- Every entry from both branches — including the ones that stopped being tips once a contrast
  question grew a new child under them — is still present at its original `seq`, byte for byte.
- The one `type: "branch_summary"` entry (`seq=552`) carries a `fromId` matching branch B's
  abandoned tip's id, not the branch point's id and not `null`.

Do not hand-edit these files. Delete `session-data/` and rerun `npm run demo:session-tree` for a
fresh, fully reproducible run — wording will vary turn to turn (this is a live model), but the
entry counts, the two-tips-after-forking property, and the per-branch answer isolation are
stable.

## 7. Explain the trace

Answer using your own terminal output:

1. `entriesAfterNav` in step 3 equals `entriesAfterBranchA` exactly. What does that tell you
   about where "the current position in the conversation" actually lives, if it is not stored as
   part of any entry?
2. Step 4 forked branch B by continuing after an unsummarized navigation. What in the durable
   entry set — not the console log — is the one piece of evidence that a fork happened, rather
   than branch A's history being edited in place?
3. Section 5's Finding C showed the same question producing two different, correct, non-leaking
   answers. Which specific API call, made differently between the two askings, is responsible
   for that — and what would you expect to happen if you asked the same question again *without*
   navigating in between?
4. Finding D distinguishes "no longer a tip" from "deleted." Why does this distinction matter
   for a learner who wants to trust that going back and trying something else is safe?
5. A summarized navigation (step 7) and an unsummarized one both move the lane's tip and both
   leave every prior entry untouched. Name the one concrete difference in what gets written to
   the session, and the one concrete difference in what a *future* request from the new tip
   would send to the model.
6. This lab explicitly excludes `SessionRepo.fork()`. Using only what you now know about
   `Session`, `AgentLane`, and branch tips, explain in your own words how a forked *session*
   (a separate file, from `fork()`) would differ from the two branches this lab created inside
   one session.

## Completion criteria

- `npm run check` passes: repositories, session lifecycle, environment parsing, and the
  network-free navigation-mechanics tests proving `navigateTree()`'s pointer-move mechanism,
  label behavior, root handling, and all four rejection cases directly (24/24 passing in the
  recorded run).
- `npm run demo:session-tree` passes its own assertions on a live run: navigating back adds zero
  entries; continuing with a changed premise forks the tree to exactly two tips with two
  children under the branch point; asking the identical follow-up from each tip produces two
  different, non-leaking answers; both original branch tips remain present (as non-leaf
  ancestors) after being extended; one summarized navigation adds exactly one `branch_summary`
  entry with the correct `parentId`/`fromId`.
- Navigation creates an alternative continuation without deleting the original one (Finding A/B).
- Both branches remain addressable, by tip id, throughout the run (step 5 navigates to each by
  id and gets the expected, branch-specific answer).
- Branch-specific prompts see only the expected ancestral context (Finding C — no cross-branch
  leakage in either direction, in the recorded run).
- The learner can distinguish session (the whole entry store), lane (one named pointer plus its
  operation queue), branch (an ancestry path to some tip), and a separate forked session (not
  built in this lab; see question 6) — see section 7.

## Project map

```text
src/booking-repository.ts             Lab 05/07-10's fixture repository (own copy)
src/container-event-repository.ts     Lab 04/08-10's fixture repository (own copy)
src/get-booking-tool.ts               Read-only, replay: "safe" — a durable tool result is what
                                       makes each branch's booking facts something the contrast
                                       case can verify per branch
src/get-container-events-tool.ts      Read-only, replay: "safe", no artificial delay — this lab
                                       is not exercising crash recovery
src/session-store.ts                  JsonlSessionRepo wiring + create-or-reopen-by-id
src/create-harness.ts                 Model selection, both read-only tools, no compaction
                                       tuning (the harness's default keepRecentTokens never
                                       triggers on this lab's short seeded conversations)
src/harness-trace-logger.ts           Indented tree logger; "run" and "navigation" are
                                       sibling top-level spans, neither nested in the other
src/tree-view.ts                      findBranchTips(), childrenOf(), and renderTree() — the
                                       whole-tree diagrams this README's evidence is built from
src/cli.ts                            One invocation = one turn (--prompt), one navigation
                                       (--navigate [--label] [--summarize]), one label write
                                       (--set-label), or one read-only inspection (--inspect)
scripts/session-tree-demo.ts          The live-model experiment: seeds a shared ancestry, forks
                                       a second branch after navigating back, asks an identical
                                       contrast question from each tip, then runs one summarized
                                       navigation — asserts and prints the evidence at each step
data/bookings.json                    Same fixture as Lab 05/07-10
data/container-events.json            Same fixture as Lab 04/08-10
session-data/                         Durable JSONL sessions this lab writes (git-ignored)
tests/                                Deterministic, network-free tests — including
                                       navigation-mechanics.test.ts, the core proof
```

## Troubleshooting

See [Lab 01](../lab-01-pi-agent-loop/README.md) for model/provider connection issues — they
apply unchanged here, including the `--use-env-proxy` requirement baked into `npm run agent`
and `npm run demo:session-tree`.

If the contrast step (section 4, step 5) answers with the wrong vessel or mentions both, check
that navigation actually completed (`navigation_end status=completed` with the expected `tip=`)
before the follow-up prompt ran — a live model's own answer wording varies run to run, but which
booking it can even see should not, since that is determined entirely by the lane's tip at the
moment the prompt is queued.

If `npm run demo:session-tree` fails asserting `entriesAfterSummary.length === finalEntries.length
+ 1`, delete `session-data/` and rerun: a stale session directory from an interrupted previous
run can leave the lane's tip pointing somewhere the new run does not expect.
