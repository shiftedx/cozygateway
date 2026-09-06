# 2b durable Task report

Status: IN_PROGRESS. Base 54dc248 (gateway main 766b04c plus reviewed capability 63 dependency).
Row 64 reserved; not advertised until the vertical slice qualifies. No merge or deployment.

## Decisions grounded in source

- ADR 0004's closed reason list contains 45 unique reasons. Lead confirmed enumeration is authoritative and the earlier 46 count is clerical. No additional reason invented.
- `native-data-plane.ts` intentionally delivered late replies and rewrote a prior non-cancelled seal to completed (issue 193), conflicting with attach-v1 and ADR 0004. Lead ruled to retain durable late reply delivery under source/cancel guards, but preserve first Run/Task/row23 terminal outcome and clear only the exact stale pointer. Journal recovery must reapply its first authoritative terminal.

## Evidence so far

Node 24 explicitly selected with `PATH=/opt/homebrew/opt/node@24/bin:$PATH`.
`pnpm install --frozen-lockfile --offline` succeeded. Existing dist CLI warnings are expected before bootstrap build.

RED: `pnpm --filter cozygateway-contract exec vitest run test/tasks.test.ts`: 2 failed because Task schemas were absent. The earlier numeric 46 assertion was corrected per the lead's enumeration ruling, not counted as functional evidence.
GREEN: same command: 1 file passed, 2 tests passed. Closes schemas' ten states, 45 reasons, actors and references only; does not establish ingress lifecycle correctness.

An initial workspace build needs the lead's serialized gate slot before gateway focused tests, because this fresh worktree has no dependency dist artifacts. Hosted CI billing unavailable. Live model .121 unavailable. Deterministic local evidence only.

## Remaining

Durable storage, production direct/room ingress, commands/fences, waits, reconciliation, notification, public routes/portable conformance, integrated gates and independent review remain. No lifecycle or release completeness claim.

## First-terminal correction

Lead granted one bootstrap heavy slot: `pnpm -r build` passed contract, relay, gateway, conformance. Slot released immediately.

RED: `pnpm --filter cozygateway exec vitest run test/task-terminal-immutability.test.ts`: 7 tests, 4 failed and 3 passed. Late final commits changed timed_out/failed/interrupted to completed; storage also allowed this rewrite.
GREEN: `pnpm --filter cozygateway exec vitest run test/task-terminal-immutability.test.ts test/native-bot-data-plane.test.ts test/attach-boot-replay.test.ts`: 3 files, 67 passed. Includes late final/interim duplicate delivery, newer active-turn pointer isolation, user-cancel suppression, process reconstruction and journal-before-apply reply recovery. Existing issue 193 assertions now require delivered replies with the original timeout/interruption outcome.

Only production callers of `recordNativeBotTerminal` are native data plane normal settlement and late reply handling. Storage now retains the first outcome. Late replies retain delivery but do not replace it or emit misleading completed row23 state. This is a prerequisite correction, not Task implementation completion.

## Interim commits at the durable journal boundary

RED: task-terminal-immutability focused run, 8 tests: 1 failed and 7 passed. An interim `continues:true` commit incorrectly caused the next verification event to return `ignored_terminal`.
GREEN: `pnpm --filter cozygateway exec vitest run test/task-terminal-immutability.test.ts test/attach-v1-storage.test.ts`, 2 files, 31 passed. The added test closes and reopens SQLite after the interim commit, replays it as a duplicate, admits subsequent Verification and final commit, then refuses a later conflicting terminal. Storage now seals only final commits.

## Durable ingress and waits checkpoint

Rebased only Task commits onto merged capability63 main dc47146, conflict-free. Current Task contract remains unadvertised.

RED: new `test/durable-tasks.test.ts` first failed because actual `enqueueAttachCommand` had no Task projection. Subsequent tests failed because a stored pending approval did not project a wait, then because the real native timeout fired during its approval.
GREEN: durable-tasks now 3 passed: actual outbox admission/ACK/final inbox completion, source-bound stored approval settlement, and fake-clock real native timeout suspended from 10 through 100 and firing at 140 after its original 50ms active budget. No executor/model simulation claimed as live evidence.
Focused regression checkpoint: durable-tasks, task-terminal-immutability, native-bot-data-plane, attach-v1-storage: 4 files, 90 passed. Further atomic native settlement/interaction hooks: durable-tasks plus task-terminal-immutability, 2 files, 11 passed.

SQLite Task admission shares the command transaction; event projection shares inbox admission; notification inserts once with completion. Stored interactions and Task events now share a savepoint. The view derives from events and immutable intent/run references. Slash catalogs are retained and consulted at actual turn admission. Native timeout/silence and room deadline account for suspended wait intervals. These remain an implementation checkpoint: command routes, durable command fencing, complete owner reconciliation, device/child/artifact joins and portable conformance remain.

## Commands and reconciliation implementation checkpoint

Status remains IN_PROGRESS, not release-ready. This checkpoint follows 1453400. It adds authenticated Task read/list/five command routes, durable payload-bound command replay and dispatch intents, existing attach outbox dispatch with predecessor terminal fencing, source-bound device wait callbacks, child settlement joins, and durable owner-absence episodes. Row 64 remains reserved and unadvertised.

Lead rulings applied: legacy missing interaction deadlines receive a persisted 600000ms bound, assigned once; explicit deadlines remain authoritative. Repeated absence uses an internal durable episode identity, making duplicate observations idempotent without collapsing a second loss after proven reattachment. Authenticated current attach peer identity is the available ownership fence. Neither spec generation nor observed generation is represented as Runtime Generation. Proposed ADR clarification: "When a Runtime Generation wire fact is unavailable, reconciliation preserves it as unknown and fences available ownership evidence by the authenticated current attach peer and a durable absence-episode identity. Duplicate observations within an episode are idempotent; a new proven absence after reattachment is a distinct episode."

Focused evidence under explicit Node 24:
- durable-tasks plus native-bot-data-plane: 2 files, 63 passed, zero failed.
- durable-tasks plus mobile-node plus attach-v1-ingress: 3 files, 73 passed, zero failed.
- task-routes: 1 file, 3 passed, zero failed. Uses real pairing, authenticated Hono routes and SQLite storage.
- Granted gateway typecheck first exposed four unsafe RunRow casts; required-row lookup corrected them. Granted rerun `pnpm --filter cozygateway typecheck` passed. Later route/device/dispatch changes still need integrated typecheck/build.

Remaining acceptance: boot/read/hello expiry and ACK resume reconciliation; retry/pause/cancel predecessor races; room retry/timeout integration; Artifact reference seam; physical restart and command-state matrix coverage; public attach/frame portable conformance; advertise 64 only after final zero-failure gates and independent adversarial review. All evidence is deterministic local integration. Live .121 and hosted CI remain unavailable; no production services touched and no true runtime-generation evidence claimed.

## Recovery and wait corrections after 14ce1c0

RED/GREEN at actual SQLite/attach seams: hello resume cursor left Task queued (then 31 passed with attach storage); reserved retry cancellation landed before its live predecessor stopped (then 12 passed with routes); foreign profile sharing opaque interaction IDs supplied the wrong legacy first-seen deadline (physical restart test reproduced 600010 instead of 600100, then fixed); due clarification read remained waiting; overlapping approvals restored running while a second approval remained pending. All now have focused regressions.

Latest combined command: `pnpm --filter cozygateway exec vitest run test/durable-tasks.test.ts test/native-bot-data-plane.test.ts test/task-routes.test.ts`: 3 files, 71 passed, zero failed. Task tests now 12. Expiry migration source-fences profile peers or durable chat execution ownership plus session. Native expiry uses the same conditional durable settlement for reads and timers, broadcasts the terminal interaction frame, and clamps suspended budget at the persisted deadline. Overlapping wait clocks count the union once. ACK cursor reconciliation and Task start share a savepoint. A reserved Run consults its predecessor's execution proof before cancel/pause can land.

These are focused corrections, not completion of remaining room, Artifact reference, device recovery, conformance and integrated review acceptance.

## Room, boot lease, device and source fencing checkpoint

Actual room timeout now projects run_timed_out in the same savepoint. A focused room test proves its retry remains fenced until the actual attach terminal, then reuses the existing room ownership row and keeps one Task. Physical restart lease RED showed an old absence timestamp blocked immediately at boot; GREEN starts the provisional 120-second bound at boot while preserving episode identity and an already-projected loss across another restart.

Current-socket review found a real pre-existing transport hole: close callback was fenced, but buffered messages from the replaced socket were still admitted. A real WebSocket test delays server close and sends a stale final; RED projected it. The message and degraded-refresh boundaries now require the current connection. Full ingress file passes 41 tests, including that regression. This is authenticated current-socket evidence, not a Runtime Generation wire fact.

The existing mobile broker now exposes conditional deadline expiry to Task read reconciliation; a focused test uses the real broker and proves one expired result, one Task settlement and the bounded suspended clock. Artifact integration is only the lead-approved absent-by-default canonical reference-reader seam. Its test supplies explicit declarations, removes evidence to prove it stays pending, then proves settlement and first-terminal immutability. This is seam evidence, not production Artifact validation; initiative 4a must bind an authoritative source scoped by Task/Bot/peer/session/Run. No commitment is inferred from attachments, file IDs or delivery.

Latest focused command: durable-tasks, mobile-node, attach-v1-ingress: 3 files, 83 passed, zero failed. Room regression run initially had two failures: expected missing legacy expiry and timer callback using a fixed injected clock. The expectation now includes the mandated persisted deadline; elapsed timer expiry uses at least that deadline through the existing conditional settlement. Rerun durable-tasks plus bots-rooms-interactions: 2 files, 24 passed, zero failed. native-group-turn separately passed 7 tests in the earlier mixed run. Integrated typecheck and remaining full command/public conformance coverage still pending.
