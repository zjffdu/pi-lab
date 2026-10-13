import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Stage } from "./trace.js";

export const SCENARIO_IDS = [
  "read-own-tenant",
  "read-other-tenant",
  "propose-without-approval",
  "restart-during-approval",
  "double-approve",
  "delivery-response-lost",
  "malicious-document",
  "revoked-permission-reuse",
  "model-regression",
] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

export const OUTCOMES = ["answered", "denied", "pending_approval", "executed", "manual_review", "error", "interrupted"] as const;
export type RunOutcome = (typeof OUTCOMES)[number];

export type Split = "dev" | "held-out";

/**
 * Knobs a case can set to steer the synthetic pipeline into one of the specific failure
 * injections the roadmap lists, without inventing a separate case shape for each one. Every field
 * defaults to off; a case that sets none of them exercises the pipeline's ordinary path.
 */
export interface SimulateFlags {
  dropStageSpan?: Stage;
  inventIdentifier?: boolean;
  skipApprovalCheck?: boolean;
  forceResendWithoutReconcile?: boolean;
  unresolvable?: boolean;
  providerOutage?: boolean;
  regression?: boolean;
  invalidConfig?: boolean;
}

export interface CaseExpectation {
  outcome: RunOutcome;
  reachedStages: Stage[];
  invariants: string[];
}

export interface SemanticExpectation {
  rubric: string;
  mustMention?: string[];
  mustNotMention?: string[];
}

export interface CaseFixture {
  id: string;
  split: Split;
  scenario: ScenarioId;
  description: string;
  tenantId: string;
  subject: string;
  bookingNo: string;
  targetTenantId?: string;
  approver?: string;
  simulate?: SimulateFlags;
  expected: CaseExpectation;
  semantic?: SemanticExpectation;
}

const isString = (value: unknown): value is string => typeof value === "string";
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);

function isCaseExpectation(value: unknown): value is CaseExpectation {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return isString(candidate.outcome) && isStringArray(candidate.reachedStages) && isStringArray(candidate.invariants);
}

function isCaseFixture(value: unknown): value is CaseFixture {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isString(candidate.id) &&
    (candidate.split === "dev" || candidate.split === "held-out") &&
    isString(candidate.scenario) &&
    (SCENARIO_IDS as readonly string[]).includes(candidate.scenario) &&
    isString(candidate.description) &&
    isString(candidate.tenantId) &&
    isString(candidate.subject) &&
    isString(candidate.bookingNo) &&
    isCaseExpectation(candidate.expected)
  );
}

const CASES_ROOT = fileURLToPath(new URL("../cases", import.meta.url));

/** Runtime-validated load of every `cases/<split>/*.json` fixture — no `as` cast on fixture data. */
export function loadCases(split: Split): CaseFixture[] {
  const dir = `${CASES_ROOT}/${split}`;
  const files = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  return files.map((name) => {
    const parsed: unknown = JSON.parse(readFileSync(`${dir}/${name}`, "utf8"));
    if (!isCaseFixture(parsed)) throw new Error(`cases/${split}/${name} is not a valid CaseFixture`);
    if (parsed.split !== split) throw new Error(`cases/${split}/${name} declares split "${parsed.split}", expected "${split}"`);
    return parsed;
  });
}

export function loadAllCases(): CaseFixture[] {
  return [...loadCases("dev"), ...loadCases("held-out")];
}
