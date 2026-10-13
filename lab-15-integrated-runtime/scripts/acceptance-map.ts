/**
 * Lab 15's acceptance criteria (ROADMAP-PHASE-3.md) and failure injections, each bound to the tests that pin
 * them. A `match` is a substring of a vitest full test name; a match that finds no test makes the criterion
 * `unmapped`, which fails the evidence run — a renamed or deleted test cannot silently leave a criterion
 * "verified".
 *
 * Rewritten for Pi 1.1. The 0.85.1 version of this map is not carried over: its statuses were measured on a
 * different runtime (AgentHarness, lanes, hooks with ids), and several of its caveats no longer apply while
 * new ones do.
 */
export interface AcceptanceCriterion {
  id: string;
  criterion: string;
  matches: readonly string[];
  /** `partial` when the tests pass but the criterion is only met under stated limits. */
  limited: boolean;
  caveats: readonly string[];
}

export const ACCEPTANCE: readonly AcceptanceCriterion[] = [
  {
    id: "AC1",
    criterion: "One request can be followed through runtime, policy, tool, audit, and final outcome.",
    matches: [
      "is followable from request through submission, policy, tool, audit, and telemetry to the answer",
      "records exactly one business effect for the whole booking, linked to its audit trail by business-action id",
      "requestId, sessionId, conversationId, task id, and call id",
      "the submission's own request id is stored",
    ],
    limited: false,
    caveats: [
      "Scripted provider only; no live-model run.",
      "A hook cannot read its request from Pi: the request is bound by the application per conversation (one request in flight at a time) and re-derived from durable entry ranges.",
    ],
  },
  {
    id: "AC2",
    criterion: "A blocked call creates no business effect.",
    matches: [
      "creates no business effect and leaves one blocked audit record",
      "fails closed: no effect, no audit record",
      "blocks a write (fail-closed): no effect",
      "blocks a tool that has no policy entry",
      "blocks a change to a delivered booking with several containers",
    ],
    limited: false,
    caveats: [
      "A failed afterTool audit write is fail-open by construction: the effect stands, the harness reports the swallowed throw (onReport, default a no-op), and the mechanism check reports the missing record afterwards.",
    ],
  },
  {
    id: "AC3",
    criterion: "Provider failure produces a failed run instead of a success or an earlier preamble.",
    matches: [
      "settles the submission unanswered with Pi's reason",
      "never reports an earlier preamble as the answer of a failed run",
      "a failed run can still carry a business effect",
    ],
    limited: false,
    caveats: ["Only the `model_error` shape was exercised; rate limits and timeouts were not."],
  },
  {
    id: "AC4",
    criterion: "Reopening reinstalls governance before any new tool execution.",
    matches: [
      "installing only Lab 15's `booking` extension offers nothing",
      "a third tool installed elsewhere and offered to the model is blocked by the deny-by-default table",
      "reopening through the composition root governs the first tool call",
      "an allowed write after reopen is audited before its effect",
      "a tool installed *separately* from its guard runs ungoverned",
    ],
    limited: true,
    caveats: [
      "Pi 1.1 makes this structural for tools inside the governance extension: Lab 15's own registry without it has no tools at all (tested against `createBookingRegistry`, and a mutant that moves the tools out of the extension turns it red). With it installed, its hook governs every tool, including one from another extension. It does not cover a registry assembled elsewhere that installs its own tool without governance (a test shows that runs ungoverned and unaudited).",
      "A reopen that finds an unfinished operation (a crash mid-run) and resumes it was not exercised; it needs the child-process crash harness from Labs 08/09.",
    ],
  },
  {
    id: "AC5",
    criterion: "A prohibited payload causes zero provider requests in the controlled test.",
    matches: [
      "refuses the request with zero provider requests",
      "refuses to commit a projection that carries a forbidden value",
      "a reopen that omits it leaks; the same reopen with it refuses",
    ],
    limited: true,
    caveats: [
      "Zero requests holds for what is already committed (plus the prompt) when the request is submitted. Pi 1.1 has no seam that stops a request: a throwing beforeRequest hook is reported and the request is sent. The backstop therefore WITHHOLDS, and the request goes out.",
      "Content that first enters during the run — a tool result, or the system prompt and tool declarations, which Pi writes when the run starts — is withheld, not prevented (two tests pin this).",
      "Verbatim substring matching only; no paraphrase or encoding is caught.",
      "The literal serialized provider payload was not observed (the 0.85.1 `before_payload` hook does not exist in 1.1); the check is on the final Message[] of each request.",
    ],
  },
  {
    id: "AC6",
    criterion: "Removing a required governance component fails a contract test.",
    matches: [
      "a governance extension built without its hooks lets a write run unaudited",
      "a runtime without telemetry reports the missing component",
      "still sends the request, but the provider receives the withheld marker",
    ],
    limited: false,
    caveats: [
      "Detects an omitted component inside a runtime built by the composition root. Omitting the whole egress configuration is not detectable: with no forbidden values configured there is no check to notice (a test pins the silent leak).",
    ],
  },
  {
    id: "AC7",
    criterion:
      "Missing SDK correlation fields are documented or supplied by a verified mapping; distinct IDs are not treated as interchangeable.",
    matches: [
      "a beforeTool hook gets the call, a conversation id, and a task id",
      "a tool task is not linked to its submission by any id",
      "never an invented id",
      "audit record whose task does not resolve into this request",
      "two requests that reuse the same tool-call id keep their own outcomes",
    ],
    limited: false,
    caveats: [
      "The request-to-entries join is positional (entry ids between the submission's input and answer), valid because one request runs per conversation at a time.",
      "Pi 1.1 has no run id or operation id; the 0.85.1 runId === operationId invariant no longer exists.",
    ],
  },
];

export interface FailureInjection {
  injection: string;
  observed: string;
  matches: readonly string[];
}

/** The roadmap's failure injections, each with what the run showed. Observations are pinned by the listed tests. */
export const INJECTIONS: readonly FailureInjection[] = [
  {
    injection: "Policy exception",
    observed:
      "Fails closed: no effect, no audit record. The call ends as `blocked`, exactly like a deliberate decline, so only the audit check can tell; the exception text becomes model-visible.",
    matches: ["fails closed: no effect, no audit record", "exposes the internal exception message"],
  },
  {
    injection: "Unavailable audit sink",
    observed:
      "A beforeTool write failure blocks the call (reads too); an afterTool write failure is fail-open: the effect stands, the harness reports the throw, and the missing audit is reported.",
    matches: ["blocks a write (fail-closed)", "also blocks a read", "fails open when only the afterTool write fails"],
  },
  {
    injection: "Provider failure",
    observed: "The submission settles unanswered (model_error) with no answer; a write that already ran keeps its business effect.",
    matches: [
      "settles the submission unanswered with Pi's reason",
      "never reports an earlier preamble",
      "a failed run can still carry a business effect",
    ],
  },
  {
    injection: "Session reopen",
    observed:
      "History restored; hooks, tool code, and the egress configuration are not stored; the stored tool offer overrides the application's; business state is lost. The composition root reinstalls governance and reconciles the tool set.",
    matches: [
      "conversation history survives",
      "installing only Lab 15's `booking` extension offers nothing",
      "Pi keeps the stored tool offer and ignores the one passed to root()",
      "the composition root reconciles to the current application configuration",
      "business state does not survive",
    ],
  },
  {
    injection: "Projected content containing a prohibited synthetic field",
    observed:
      "A leaky entry with no egress check leaks silently; the write-time check refuses a leaky projection; the preflight refuses the request (0 provider requests); the backstop only withholds; a throwing hook cannot block.",
    matches: [
      "a leaky entry with no egress check sends the prohibited field",
      "refuses to commit a projection that carries a forbidden value",
      "refuses the request with zero provider requests",
      "still sends the request, but the provider receives the withheld marker",
      "an exception from a beforeRequest hook is reported and the request is sent anyway",
    ],
  },
];
