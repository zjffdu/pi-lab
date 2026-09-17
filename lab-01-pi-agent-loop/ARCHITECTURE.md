# Lab 01 Architecture

## Goal

Observe and explain Pi's smallest useful agent loop:

```text
user prompt -> LLM -> get_booking -> tool result -> LLM -> final answer
```

## Input and output

- Input: one booking question as plain text.
- Output: one evidence-based assistant answer plus a lifecycle trace.
- Fixture-backed fact: booking `BK1001` exists.
- Failure case: an unknown booking must surface as a tool error; the assistant must not invent a booking.

## Boundaries

Included:

- one in-memory Pi `Agent`
- one read-only tool
- one local JSON fixture
- lifecycle event logging
- deterministic repository and tool tests

Excluded:

- Teams and HTTP transport
- multiple tools
- multi-turn sessions
- persistence and `AgentHarness`
- steering, follow-up queues, and parallel execution

## Design decisions

- Keep the model provider configurable so provider setup is not confused with the Agent Loop.
- Keep tool lookup deterministic; only the model's tool selection and synthesis are non-deterministic.
- Keep this lab independent from later lab folders so its behavior remains reproducible.
