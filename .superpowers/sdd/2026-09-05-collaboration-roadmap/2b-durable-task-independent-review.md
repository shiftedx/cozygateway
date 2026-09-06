# Independent Task review: PASS at f715c17

Latest verdict: PASS for implementation and retained acceptance at f715c17. Exact-head full workspace tests remain required before landing. The worker reports all four package typechecks passed. No full-suite success is claimed before those running gates complete.

Historical evidence follows unchanged: baseline dc471465; interim checkpoint 1b718f5; first corrected freeze 15d14ca; substantive final review 7bc9010. Review references ADR 0004 including coordinator 33c51d4 implementation rulings, the 2b brief and wave2 rules. No packet edits or full/build gates by this reviewer.

## Original findings at 15d14ca

- P1 native pause overwritten: FIXED. nativeTerminal recognizes user_paused as an authoritative first projection. The actual paired HTTP plus attach WebSocket plus native-plane test pauses from approval, settles interrupted, retains waiting_for_user_input and accepts resume.
- P1 expired wait restored by hello, plus late pause cleanup: FIXED. Reattachment consults remaining wait records and derives the pre-wait active state when none remain. Wait settlement records its bounded interval but cannot change a sealed Run. The public ingress regression expires approval during absence then rejoins as running without waitingOn.
- P1 runtime parking drops/bypasses pending dispatch: FIXED. Runtime parked turns stay undispatched until queued; explicit pause/cancel is separate. Actual enqueue rechecks the fresh derived queued state, current Run and pending intent before admitting an outbox turn. Repeated runtime episodes use the preceding event sequence. Both stopped and needs_attention test two episodes followed by one turn admission.
- P2 whitespace scope malformed conflict: FIXED. The public route rejects whitespace goal with invalid_request 400 before command acceptance. Required conflict state/view is no longer omitted on this path.

Independent focused command under Node 24: `pnpm --filter cozygateway exec vitest run test/durable-tasks.test.ts test/task-public-ingress.test.ts test/task-routes.test.ts test/task-terminal-immutability.test.ts`. Result at clean 15d14ca: 4 files, 35 tests passed, zero failed, 762 ms. Log: `/tmp/cozyagents-collaboration-wave2/2b-15d14ca-review-focused.log`.

## Remaining before final verdict

The worker identified terminal Tasks retaining waitingOn after cleanup; that follow-up is valid and pending final delta review. The acceptance audit also requested retained seam tests for discard and the single automatic retry budget, slash exclusion, tool-role verification, owner deletion, accepted-intent/idempotency restart, and nonterminal command acceptance/refusal classes. These are existing packet criteria, not new feature scope. Row 64 remains reserved pending qualification. No client-version handshake is required: server advertisement and observer gating plus additive compatibility suffice.

## Authority and compatibility audit

The current source has 45 closed reasons and ten states. Task events use source identities and immutable intent/Run references; Run is the actual attach turn identity. Replaced attach socket callbacks are fenced against the current connection. Owner absence has durable episodes and a provisional 120-second lease, with no fabricated Runtime Generation. Legacy missing wait expiry is persisted once at ten minutes and source-scoped during migration. Mutation/unknown roles do not authorize automatic replay; user retry uses the existing attach outbox and predecessor terminal fence. Completion notification is inserted once with completion and delivery remains separate.

Artifact commitment and no_recovery_remaining are explicit absent-default internal readers. Artifact requirements retain missing declared references as pending; attachment or delivery does not imply commitment. Recovery requires a matching Task/Run, trusted reader, recorded decision identity and reason, and execution ended. Future canonical producers remain future work under the approved ADR refinements. The decoder fixture is portable shape evidence; the separate public ingress test exercises authenticated HTTP and attach lifecycle. Neither is live model evidence.

Final delta, qualification evidence and verdict will be appended after the worker freezes the completed packet. This document is not approval to land.

## Final delta verdict at 7bc9010

PASS, implementation and retained acceptance review. No unresolved important source findings. This verdict covers dc471465 through 7bc9010 using the preceding checkpoint review plus the exact 15d14ca..7bc9010 delta. The worker's exact-head build/typecheck/full suites are still running and remain required before landing. No full-gate result is claimed here.

The terminal-wait follow-up is FIXED: non-pending settlement updates the durable interval even for a terminal Task, then returns without appending a transition; terminal views omit waitingOn and pendingIntent. Public HTTP/attach/native regression commits while approval is pending, checks one terminal and no wait, then compares the replacement frame to cold read. The original pause/reattachment assertions remain in that test.

Acceptance gaps are CLOSED in retained tests:

- Direct work admission, slash catalog exact-token exclusion, room ownership/timeout/retry and source-bound wait admission are exercised at actual outbox/inbox/storage seams. The public fixture additionally exercises paired chat HTTP through a real attach socket and native plane.
- Eight nonterminal classes across five routes and all three terminal classes across five routes are covered. Pending pause on an already-spooled command, reserved retry cancellation and interrupt-before-next-turn remain covered. Physical SQLite reopen proves revised goal, pinned intent, pending pause, accepted-command replay and conflicting payload refusal.
- The discard test proves one automatic retry, second discard stays blocked, and acknowledged work is never automatically retried. Role tests distinguish investigation from unknown possible effect, exercise Verification start/error and retain the Run identity. Gateway does not replay Mutation; harness recovery remains separate authority.
- Approval, clarification and real mobile-broker deadlines are covered, including legacy expiry migration, overlapping wait union and real native timeout suspension. Repeated owner absence and physical restart lease tests remain. Foreign owner deletion leaves the Task running; deletion of its actual Bot cancels it.
- First terminal immutability, interim commit, late delivery, stale active pointer, duplicate final, child failure after parent proof and declared Artifact settlement remain covered. Completion notification is keyed once and delivery cannot replace Task outcome.
- Contract advertises row 64 through the existing constant; server observer installation uses that floor. Below-floor observer test and existing additive compatibility are sufficient, without inventing client negotiation. The new optional portable conformance hook is enabled on the actual reference attach gateway and checks advertised capability, paired HTTP, actual /ws replacement decoding, full-view agreement, notification, monotonic events, unauthorized reads and refused terminal retry. The static decoder fixture remains separately labeled.

The new candidate's focused Task/routes/public result is worker-reported 40 passed. Reviewer independently ran the earlier clean corrected checkpoint's four files, 35 passed as recorded above. No additional focused run was started during the worker's workspace build, to avoid dependency build contention or ambiguous evidence. Read-only status at final delta inspection was clean.

Remaining risks/limits are explicit rather than invented failures: .121 live model and provisional lease performance qualification remain unavailable; hosted CI billing remains unavailable; canonical Artifact and recovery-closure producers are future absent-default seams as approved. Local exact-head build/typecheck/all tests must finish with zero failures, and any source change from 7bc9010 requires delta review. No merge or deployment was performed by this reviewer.


## Scoped final delta at f715c17

PASS. Exact diff 7bc9010..f715c17 changes only the public ingress test: after guarding the command as a turn, capture its turnId in const pauseRunId and compare the Task current Run to that constant inside find. This preserves the same identity comparison and every existing assertion while retaining TypeScript narrowing across the callback. No production behavior or coverage changes. No extra test run was needed for this type-only capture while the worker's full suite was active. Four-package typecheck success is worker-reported; earlier independent 35-test evidence remains unchanged. Any later source change needs another scoped delta review.
