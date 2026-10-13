# Lab 15 — Learner Worksheet

Fill this in yourself. Predictions must be written **before** the experiment that answers them is
run or its reference explanation is read. Status values: `pending`, `recorded`, `waived`.

## Prediction gate

**P1.** A policy-blocked `update_booking_status` call — which durable entries, audit records, and
spans does it create?

- Status: `waived` (learner request, 2026-09-19)
- Durable session entries:
- Audit records:
- Spans:

**P2.** After closing and reopening the same session, which configuration must the application
reapply?

- Status: `waived` (learner request, 2026-09-19)
- Answer:

## Observation

(what you actually saw when each experiment ran)

## Explanation

## Surprise

## Unresolved questions

## Transfer exercise

Answer in your own words before opening `REFERENCE.md`. Status: `pending`.

**T1.** A developer adds a third tool, `get_container_events`, and wires it into the harness but does
not add an entry for it to the policy table. A user's request makes the model call it. What does the
run result show (operation, tool outcome, mechanism)? What would be different if the tool were
"governed" only by being left out of the offered tool set?

- Answer:

**T2.** A new release removes `update_booking_status` from the application's offered tools. Yesterday's
session, which had it, is resumed. Which component must act, what does the provider receive, and what
happens if the model asks for the tool anyway because the history shows it using it?

- Answer:

**T3.** The audit store is down for ten minutes. Which user-visible operations stop, which keep
working, and what is the one case where a business effect can still happen without a complete trail?

- Answer:
