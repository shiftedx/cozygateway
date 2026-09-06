# 2b durable Task report

Status: IMPLEMENTED, INDEPENDENTLY REVIEWED, LOCAL GATES PASS. Qualified implementation 7bc9010; test-only corrections f715c17 and 32e638d. Current base dc471465 after rebasing the original 54dc248 dependency tip.
Capability 64 is advertised. No merge or deployment. Historical checkpoint notes below retain the evidence timeline; the final qualification section is authoritative for readiness.

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

## Independent review corrections and public ingress evidence

Node24 gateway typecheck at 1b718f5 found a required TaskRow lookup cast and one delegation fixture missing lastActiveAt (used twice). Corrected the lookup with an explicit absent-source error and added the required fixture fact. Granted rerun passed exit 0, then released slot.

Independent reviewer found pause outcome rewritten by native terminal projection, wait cleanup resurrecting a paused Run, reattachment restoring an already-expired wait, runtime parking losing or prematurely sending a pending dispatch, and whitespace scope returning malformed conflict. Controlled REDs reproduced all lifecycle findings. New `task-public-ingress.test.ts` pairs through HTTP, sends actual chat messages through the existing native surface, receives the dispatched turn on a real authenticated attach WebSocket, ACKs and seals it, verifies public Task reads and full replacement observation, then pauses with a live approval and resumes through public routes. It disconnects the owner with another approval live, advances the injected gateway clock through lease and expiry, reconnects with hello and proves running with no stale waitingOn. Native paused outcome is retained; wait settlement cannot transition a sealed Run; reattachment derives the remaining wait or prior active state.

Runtime stopped/needs_attention now hold durable dispatches until readiness, including repeated episodes. Actual outbox admission rechecks the freshly reconciled queued state and pending intent. Explicit user pause/cancel may consume dispatches; runtime parking does not. Public terminal command matrix covers all five actions for completed/failed/cancelled, and whitespace scope returns malformed400.

The lead-approved trusted recovery-decision reader is absent by default. A decision must explicitly bind Task/Run, issuer, durable identity and reason; it is copied durably and only applies from blocked with no active execution. Its focused seam test refuses unsealed or foreign facts and appends no_recovery_remaining once after actual attach seal. Missing canonical producer is a downstream integration limitation, not permission for automatic failure.

Latest focused: durable-tasks19, task-routes7, task-public-ingress1: 3 files, 27 passed, zero failed. Portable fixture: 3 passed. Earlier failed attempts while assembling the public test were fixture setup/wire errors (missing now dependency and ACK channel/id); these are not claimed as functional RED evidence. Integrated gates and final independent review remain pending; row64 not yet advertised.

## Capability 64 qualification candidate

Self-audit RED through public ingress: final commit with a pending approval left completed.waitingOn populated. Terminal settlement now closes the wait record without transitioning the sealed Task; terminal views omit pending waits/intents. Public replacement/cold-read agreement is green after this correction.

Remaining named coverage is now explicit: all eight nonterminal command classes across five routes, all three terminal classes across five routes, catalog slash exclusion, investigation/unknown/verification transitions, owner deletion source isolation, one unacknowledged-discard automatic retry and budget exhaustion, acknowledged-turn no-auto-retry, and physical restart of intent revisions plus accepted command replay/payload binding. Focused Task23/routes16/public1: 3 files, 40 passed, zero failed.

Candidate advertises64 via the single BOTS_CAPABILITY_VERSION constant and removes the reserved table marker. Observer installation now uses that explicit server capability floor; focused test proves server63 omits Task observations and64 emits them. Existing protocol has no client extension-version negotiation: older clients ignore additive unknown frames; no per-client filtering is claimed. The portable conformance suite now includes an optional durableTasks hook enabled by the actual reference attach gateway, exercising real advertised>=64 health, paired HTTP reads, actual /ws replacement decode, same-view agreement and unauthorized/refused routes. This is distinct from the three-test decoder fixture and must pass the candidate's full gate.

No new Artifact or recovery-closure producer was added. Both absent-by-default source readers remain bounded by the lead's rulings. Exact-head workspace build/typecheck/test and final independent review are the remaining release gates.


## Final qualification and handoff

Implementation source 7bc9010 passed the four-package workspace build. The first workspace typecheck found a test closure narrowing error; f715c17 captures the already-narrowed turn id and all four package typechecks passed. The first full test run found only one legacy assertion expecting capability63; 32e638d changes that assertion to64. Neither correction changes production source or built output. Per lead ruling, the production-identical build was not repeated.

`PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm -r test` at 32e638d passed exit0:

| Package | Passed | Skipped | Failed |
| --- | ---: | ---: | ---: |
| contract | 183 | 0 | 0 |
| relay | 161 | 0 | 0 |
| gateway | 1427 | 2 | 0 |
| conformance | 80 | 18 | 0 |
| Total | 1851 | 20 | 0 |

Skips remain distinct from passes: the gateway suite has its existing skipped integration coverage; conformance optional hooks remain skipped where the fixture does not provide them, including the new durableTasks hook on the hookless runner. The configured reference gateway runs the new actual public Task hook successfully. No baseline failure exception was used, and no deadline was increased.

Durable local gate logs were moved from the temporary benchmark directory into this ledger's ignored `2b-gate-logs/`: `7bc9010/build.log`, `7bc9010/typecheck.log`, `7bc9010/typecheck-rerun.log`, `f715c17/test.log`, and `qualified/test-rerun.log`. They retain failed and green attempts. The adjacent `2b-durable-task-independent-review.md` imports the independent source/acceptance PASS7bc9010 and scoped PASSf715c17. Lead reviews the final numeric capability assertion; production source remains exactly the independently reviewed tree.

Rollout: capability64 activates the full Task replacement observer and advertises through existing gateway/attach surfaces. No client-version handshake is introduced. Lower server capability omits Task observation; older clients use the established additive/ignore-unknown rule. Native/core/room work uses existing attach turn identities, commands and terminal journals. No model execution, automatic acknowledged-turn replay, alternate retry authority, or terminal rewrite is introduced.

Remaining external integration ceilings are explicit: canonical Artifact declarations/commitment must bind the absent-default source reader in initiative4a; a trusted operator/policy producer must bind explicit recovery-closure decisions before no_recovery_remaining can occur in production. No producer was invented or simulated as production evidence. Runtime Generation is unknown without a declared wire fact; current authenticated attach connection and durable absence episodes fence the evidence available here. The 120-second lease is provisional pending live performance qualification. Live .121 and hosted CI billing are unavailable. All retained evidence is deterministic local integration; no production bot/service, merge or deployment was touched.

Skipped coverage detail: gateway's two skips are `mobile-node-hermes-e2e` real Hermes status/location tests requiring HERMES_AGENT_ROOT. Conformance's 18 are 15 cases in the hookless runner (no durableTasks, stall, approval, repair-approval, model-config, chat-stop or new-session hooks) and three cases in the configured runner (model-config, chat-stop, new-session hooks absent). The additional Task hook is one hookless skip and runs/passes in the configured reference gateway. Root separately reviewed 32e638d's one expected-integer change as PASS and scanned dc471465..32e638d with gitleaks: clean.
