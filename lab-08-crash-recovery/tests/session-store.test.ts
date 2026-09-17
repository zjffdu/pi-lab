import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BACKGROUND_CONTEXT, createSessionRepo, openOrCreateSession } from "../src/session-store.js";

const CWD = "lab-08-test-group";

let sessionsRoot: string;

beforeEach(async () => {
  sessionsRoot = await mkdtemp(join(tmpdir(), "pi-lab-08-"));
});

afterEach(async () => {
  await rm(sessionsRoot, { recursive: true, force: true });
});

describe("openOrCreateSession", () => {
  it("creates a session on first use and reopens the same one by id afterward", async () => {
    const repo = createSessionRepo(sessionsRoot);

    const first = await openOrCreateSession(repo, "conversation-a", CWD, BACKGROUND_CONTEXT);
    expect(first.created).toBe(true);
    expect(first.session.metadata.id).toBe("conversation-a");

    await first.session.setName("labeled-by-first-open", BACKGROUND_CONTEXT);
    await first.session.close(BACKGROUND_CONTEXT);

    const second = await openOrCreateSession(repo, "conversation-a", CWD, BACKGROUND_CONTEXT);
    expect(second.created).toBe(false);
    expect(second.session.metadata.id).toBe("conversation-a");
    // Same underlying JSONL file: the name set before closing is still there.
    await expect(second.session.getName(BACKGROUND_CONTEXT)).resolves.toBe("labeled-by-first-open");

    await second.session.close(BACKGROUND_CONTEXT);
  });

  it("gives two different session ids their own independent files", async () => {
    const repo = createSessionRepo(sessionsRoot);

    const a = await openOrCreateSession(repo, "conversation-a", CWD, BACKGROUND_CONTEXT);
    const b = await openOrCreateSession(repo, "conversation-b", CWD, BACKGROUND_CONTEXT);

    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.session.metadata.path).not.toBe(b.session.metadata.path);

    await a.session.setName("name-a", BACKGROUND_CONTEXT);
    await b.session.setName("name-b", BACKGROUND_CONTEXT);

    await expect(a.session.getName(BACKGROUND_CONTEXT)).resolves.toBe("name-a");
    await expect(b.session.getName(BACKGROUND_CONTEXT)).resolves.toBe("name-b");

    await a.session.close(BACKGROUND_CONTEXT);
    await b.session.close(BACKGROUND_CONTEXT);
  });

  it("lists every session created under one cwd group", async () => {
    const repo = createSessionRepo(sessionsRoot);

    const a = await openOrCreateSession(repo, "conversation-a", CWD, BACKGROUND_CONTEXT);
    await a.session.close(BACKGROUND_CONTEXT);
    const b = await openOrCreateSession(repo, "conversation-b", CWD, BACKGROUND_CONTEXT);
    await b.session.close(BACKGROUND_CONTEXT);

    const listed = await repo.list({ cwd: CWD }, BACKGROUND_CONTEXT);
    expect(listed.map((metadata) => metadata.id).sort()).toEqual(["conversation-a", "conversation-b"]);
  });
});
