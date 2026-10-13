import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";

import { judgeAnswer, parseJudgment } from "../src/semantic-judge.js";
import { createFauxModels } from "./helpers.js";

describe("parseJudgment", () => {
  it("reads a score and rationale from a bare JSON object", () => {
    expect(parseJudgment('{"score": 4, "rationale": "Clear."}')).toEqual({ score: 4, rationale: "Clear." });
  });

  it("finds the JSON object inside surrounding prose or a code fence", () => {
    expect(parseJudgment('Sure!\n```json\n{"score":5,"rationale":"ok"}\n```').score).toBe(5);
  });

  it("returns an undefined score — never a guessed one — for out-of-range, non-integer, or non-numeric scores", () => {
    for (const bad of ['{"score": 0}', '{"score": 6}', '{"score": 3.5}', '{"score": "4"}', '{"rationale": "x"}']) {
      expect(parseJudgment(bad).score).toBeUndefined();
    }
  });

  it("explains an unparseable reply instead of throwing", () => {
    expect(parseJudgment("no json here").score).toBeUndefined();
    expect(parseJudgment("no json here").rationale).toContain("Could not locate");
    expect(parseJudgment("{not json}").rationale).toContain("not valid JSON");
  });
});

describe("judgeAnswer", () => {
  it("makes one tool-free model call and returns the parsed judgment, bound to its case and judge model", async () => {
    const { faux, models, selection } = createFauxModels();
    faux.setResponses([fauxAssistantMessage('{"score": 4, "rationale": "Direct and clear."}')]);

    const judgment = await judgeAnswer({
      caseId: "lookup-single",
      repetition: 1,
      prompt: "What is the status of BK1001?",
      answerText: "BK1001 is booked.",
      models,
      selection,
    });

    expect(judgment).toMatchObject({
      caseId: "lookup-single",
      repetition: 1,
      score: 4,
      rationale: "Direct and clear.",
      judgeProvider: selection.provider,
      judgeModelId: selection.modelId,
    });
  });

  it("shows the judge the request and the answer, and nothing from the case's tool evidence", async () => {
    const { faux, models, selection } = createFauxModels();
    let seen = "";
    faux.setResponses([
      (context) => {
        seen = JSON.stringify(context.messages);
        return fauxAssistantMessage('{"score": 3, "rationale": "ok"}');
      },
    ]);

    await judgeAnswer({ caseId: "c", repetition: 0, prompt: "THE-REQUEST", answerText: "THE-ANSWER", models, selection });

    expect(seen).toContain("THE-REQUEST");
    expect(seen).toContain("THE-ANSWER");
    expect(seen).not.toContain("toolCall");
  });

  it("fails fast on a judge model that is not in the catalog", async () => {
    const { models } = createFauxModels();
    await expect(
      judgeAnswer({ caseId: "c", repetition: 0, prompt: "p", answerText: "a", models, selection: { provider: "deepseek", modelId: "nope" } }),
    ).rejects.toThrow(/Unknown model/);
  });
});
