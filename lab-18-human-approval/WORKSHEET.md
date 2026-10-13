# Lab 18 — Learner Worksheet

Prediction status: **waived** (the learner asked to skip the prediction gate). The two prediction
sections below are recorded as waived rather than left blank. The remaining sections are yours to
fill in after you run `npm run demo:approval` and read `REFERENCE.md`.

## Prediction 1 — An old approval and changed arguments

An approver has approved "set BK1001 to on_hold". The requested arguments then change ("set BK1001
to cancelled instead"). Does the old approval still authorize anything?

_Your prediction:_ waived

## Prediction 2 — Two simultaneous confirmations

Two confirmation requests for the same approved action arrive at the same instant. How many
executable business actions exist afterwards, and what does the second requester see?

_Your prediction:_ waived

## Observation

_What actually happened (after running the demo)?_

## Explanation

_Why? Name the component that enforced each result (digest, row lock, trigger, policy, state machine)._

## Surprise

_What did you not expect?_

## Unresolved questions

_

## Transfer

Changed scenario: the approval must survive a **process crash between "approval consumed" and
"business effect applied"**, but the effect is now a call to an external booking API instead of a
local UPDATE. Which guarantees from this lab still hold, which no longer do, and what would you need
to add? (Hint: what does the transaction no longer cover?)

_Your answer:_
