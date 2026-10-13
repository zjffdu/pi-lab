import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadAllCases, loadCases, type CaseFixture } from "../src/case-registry.js";
import { PrincipalDirectory, loadTenantFixture } from "../src/directory.js";
import { checkEvidence } from "../src/evidence.js";
import { checkInvariants } from "../src/invariants.js";
import { InvalidConfigError, validateThresholds } from "../src/config.js";
import { ApprovalStore, Pipeline, ReceiverLedger } from "../src/pipeline.js";
import { mintSecurityContextForTest } from "../src/security-context.js";
import { DrainController, DrainInProgressError } from "../src/drain.js";

/**
 * One test per roadmap failure injection (Lab 22, "Failure injections"), so the mapping from the
 * roadmap's list to actual assertions is traceable line by line rather than left implicit across
 * other test files.
 */
const fixture = loadTenantFixture();

function pipelineFor() {
  const directory = new PrincipalDirectory(fixture.principals);
  const approvals = new ApprovalStore(join(mkdtempSync(join(tmpdir(), "pi-lab-22-fi-")), "approvals.json"));
  const ledger = new ReceiverLedger();
  return { pipeline: new Pipeline({ directory, bookings: fixture.bookings, approvals, ledger }), ledger };
}

function contextFor(kase: CaseFixture) {
  return mintSecurityContextForTest({ tenantId: kase.tenantId, subject: kase.subject, requestId: `req-${kase.id}` });
}

describe("failure injection: missing required span", () => {
  it("checkEvidence reports the dropped stage as missing_evidence, not a silent pass", () => {
    const kase = loadCases("dev").find((entry) => entry.scenario === "propose-without-approval");
    if (!kase) throw new Error("fixture missing");
    const poisoned = { ...kase, simulate: { dropStageSpan: "tool" as const } };
    const { pipeline } = pipelineFor();
    const result = pipeline.run(poisoned, contextFor(kase));
    expect(checkEvidence(kase, result).holds).toBe(false);
  });
});

describe("failure injection: invented identifier", () => {
  it("no-invented-identifiers fails when the tool stage references an identifier absent from the tenant fixture", () => {
    const kase = loadCases("dev").find((entry) => entry.scenario === "read-own-tenant");
    if (!kase) throw new Error("fixture missing");
    const poisoned = { ...kase, simulate: { inventIdentifier: true } };
    const { pipeline, ledger } = pipelineFor();
    const result = pipeline.run(poisoned, contextFor(kase));
    const [check] = checkInvariants({ kase: { ...kase, expected: { ...kase.expected, invariants: ["no-invented-identifiers"] } }, result, bookings: fixture.bookings, ledger });
    expect(check?.holds).toBe(false);
  });
});

describe("failure injection: approval bypass", () => {
  it("approval-required-before-effect fails when a delivery happens with no decided approval record", () => {
    const kase = loadAllCases().find((entry) => entry.scenario === "double-approve");
    if (!kase) throw new Error("fixture missing");
    const { pipeline, ledger } = pipelineFor();
    // runDeliveryDirectly is test-only and exists precisely to exercise this path — the pipeline's
    // own run() never calls it, and no approval was ever created or decided here.
    const result = pipeline.runDeliveryDirectly(kase, contextFor(kase));
    const [check] = checkInvariants({ kase: { ...kase, expected: { ...kase.expected, invariants: ["approval-required-before-effect"] } }, result, bookings: fixture.bookings, ledger });
    expect(check?.holds).toBe(false);
    expect(check?.critical).toBe(true);
  });
});

describe("failure injection: duplicate effect", () => {
  it("single-effect-per-idempotency-key fails when retry resends instead of reconciling", () => {
    const kase = loadAllCases().find((entry) => entry.scenario === "delivery-response-lost" && !entry.simulate?.unresolvable);
    if (!kase) throw new Error("fixture missing");
    const poisoned = { ...kase, simulate: { ...kase.simulate, forceResendWithoutReconcile: true } };
    const { pipeline, ledger } = pipelineFor();
    const result = pipeline.run(poisoned, contextFor(kase));
    const [check] = checkInvariants({ kase: { ...kase, expected: { ...kase.expected, invariants: ["single-effect-per-idempotency-key"] } }, result, bookings: fixture.bookings, ledger });
    expect(check?.holds).toBe(false);
    expect(ledger.appliedCount(`idem:${kase.id}:${kase.bookingNo}`)).toBe(2);
  });
});

describe("failure injection: provider outage", () => {
  it("connector reports an infrastructure error and the run terminates as error, not a guessed success", () => {
    const kase = loadAllCases().find((entry) => entry.scenario === "delivery-response-lost" && !entry.simulate?.unresolvable);
    if (!kase) throw new Error("fixture missing");
    const poisoned = { ...kase, simulate: { ...kase.simulate, providerOutage: true } };
    const { pipeline } = pipelineFor();
    const result = pipeline.run(poisoned, contextFor(kase));
    expect(result.outcome).toBe("error");
    const connectorSpan = result.spans.find((span) => span.stage === "connector");
    expect(connectorSpan?.status).toBe("error");
    expect(connectorSpan?.attributes.errorCategory).toBe("network");
  });
});

describe("failure injection: invalid configuration", () => {
  it("fails fast with InvalidConfigError instead of defaulting a missing or malformed field", () => {
    expect(() => validateThresholds({ minTaskSuccessRate: "high" })).toThrow(InvalidConfigError);
  });
});

describe("failure injection: changed model behavior (regression)", () => {
  it("no-cross-tenant-leak fails once simulate.regression makes the current version leak the other tenant's data", () => {
    const kase = loadAllCases().find((entry) => entry.scenario === "model-regression");
    if (!kase) throw new Error("fixture missing");
    const { pipeline, ledger } = pipelineFor();
    const healthy = pipeline.run(kase, contextFor(kase));
    expect(checkInvariants({ kase, result: healthy, bookings: fixture.bookings, ledger })[0]?.holds).toBe(true);

    const regressed = { ...kase, simulate: { regression: true } };
    const { pipeline: pipeline2, ledger: ledger2 } = pipelineFor();
    const badResult = pipeline2.run(regressed, contextFor(kase));
    expect(badResult.outcome).not.toBe(kase.expected.outcome);
    const [check] = checkInvariants({ kase, result: badResult, bookings: fixture.bookings, ledger: ledger2 });
    expect(check?.holds).toBe(false);
  });
});

describe("failure injection: shutdown while work is still active", () => {
  it("graceful drain lets in-flight work finish and rejects new work once draining", async () => {
    const controller = new DrainController();
    const work = controller.track(new Promise((resolve) => setTimeout(resolve, 30)));
    const draining = controller.drain();
    expect(() => controller.track(Promise.resolve())).toThrow(DrainInProgressError);
    await Promise.all([work, draining]);
  });

  it("an interrupted run's missing terminal span is reported as missing_evidence, never fabricated success", () => {
    const kase = loadCases("dev").find((entry) => entry.scenario === "propose-without-approval");
    if (!kase) throw new Error("fixture missing");
    const interrupted = { runId: "r", caseId: kase.id, outcome: "interrupted" as const, answer: "", startedAt: "", endedAt: "", spans: [] };
    expect(checkEvidence(kase, interrupted).holds).toBe(false);
  });
});
