import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineExtension,
  GenerationTask,
  Harness,
  hook,
  section,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import { BookingRepository } from "../src/booking-repository.js";
import {
  appendCaseNote,
  CaseNote,
  type CaseNoteData,
  revokeProjection,
} from "../src/case-note-entries.js";
import { SYSTEM_PROMPT } from "../src/create-harness.js";
import { EgressViolationError, WITHHELD } from "../src/egress.js";
import { createGetBookingTool } from "../src/get-booking-tool.js";
import { openSessionStorage } from "../src/session-store.js";
import { listEntries } from "../src/transcript.js";
import { answerTurn, ctx, requestsText, scriptedRuntime, tempSessionsRoot, toolCallTurn } from "./support/scripted-runtime.js";

/**
 * Implementation step 4: a projection/egress contrast, checked where the (faux) provider receives each
 * request — recorded independently of the guards under test. The prohibited synthetic field is a note's
 * `internalOnly` text. Every behavior was observed first; Pi 1.1 changes the design from 0.85.1 (see README).
 */

const SECRET = "SECRET-TOKEN-9931";
const FORBIDDEN = [{ label: "internal-note-secret", value: SECRET }];
const NOTE: CaseNoteData = {
  noteId: "n1",
  bookingNo: "BK1001",
  author: "ops",
  visibility: "shared",
  text: "Customer asked for an update.",
  internalOnly: `discount code ${SECRET}`,
};

type Harnessed = Awaited<ReturnType<typeof scriptedRuntime>>;

/** What a buggy projector does: copies the prohibited field into the model-visible `model` field, bypassing every write-time check. */
async function commitLeakyNote(h: Harnessed): Promise<void> {
  await h.runtime.root.commit(
    (tx) =>
      tx.appendEntry(CaseNote, h.runtime.root.id, {
        data: NOTE,
        model: [{ role: "user", content: [{ type: "text", text: `${NOTE.text} ${NOTE.internalOnly}` }], timestamp: Date.now() }],
      }),
    ctx,
  );
}

const providerSaw = (h: Harnessed, needle: string) => requestsText(h.providerRequests).includes(needle);

describe("projection contrast: correct projector vs leaky entry, no egress check configured", () => {
  it("the shipped projector shows the approved note text and keeps the prohibited field out", async () => {
    const h = await scriptedRuntime();
    await h.runtime.appendCaseNote(NOTE, "projected");
    h.respondWith(answerTurn("ok"));

    const result = await h.runtime.request("req-ok", "Status of BK1001?");

    expect(result.operation.status).toBe("completed");
    expect(providerSaw(h, "Customer asked for an update.")).toBe(true);
    expect(providerSaw(h, SECRET)).toBe(false);
  });

  it("a leaky entry with no egress check sends the prohibited field to the provider — and everything reports success", async () => {
    const h = await scriptedRuntime();
    await commitLeakyNote(h);
    h.respondWith(answerTurn("ok"));

    const result = await h.runtime.request("req-leak", "Status of BK1001?");

    expect(providerSaw(h, SECRET)).toBe(true);
    expect(result.operation.status).toBe("completed");
    expect(result.mechanism).toEqual({ ok: true, problems: [], checked: true }); // nothing in the machinery notices a leak
  });
});

describe("layer 0: write-time check (the projection is decided once, at write)", () => {
  it("refuses to commit a projection that carries a forbidden value; nothing is written", async () => {
    const h = await scriptedRuntime({ egress: { forbidden: FORBIDDEN } });
    const before = (await listEntries(h.runtime.root, ctx)).length;

    // The approved `text` field itself contains the prohibited value: projecting it would put it in `model`.
    await expect(h.runtime.appendCaseNote({ ...NOTE, text: `see ${SECRET}` }, "projected")).rejects.toBeInstanceOf(EgressViolationError);

    expect((await listEntries(h.runtime.root, ctx)).length).toBe(before);
  });

  it("does not refuse a durable-only note: it has no `model`, so nothing can reach a request", async () => {
    const h = await scriptedRuntime({ egress: { forbidden: FORBIDDEN } });

    await h.runtime.appendCaseNote({ ...NOTE, text: `see ${SECRET}` }, "durable-only");

    h.respondWith(answerTurn("ok"));
    await h.runtime.request("req-d", "hello");
    expect(providerSaw(h, SECRET)).toBe(false);
  });
});

describe("layer 1: per-request preflight reads Pi's own committed context", () => {
  it("refuses the request with zero provider requests, names only the label, and leaves the session untouched", async () => {
    const h = await scriptedRuntime({ egress: { forbidden: FORBIDDEN } });
    await commitLeakyNote(h);
    h.respondWith(answerTurn("should never be requested"));
    const before = (await listEntries(h.runtime.root, ctx)).length;

    const result = await h.runtime.request("req-pre", "Status of BK1001?");

    expect(h.faux.state.callCount).toBe(0);
    expect(result.operation.status).toBe("rejected");
    expect(result.operation.errorCode).toBe("egress_violation");
    expect(result.operation.errorMessage).toContain("internal-note-secret");
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.assistantAnswer).toBeUndefined();
    expect(result.correlation.submissionId).toBeUndefined(); // nothing was submitted
    expect(result.mechanism).toEqual({ ok: true, problems: [], checked: true }); // a refused request is the machinery working
    expect((await listEntries(h.runtime.root, ctx)).length).toBe(before);
  });

  it("leaves the harness healthy: the same request is refused again the same way", async () => {
    const h = await scriptedRuntime({ egress: { forbidden: FORBIDDEN } });
    await commitLeakyNote(h);
    h.respondWith(answerTurn("never"));

    const first = await h.runtime.request("req-a", "one");
    const second = await h.runtime.request("req-b", "two");

    expect([first.operation.status, second.operation.status]).toEqual(["rejected", "rejected"]);
    expect(h.faux.state.callCount).toBe(0);
  });

  it("does not interfere when the projector is correct", async () => {
    const h = await scriptedRuntime({ egress: { forbidden: FORBIDDEN } });
    await h.runtime.appendCaseNote(NOTE, "projected");
    h.respondWith(answerTurn("ok"));

    const result = await h.runtime.request("req-fine", "Status of BK1001?");

    expect(result.operation.status).toBe("completed");
    expect(providerSaw(h, SECRET)).toBe(false);
  });

  it("also refuses a prohibited value typed into the prompt itself", async () => {
    const h = await scriptedRuntime({ egress: { forbidden: FORBIDDEN } });
    h.respondWith(answerTurn("never"));

    const result = await h.runtime.request("req-prompt", `Please look up ${SECRET}`);

    expect(result.operation.status).toBe("rejected");
    expect(h.faux.state.callCount).toBe(0);
  });

  it("revoking the entry's projection takes it out of context, and the next request passes — storage keeps the entry", async () => {
    const h = await scriptedRuntime({ egress: { forbidden: FORBIDDEN } });
    await commitLeakyNote(h);
    h.respondWith(answerTurn("ok"));
    expect((await h.runtime.request("req-1", "one")).operation.status).toBe("rejected");

    const leaky = (await listEntries(h.runtime.root, ctx)).find((e) => e.kind === CaseNote.kind)!;
    await revokeProjection(h.runtime.root, leaky.id, ctx);
    const result = await h.runtime.request("req-2", "two");

    expect(result.operation.status).toBe("completed");
    expect(providerSaw(h, SECRET)).toBe(false);
    const stored = (await listEntries(h.runtime.root, ctx)).find((e) => e.id === leaky.id);
    expect(JSON.stringify(stored)).toContain(SECRET); // revoked from context, not erased
  });
});

describe("layer 2: the beforeRequest backstop withholds instead of blocking (preflight omitted)", () => {
  it("still sends the request, but the provider receives the withheld marker, never the value, and the mechanism check fails", async () => {
    const h = await scriptedRuntime({ egress: { forbidden: FORBIDDEN }, omitForContractTest: ["egress-preflight"] });
    await commitLeakyNote(h);
    h.respondWith(answerTurn("ok"));

    const result = await h.runtime.request("req-back", "Status of BK1001?");

    expect(h.faux.state.callCount).toBe(1); // the request is NOT stopped
    expect(providerSaw(h, SECRET)).toBe(false);
    expect(providerSaw(h, WITHHELD)).toBe(true);
    expect(result.operation.status).toBe("completed");
    expect(result.mechanism.ok).toBe(false);
    expect(result.mechanism.problems).toEqual([
      "egress backstop had to withhold prohibited content (internal-note-secret): an upstream layer let it through",
    ]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    // Withholding changes the request only: the durable entry is untouched.
    expect(JSON.stringify(await listEntries(h.runtime.root, ctx))).toContain(SECRET);
  });

  it("is not a per-harness fault: an unrelated later request on the same harness still runs", async () => {
    const h = await scriptedRuntime({ egress: { forbidden: FORBIDDEN }, omitForContractTest: ["egress-preflight"] });
    await h.runtime.appendCaseNote(NOTE, "projected"); // correct projector: nothing to withhold
    h.respondWith(answerTurn("one"), answerTurn("two"));

    const first = await h.runtime.request("req-1", "first");
    const second = await h.runtime.request("req-2", "an unrelated question");

    expect([first.operation.status, second.operation.status]).toEqual(["completed", "completed"]);
    expect([first.mechanism.ok, second.mechanism.ok]).toEqual([true, true]);
  });

  it("scans the system prompt and tool declarations too, because Pi 1.1 puts them inside the request's system message", async () => {
    const phrase = "Keep answers concise";
    expect(SYSTEM_PROMPT).toContain(phrase);
    const h = await scriptedRuntime({ egress: { forbidden: [{ label: "prompt-phrase", value: phrase }] } });
    h.respondWith(answerTurn("ok"));

    // Preflight cannot see it (the system entry is written when the run starts); the backstop does.
    const result = await h.runtime.request("req-sys", "hello");

    expect(providerSaw(h, phrase)).toBe(false);
    expect(result.mechanism.problems).toEqual([
      "egress backstop had to withhold prohibited content (prompt-phrase): an upstream layer let it through",
    ]);
  });
});

describe("what no layer can stop: a value that first enters the conversation mid-run", () => {
  it("a tool result carrying a forbidden value is withheld from the next request, but the request is still sent — preflight could not have seen it", async () => {
    const container = "MSKU1234567"; // inside BK1001's get_booking result; not in the prompt or in any committed entry yet
    const h = await scriptedRuntime({ egress: { forbidden: [{ label: "container-number", value: container }] } });
    h.respondWith(toolCallTurn("get_booking", { bookingNo: "BK1001" }, "call-1"), answerTurn("ok"));

    const result = await h.runtime.request("req-mid", "Status of BK1001?");

    expect(result.operation.status).toBe("completed");
    expect(h.faux.state.callCount).toBe(2); // not zero: the first request was clean, the second carried the tool result
    expect(providerSaw(h, container)).toBe(false);
    expect(providerSaw(h, WITHHELD)).toBe(true);
    expect(result.mechanism.problems).toEqual([
      "egress backstop had to withhold prohibited content (container-number): an upstream layer let it through",
    ]);
    expect(JSON.stringify(await listEntries(h.runtime.root, ctx))).toContain(container); // durable entry untouched
  });
});

describe("why the backstop withholds: a hook that throws cannot stop a request", () => {
  it("an exception from a beforeRequest hook is reported and the request is sent anyway, prohibited content included", async () => {
    const reports: string[] = [];
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "booking",
        tools: [createGetBookingTool(BookingRepository.fromDefaultFixture())],
        sections: [section("preamble", () => SYSTEM_PROMPT, { tag: false })],
      }),
    );
    registry.install(
      defineExtension({
        name: "throwing-guard",
        hooks: [
          hook(GenerationTask, {
            beforeRequest: (request) => {
              if (JSON.stringify(request.messages).includes(SECRET)) throw new Error("egress check inside a hook");
              return undefined;
            },
          }),
        ],
      }),
    );
    const seen: string[] = [];
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      (context) => {
        seen.push(JSON.stringify(context.messages));
        return answerTurn("ok");
      },
    ]);
    const sessionsRoot = await tempSessionsRoot();
    const { storage } = await openSessionStorage(sessionsRoot, "hook-only", ctx);
    const harness = await Harness.open(
      storage,
      { models, registry, settings: { compaction: { enabled: false, backgroundTokens: 0 } }, onReport: (e) => reports.push(String((e as Error).message)) },
      ctx,
    );
    const model = faux.getModel();
    const root = await harness.root(ctx, { agent: { model: { provider: model.provider, modelId: model.id } } });

    const settled = await (await root.submit({ type: "input", content: `my ${SECRET}` }, ctx)).wait(ctx);

    expect(settled.status).toBe("done");
    expect(reports).toEqual(["egress check inside a hook"]);
    expect(seen.join()).toContain(SECRET); // the request went out with the value
    await harness.close(ctx);
  });
});

describe("the egress configuration is application config, not session state", () => {
  it("a reopen that omits it leaks; the same reopen with it refuses", async () => {
    const first = await scriptedRuntime({ sessionId: "s-egress", egress: { forbidden: FORBIDDEN } });
    await commitLeakyNote(first);
    await first.runtime.close();

    const unguarded = await scriptedRuntime({ sessionId: "s-egress", sessionsRoot: first.sessionsRoot });
    unguarded.respondWith(answerTurn("ok"));
    await unguarded.runtime.request("req-unguarded", "Status of BK1001?");
    expect(providerSaw(unguarded, SECRET)).toBe(true);
    await unguarded.runtime.close();

    const guarded = await scriptedRuntime({ sessionId: "s-egress", sessionsRoot: first.sessionsRoot, egress: { forbidden: FORBIDDEN } });
    guarded.respondWith(answerTurn("never"));
    const result = await guarded.runtime.request("req-guarded", "Status of BK1001?");
    expect(result.operation.status).toBe("rejected");
    expect(guarded.faux.state.callCount).toBe(0);
    await guarded.runtime.close();
  });

  it("the projection, by contrast, IS session state: a reopen shows the model the stored projection, with no projector installed", async () => {
    const first = await scriptedRuntime({ sessionId: "s-proj" });
    await appendCaseNote(first.runtime.root, NOTE, "projected", ctx);
    await first.runtime.close();

    const second = await scriptedRuntime({ sessionId: "s-proj", sessionsRoot: first.sessionsRoot });
    second.respondWith(answerTurn("ok"));
    await second.runtime.request("req-p", "Status of BK1001?");

    // In 0.85.1 the projector ran at read time, so a reopen without it made the note invisible. In 1.1 the
    // projection was computed at write time and stored; there is nothing to re-install.
    expect(providerSaw(second, "Customer asked for an update.")).toBe(true);
    expect(providerSaw(second, SECRET)).toBe(false);
    await second.runtime.close();
  });
});
