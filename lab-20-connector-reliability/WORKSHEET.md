# Lab 20 — Learner Worksheet

Fill this in yourself. Write the **prediction** before running `npm run demo:faults` and before
reading the tests or the "Design and evidence" section of `README.md` (both encode the answer). If
you want to skip it, write `waived` in that section so the skip is recorded rather than left blank.

Prediction status: _pending_

## Prediction 1 — 403 and 429

The booking API answers one lookup request with HTTP 403. In a second run it answers the same request
with HTTP 429 and `Retry-After: 2`. Assume the connector is allowed up to 3 attempts per request and a
few seconds of waiting.

1. How many requests does the API receive in each case?
2. Should the two behave the same? What does each status tell the connector about what to do next?
3. What does the model see afterwards in each case (and what is it told **not** to do)?

_Your prediction:_

## Prediction 2 — What cancellation can guarantee

A client disconnects while a lookup request is already on the wire to the booking API, and the API is
in the middle of doing the work.

1. What does the application stop doing, and how quickly?
2. What does the API see?
3. Can the application promise that the work the API started did **not** happen? What does it promise
   instead, and why is that good enough here (and perhaps not in Lab 21)?

_Your prediction:_

## Observation

_What actually happened (after running the demo)?_

## Explanation

_Why? Name the component that decided each result — and say what it does **not** guarantee._

## Surprise

_What did you not expect?_

## Unresolved questions

_

## Transfer

Changed scenario: the same connector now performs a **write** — `POST /bookings/BK1001/status` — instead
of a read. A request attempt times out after 3 seconds with no response, and the retry policy (up to 3
attempts, `503` and timeout are retryable) is unchanged.

Which of this lab's guarantees still hold, which no longer do, and what would you add? (Hint: what does
"timed out" tell you about whether the effect happened? What did "cancellation does not undo work the
server already started" cost you for a read, and what would it cost you here?)

_Your answer:_
