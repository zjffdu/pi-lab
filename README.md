# Pi Learning Labs

Small, self-contained projects for learning Pi one runtime concept at a time.

## Roadmaps

- [Phase 1 — Agent execution semantics (Labs 01–06)](ROADMAP.md)
- [Phase 2 — Durable agent runtime (Labs 07–14)](ROADMAP-PHASE-2.md)
- [Phase 3 — Enterprise WorkBuddy foundations (Labs 15–22)](ROADMAP-PHASE-3.md)

Read the relevant roadmap before starting or resuming a lab.

## Pi versions

Each lab pins its Pi packages to exact versions and is migrated in place (no parallel copies).

- `pi-agent-core` / `pi-ai` `1.1.0`: Labs 01, 03, 04, 05, 06, and 22 (Lab 22 only for its optional live judge).
- `@earendil-works/pi-durable` `1.1.0` (with `chord` and `pi-ai`): Labs 07–20.
- No Pi dependency: Lab 02 (Teams transport only) and Lab 21 (uses `pg`).

`pi-durable` is marked Experimental by its own README. See [CLAUDE.md](CLAUDE.md) for the per-lab details.

## Labs

- [Lab 01 — Pi Agent Loop (Pi 1.1)](lab-01-pi-agent-loop/README.md)
- [Lab 02 — Teams Transport, No Agent Yet](lab-02-teams-echo/README.md)
- [Lab 03 — Teams to Pi (Pi 1.1)](lab-03-teams-pi/README.md)
- [Lab 04 — Multi-tool Shipment Investigation (Pi 1.1)](lab-04-multi-tool-investigation/README.md)
- [Lab 05 — Multi-turn In-memory Sessions (Pi 1.1)](lab-05-multi-turn-sessions/README.md)
- [Lab 06 — Failures and Concurrency (Pi 1.1)](lab-06-failures-and-concurrency/README.md)

## Phase 2 Labs

- [Lab 07 — Durable Harness Session (Pi 1.1, `pi-durable`)](lab-07-durable-harness-session/README.md)
- [Lab 08 — Crash Recovery (Pi 1.1, `pi-durable`)](lab-08-crash-recovery/README.md)
- [Lab 09 — Tool Replay Safety (Pi 1.1, `pi-durable`)](lab-09-tool-replay-safety/README.md)
- [Lab 10 — Context Compaction (Pi 1.1, `pi-durable`)](lab-10-context-compaction/README.md)
- [Lab 11 — Session Tree and Navigation (Pi 1.1, `pi-durable`)](lab-11-session-tree/README.md)
- [Lab 12 — Durable Entries and Model Context Projection (Pi 1.1, `pi-durable`)](lab-12-context-projection/README.md)
- [Lab 13 — Tool Governance and Runtime Hooks (Pi 1.1, `pi-durable`)](lab-13-tool-governance/README.md)
- [Lab 14 — Typed Telemetry and Behavioral Evaluation (Pi 1.1, `pi-durable`)](lab-14-telemetry-evaluation/README.md)

## Phase 3 Labs

- [Lab 15 — Integrated Runtime Contract (Pi 1.1, `pi-durable`)](lab-15-integrated-runtime/README.md)
- [Lab 16 — Authenticated Principal and Tenant Isolation (Pi 1.1, `pi-durable`)](lab-16-identity-and-isolation/README.md)
- [Lab 17 — Resource Authorization and Delegated Access (Pi 1.1, `pi-durable`)](lab-17-resource-authorization/README.md)
- [Lab 18 — Durable Human Approval (Pi 1.1, `pi-durable`)](lab-18-human-approval/README.md)
- [Lab 19 — Untrusted Content and Data Egress (Pi 1.1, `pi-durable`)](lab-19-untrusted-context/README.md)
- [Lab 20 — Connector Reliability and Execution Budgets (Pi 1.1, `pi-durable`)](lab-20-connector-reliability/README.md)
- [Lab 21 — Durable External Effects (no Pi dependency)](lab-21-durable-effects/README.md)
- [Lab 22 — Observability, Evaluation, and Release Gates (Pi 1.1)](lab-22-observability-and-release/README.md)

Each lab is an independent Node.js project with its own dependencies, tests, and acceptance criteria.
