# Lab 02 — Teams Transport, No Agent Yet

English | [中文](README.zh-CN.md)

Build the smallest possible Teams SDK app and prove the transport layer works end to end, before any LLM or Pi agent is involved.

## Learning objective

By the end of this lab, you can explain this sequence from your own console output and from the Agents Playground log panel:

```text
Teams user sends "hello"
  -> HTTP POST /api/messages (Bot Framework activity, type=message)
  -> app.on("message", ...) handler runs
  -> handler computes a reply synchronously (no LLM call)
  -> ctx.reply(...) sends the reply back through the same channel
  -> Teams user sees "you said: hello"
```

This lab intentionally contains **no Pi agent, no LLM, and no tools**. The reply is a pure function of the input text. The point is to isolate the Teams SDK as a transport adapter — request in, activity parsed, reply out — before plugging an actual agent runtime behind it in a later lab.

Non-goals for this lab:

- No `@earendil-works/pi-agent-core` `Agent`, no model provider, no tool calls (that was [Lab 01](../lab-01-pi-agent-loop/README.md); it comes back in Lab 03)
- No real Teams tenant, App Registration, manifest, or SSO — everything runs against the local **Microsoft 365 Agents Playground**
- No deployment, no dev tunnel, no `AgentHarness`, no persistence across restarts

## Prerequisites

- Node.js 22.12 or newer (the version `@microsoft/teams.apps@2.1.0` declares in its `engines` field)
- npm

No API keys or credentials are needed. The app runs with `dangerouslyAllowUnauthenticatedRequests: true`, which is only safe because it talks exclusively to the local Agents Playground on your own machine, never to a real Teams service.

## 1. Predict before running

Write down your answers before starting anything:

1. What HTTP endpoint and method does the Teams SDK app listen on by default?
2. What field on the inbound activity carries the message text?
3. If you send an empty or whitespace-only message, should the handler crash, echo nothing, or reply with something else?
4. Is `ctx.reply(...)` synchronous with the HTTP response, or a separate outbound call?

Do not inspect the source until after you've written these down.

## 2. Install dependencies

```bash
cd lab-02-teams-echo
npm install
```

## 3. Verify the deterministic parts

```bash
npm run check
```

These tests cover `formatEcho` (the reply logic) and the trace logger's formatting. They start no server and make no network calls.

## 4. Run the app

```bash
npm run dev
```

Expected output:

```text
[WARN] @teams/app No credentials configured (CLIENT_ID / CLIENT_SECRET / TENANT_ID), but dangerouslyAllowUnauthenticatedRequests is enabled. Bot will accept unauthenticated requests on /api/messages.
[INFO] @teams/app listening on port 3978 🚀
```

Leave this running in one terminal.

## 5. Run the Microsoft 365 Agents Playground

In a second terminal:

```bash
npm run playground
```

This starts a local mock Teams client (no tenant, no sign-in) on its own port (printed in the output, default `56150`) and connects it to your app's `http://localhost:3978/api/messages`. Open that URL in a browser.

## 6. Happy path

In the Playground chat box, send:

```text
hello lab 2
```

Observe:

- The Playground's **Log Panel** shows a `message 200` request to your app, and a `message 201` reply back.
- The chat shows `you said: hello lab 2`.
- Your `npm run dev` terminal prints:

```text
[Teams] activity_received type=message conversation=<id> text="hello lab 2"
[Teams] reply_sent conversation=<id> text="you said: hello lab 2"
```

The important invariant is not the exact wording — it is that a real HTTP round trip happened (visible in the Playground's log panel) and your app's own trace log confirms it received and replied on the same conversation ID.

## 7. Inject a failure

Send a message that is only whitespace (a few spaces, then send).

Observe:

- The handler does not throw and no `handler_error` trace line appears.
- The reply is `I received an empty message. Send some text and I will echo it back.` — not a fabricated echo of blank text.
- This is the same "don't invent, don't crash on the edge case" discipline from Lab 01's `BAD_ID` case, applied to a transport-layer input instead of a tool call.

## 8. Explain the trace

Answer these using the Playground log panel and your terminal output:

1. Which log line proves the request left the Playground process and hit your Node process over real HTTP?
2. Why does `activity_received` appear before `reply_sent` in every case, even for the empty-message path?
3. What would you expect to change in this trace once an actual Pi agent sits between `activity_received` and `reply_sent` (turns, tool calls, multiple LLM round trips)? You do not need to build this yet — just predict it, since it's exactly what Lab 03 introduces.

## Completion criteria

- `npm run check` passes.
- Sending a normal message in the Playground produces a `you said: ...` reply and a matching `activity_received` / `reply_sent` trace pair.
- Sending whitespace-only text produces the empty-message reply, not a crash and not a fabricated echo.
- You can point at the Playground's log panel and your terminal trace and explain why each line appears where it does.

## Project map

```text
src/echo.ts         pure reply logic, no SDK or network dependency
src/trace-logger.ts lifecycle observation, mirrors Lab 01's trace-logger shape
src/create-app.ts   Teams App construction and the message handler
src/index.ts        process entrypoint (app.start())
tests/              tests that start no server and make no network calls
```

## Troubleshooting

### `EADDRINUSE` on port 3978 or the Playground's port

Another process is already listening. Stop it, or pass a different port to `app.start(port)` / `npm run playground -- -p <port>` (remember to update the `-e` endpoint if you also move the app's port).

### Playground log panel shows a connection error instead of `200`

Confirm `npm run dev` is still running and printed `listening on port 3978` before you started the Playground.

### The reply never appears in the chat, but your terminal shows `reply_sent`

Check the Playground log panel for the outbound call's status code. If it isn't `2xx`, the conversation ID the Playground sent may not match what `ctx.reply` targeted — restart both processes so they agree on a fresh conversation.
