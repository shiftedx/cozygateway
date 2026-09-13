# Chat context transport evidence — 2026-09-13

## Scope

This change adds the optional `com.cozylabs.chat-context` capability at version 1. It reports a **current prompt-occupancy snapshot** for a native Hermes attach chat; it does not report cumulative input/output/billing totals and it does not delay history recovery.

The authenticated read is `GET /bots/:name/chat/context`:

```json
{
  "name": "sage",
  "sessionId": "native:sage:...",
  "context": {
    "usedTokens": 0,
    "windowTokens": 128000,
    "measurement": "reported",
    "source": "provider_usage",
    "observedAt": 1726260000000,
    "stale": false,
    "model": "optional"
  }
}
```

`context` is `null` when the runtime has not provided a sample. `usedTokens: 0` is valid; `windowTokens` is always positive when a context is present. The same full replacement is broadcast as a `bot_chat_context` WebSocket frame. The session id is deliberately outer-only.

## Runtime source and lifecycle

The producer is `integrations/attach-plugin/cozygateway/adapter.py`. It uses pinned Hermes v2026.9.11's `agent.context_breakdown.compute_session_context_breakdown(agent, persisted_history)` after the actual background message task completes. That helper combines its provider anchor with the persisted final response, selecting `provider_usage`, `provider_usage_plus_estimate`, or `local_estimate`; no cumulative `input_tokens`, `output_tokens`, or `total_tokens` field is read.

Pinned lifecycle evidence:

- `gateway/platforms/base.py:3504` makes `handle_message` return after it starts a background task, so dispatch is not a valid sampling point.
- `gateway/platforms/base.py:4024-4034` invokes `on_processing_complete` before it releases the session guard or starts a queued successor.
- `gateway/run_turn.py:3118-3125` retains `state.turn.agent` until the next turn is claimed.

The adapter therefore marks only injected native turn events and samples from `on_processing_complete`. SQLite history loading and the context-breakdown calculation both use `asyncio.to_thread`; collection failures are best-effort and cannot change the chat outcome.

The Gateway only accepts a frame from the paired attach agent for the currently selected canonical native session and its latest admitted turn. A new turn marks the previous sample stale. A model or workspace write marks it stale and rejects that generation's later report; a reset yields `context: null`. Late terminal reports from an older turn cannot replace a newer completed sample. Gateway receipt time supplies `observedAt`.

## Availability limits

This is available for a native runtime that negotiates the `chat_context` attach capability. Old attachments, unavailable helper/runtime seams, malformed frames, and unsupported/direct runtime paths remain accurately unavailable (`null`, or route absence where no chat-context surface exists). No cached snapshot is persisted across a Gateway restart. No deployment or live server validation was performed.

## Focused verification

Passed from this isolated worktree:

```sh
python3 -m py_compile \
  integrations/attach-plugin/cozygateway/attach_client_v1.py \
  integrations/attach-plugin/cozygateway/adapter.py

PYTHONPATH=integrations/attach-plugin \
  /Users/kmcdowell/Desktop/mlx-workflow/.venv-qwen38-flash-next/bin/python \
  -m unittest \
  tests.test_attach_client_v1.AttachV1ClientTests.test_chat_context_is_a_latest_only_capability_gated_frame \
  tests.test_chat_context_lifecycle.ChatContextLifecycleTests.test_context_waits_for_the_exact_background_turn_to_finish
```

The two Python tests verify the live-only, capability-gated producer frame and that no sample appears at dispatch before the exact background task completes.

Using the existing same-lockfile Node dependency tree at `/Users/kmcdowell/Documents/repos/worktrees/cozygateway-cleo-interim-spool/node_modules` through temporary symlinks (removed after the run):

```sh
.../node_modules/.bin/tsc -p packages/contract/tsconfig.build.json
.../node_modules/.bin/tsc --noEmit -p packages/gateway
.../node_modules/.bin/vitest run packages/gateway/test/native-chat-context.test.ts
```

Both type checks passed; Vitest passed 2 tests. Those Gateway tests cover authenticated outer-session serialization, zero usage, malformed rejection, stale/new-turn behavior, model/workspace invalidation, terminal late-turn rejection, reset, broadcast, and optional-surface absence. `git diff --check` also passed. Temporary `node_modules` links and generated contract `dist` were removed.
