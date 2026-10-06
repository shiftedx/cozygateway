---
status: accepted
---

# Chat execution context belongs to the conversation session

The user chose independent computer, project, worktree, branch, and model selection for each
new/reset chat on 2026-09-05. These choices belong to that conversation session: applying them
must preserve the bot's other chats and room work, rather than relocate its whole runtime.
An unchanged first send retains existing defaults. Workspace becomes fixed when the first turn
is accepted; model changes affect future turns in that session only.

This requires a session execution boundary beyond the existing bot-wide runtime placement.
It does not supersede ADR 0084: the central Providers & Models UI still administers credentials
and model inventory in the owning harness configuration scope, while bot defaults and chat
overrides reference that inventory.
