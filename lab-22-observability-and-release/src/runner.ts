import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CaseFixture } from "./case-registry.js";
import { PrincipalDirectory, loadTenantFixture } from "./directory.js";
import { checkEvidence, type EvidenceCheck } from "./evidence.js";
import { checkInvariants } from "./invariants.js";
import type { CaseOutcomeRecord } from "./metrics.js";
import { ApprovalStore, Pipeline, ReceiverLedger } from "./pipeline.js";
import { mintSecurityContextForTest } from "./security-context.js";

export interface RunCaseOptions {
  traceDir?: string;
}

export interface RunCaseOutput {
  record: CaseOutcomeRecord;
  evidence: EvidenceCheck;
}

/**
 * Runs one case end to end against a fresh tenant fixture, directory, approval store, and
 * receiver ledger — the ordinary single-shot path used by `scripts/run-cases.ts`,
 * `scripts/evaluate.ts`, and `scripts/release-gate.ts`. Scenarios that need two `Pipeline`
 * instances sharing one durable store (`restart-during-approval`) or a second, unapproved
 * delivery attempt (`approval-bypass`) construct `Pipeline`/`ApprovalStore` directly instead —
 * see tests/scenarios.test.ts and tests/failure-injections.test.ts.
 */
export function runCase(kase: CaseFixture, options: RunCaseOptions = {}): RunCaseOutput {
  const fixture = loadTenantFixture();
  const directory = new PrincipalDirectory(fixture.principals);
  const approvalsPath = join(mkdtempSync(join(tmpdir(), "pi-lab-22-")), "approvals.json");
  const approvals = new ApprovalStore(approvalsPath);
  const ledger = new ReceiverLedger();
  const pipeline = new Pipeline({ directory, bookings: fixture.bookings, approvals, ledger, traceDir: options.traceDir });
  const context = mintSecurityContextForTest({ tenantId: kase.tenantId, subject: kase.subject, requestId: `req-${kase.id}` });
  const result = pipeline.run(kase, context);
  const invariantResults = checkInvariants({ kase, result, bookings: fixture.bookings, ledger });
  const evidence = checkEvidence(kase, result);
  return { record: { result, expectedOutcome: kase.expected.outcome, invariantResults }, evidence };
}

export function runCases(cases: readonly CaseFixture[], options: RunCaseOptions = {}): RunCaseOutput[] {
  return cases.map((kase) => runCase(kase, options));
}
