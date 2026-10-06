---
status: accepted
---

# ADR 0081: Delegation identity stays local until Hermes exposes it

The live subagent-visibility surface (capability 34, PR #195) needs a stable batch
identity for delegated child agents, but Hermes' `subagent_start`/`subagent_stop`
hook payloads do not carry the `delegation_id` Hermes already holds internally and
in `cache/delegation/live/<delegation_id>/manifest.json`. We decided to use the
parent's `delegate_task` tool-call id as an opaque local `batchId` (captured by
`pre_tool_call` into a ContextVar that rides Hermes' `copy_context()` into child
workers) and to assign task indices by spawn order, rather than patch our Hermes
install or parse `sa-...` ids, completion prose, or filesystem paths.

## Considered options

- **Patch Hermes locally** — rejected: forks the install we run in production and
  every gateway user's install; upgrades become merges.
- **Parse ids/prose/paths** — rejected: undocumented shapes, breaks silently.
- **Local tool-call-id fallback (chosen)** — survives inside one Hermes process
  lifetime, joins nothing across restarts, but is honest, additive, and entirely
  ours.

## Consequences

The fallback cannot survive a Hermes restart and cannot join the plugin's view to
`delegation.status` or the live manifest; clients must treat `batchId` as opaque.
The upstream ask is documented here deliberately INSTEAD of an open issue or PR
(operator decision, 2026-08-25): when we next contribute upstream, propose adding
`delegation_id`, `task_index`, `task_count`, and `parent_tool_call_id` to both
lifecycle hook payloads, plus a structured `subagent_progress` hook fed from the
existing child progress relay (`{delegation_id, child_session_id, task_index,
event, tool_name, status, api_calls, tool_count, last_active_at}`), so platform
plugins can render live batch cards without consuming the UI-scoped progress
callback or reading transcripts. When that lands, `batchId` becomes
`delegation_id` behind the same opaque contract and this ADR is superseded.

## Addendum (2026-08-25): batch-level alias from the tool result

The lifecycle hooks still expose no delegation id, so `batchId` stays the parent
tool-call id. But the parent `delegate_task` RESULT is a documented structured
payload: its async "dispatched" shape carries a top-level `delegation_id`
(`tools/delegate_tool.py`) matching `cache/delegation/live/<id>/`. The plugin now
captures that field in `post_tool_call` -- with the `live_transcripts` path
segment `.../delegation/live/<deleg_id>/...` as an explicit documented fallback,
never prose parsing -- and emits it as an optional batch-level `aliasId` on the
batch's subsequent delegation events, so clients can reconcile the live card with
Hermes's `[ASYNC DELEGATION BATCH COMPLETE - <deleg_id>]` completion row.
Identity is unchanged (`batchId`, `childId`); this is neither the rejected Hermes
patch nor the rejected prose parsing, and when the upstream ask lands `aliasId`
becomes redundant.
