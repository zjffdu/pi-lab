import { accessSync, constants, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Frozen **before** any comparison against a run's results (scope item: "Provide separate
 * commands..."; acceptance criterion: "Quality, latency, and cost thresholds are frozen before
 * comparison"). `release-gate.ts` loads this file once per run and records its content hash in
 * the evidence manifest so a threshold cannot be quietly loosened after seeing a result it would
 * otherwise fail.
 */
export interface ReleaseThresholds {
  minTaskSuccessRate: number;
  maxAuthorizationViolationRate: number;
  minSemanticScoreFraction: number;
  minJudgeAgreementRate: number;
  maxWallClockMsP95: number;
}

export class InvalidConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidConfigError";
  }
}

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isFraction = (value: unknown): value is number => isFiniteNumber(value) && value >= 0 && value <= 1;

/**
 * Fails fast and explicitly on a malformed or out-of-range config, rather than defaulting a
 * missing or invalid field — this is what the `invalid-configuration` failure injection exercises.
 */
export function validateThresholds(value: unknown): ReleaseThresholds {
  if (typeof value !== "object" || value === null) throw new InvalidConfigError("release-thresholds.json is not an object");
  const candidate = value as Record<string, unknown>;
  const problems: string[] = [];
  if (!isFraction(candidate.minTaskSuccessRate)) problems.push("minTaskSuccessRate must be a number in [0, 1]");
  if (!isFraction(candidate.maxAuthorizationViolationRate)) problems.push("maxAuthorizationViolationRate must be a number in [0, 1]");
  if (!isFraction(candidate.minSemanticScoreFraction)) problems.push("minSemanticScoreFraction must be a number in [0, 1]");
  if (!isFraction(candidate.minJudgeAgreementRate)) problems.push("minJudgeAgreementRate must be a number in [0, 1]");
  if (!isFiniteNumber(candidate.maxWallClockMsP95) || (candidate.maxWallClockMsP95 as number) < 0) problems.push("maxWallClockMsP95 must be a non-negative number");
  if (problems.length > 0) throw new InvalidConfigError(`Invalid release thresholds: ${problems.join("; ")}`);
  return candidate as unknown as ReleaseThresholds;
}

const THRESHOLDS_PATH = fileURLToPath(new URL("../config/release-thresholds.json", import.meta.url));

export function loadThresholds(path = THRESHOLDS_PATH): ReleaseThresholds {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  return validateThresholds(parsed);
}

export interface ReadinessCheck {
  ready: boolean;
  reasons: string[];
}

/**
 * Everything the release-gate run needs before it may even start: valid thresholds, a readable
 * case registry, a readable labeled sample, and a writable evidence directory. A readiness
 * failure is reported as `infrastructure_failure`, distinct from a case failing on its merits.
 */
export function checkReadiness(evidenceDir: string): ReadinessCheck {
  const reasons: string[] = [];

  try {
    loadThresholds();
  } catch (error) {
    reasons.push(`release-thresholds.json: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const casesUrl = new URL("../cases/", import.meta.url);
    accessSync(fileURLToPath(new URL("dev", casesUrl)), constants.R_OK);
    accessSync(fileURLToPath(new URL("held-out", casesUrl)), constants.R_OK);
  } catch (error) {
    reasons.push(`case registry unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    JSON.parse(readFileSync(fileURLToPath(new URL("../judge/labels.json", import.meta.url)), "utf8"));
  } catch (error) {
    reasons.push(`judge/labels.json unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    mkdirSync(evidenceDir, { recursive: true });
    const probe = `${evidenceDir}/.readiness-probe`;
    writeFileSync(probe, "ok", "utf8");
    rmSync(probe);
  } catch (error) {
    reasons.push(`evidence directory not writable: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { ready: reasons.length === 0, reasons };
}
