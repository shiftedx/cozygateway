---
status: accepted
---

# ADR 0082: Agent Inbox stays hidden until Hermes proves A2A identity

Capability 17 projected Hermes session previews and transcript text into a read-only Agent Inbox.
That heuristic cannot distinguish A2A deliveries from ordinary human rows, nor can it recover a
stable sender, delivery/reply relationship, or conversation after reconnect. We withdraw its two
GET routes and `bot_inbox_activity` frame rather than expose a privacy-unsafe partial view.

## Considered options

- **Keep the heuristic inbox** — rejected: its observed false positives disclose unrelated human
  messages and its derived identity is not durable.
- **Build a Gateway-owned index now** — rejected: it would still need a trustworthy Hermes event
  and replay primitive, while duplicating incomplete state.
- **Hide the surface until Hermes provides structured state (chosen)** — the Gateway registers no
  inbox route or frame and does not advertise an inbox capability.

## Consequences

`com.cozylabs.bots` remains at version 40; capability history records 17 as withdrawn instead of
reusing or bumping that version. `com.cozylabs.agent-inbox` is reserved but has no version and is
not advertised. Reintroduce the page and advertise that independent capability only after Hermes
offers durable structured A2A sender, delivery/reply, and conversation metadata with bounded
replay. This ADR then becomes superseded.
