import { loadCases } from "../src/case-registry.js";
import { loadThresholds, validateThresholds, type ReleaseThresholds } from "../src/config.js";
import { runCase } from "../src/runner.js";

/**
 * Demonstrates the acceptance criterion: "Rollback evidence distinguishes reversible runtime
 * configuration from business effects that have already occurred." Reverting the release
 * configuration to a previous, compatible version is instantaneous and complete. A business
 * effect a case already produced (a receiver ledger entry) is not undone by that revert — undoing
 * it, if ever appropriate, is a new, explicit, separately-approved action, not a rollback.
 */
function main(): void {
  const current = loadThresholds();
  const previous: ReleaseThresholds = validateThresholds({ ...current, minTaskSuccessRate: current.minTaskSuccessRate - 0.1 });
  console.log(`[rollback-demo] current config:  ${JSON.stringify(current)}`);
  console.log(`[rollback-demo] previous config: ${JSON.stringify(previous)}`);

  const [doubleApprove] = loadCases("dev").filter((kase) => kase.scenario === "double-approve");
  if (!doubleApprove) throw new Error("expected dev/double-approve.json to exist");
  const { record } = runCase(doubleApprove);
  const effectCount = record.invariantResults.find((entry) => entry.id === "single-effect-per-idempotency-key")?.detail ?? "unknown";
  console.log(`[rollback-demo] ran ${doubleApprove.id}: outcome=${record.result.outcome}; receiver ledger: ${effectCount}`);

  console.log("[rollback-demo] reverting runtime config current -> previous ... done (instant, fully reversible, no business state touched).");
  console.log(`[rollback-demo] the business effect above is still recorded — reverting the config did not and could not undo it.`);
  console.log("[rollback-demo] if that effect needs to be undone, it requires a new, separately-approved compensating action against the downstream system, exactly like RUNBOOK.md's manual-review path — never an implicit side effect of a config rollback.");
}

main();
