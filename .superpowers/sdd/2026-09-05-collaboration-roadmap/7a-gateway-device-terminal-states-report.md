# 7a: gateway typed phone capability request lifecycle (capability 68)

## Heads

- Worktree: `<repos>/worktrees/7a-device-terminal-states`, branch `codex/7a-device-terminal-states`.
- Base: cozygateway `origin/main` at `e934bf4` (rows 65 Artifacts, 66 approvals, 67 cozyapps 2).
- Commits on the branch, all pushed to `origin/codex/7a-device-terminal-states`:
  - `d62824e` Typed phone capability request lifecycle: states, binding and durable records (capability 68)
  - `8ddda68` Task completion push and the mobile_node_progress stage report (capability 68)
  - `d424d72` Prove row 68 at the wire: conformance, schema closure and the reconnect case
  - plus the working-tree cleanup folded into the final commit below (see Commits).
- Node 24 (`/opt/homebrew/opt/node@24/bin`), pnpm 10.30.1.
- `.121` and any physical-device evidence: UNKNOWN. Reproducible commands are in Evidence.

## What the row is

`com.cozylabs.bots` 67 to 68, and `com.cozylabs.mobile-node` 5 to 6.

Every phone capability request now carries ONE typed state and reaches EXACTLY ONE typed terminal
state, bound to the profile, the conversation, the turn and the one paired device it was issued
for. `policy_blocked` (refused before the request was ever routed to a phone) and
`foreground_required` (the device or app lifecycle prevented execution) stay outcomes of their own;
`failed` is what remains, which is "nothing reached a phone, or the answer could not be kept".

The record is metadata: no lease, no answer, nothing the phone measured. It sits beside the
capability-39 receipt rather than replacing it; the receipt is still written only for a share that
actually happened, and its shape is untouched.

### Contract text added

`contract/ext-bots-v1.md`, capability table row 68 and a new section "Phone capability request
lifecycle (capability 68)":

```text
requested
routed
device_received
consent_presented
approved
executing
completed | denied | failed | expired | cancelled | policy_blocked | foreground_required
```

Section, in brief (full text in the file):

- BINDING. A record names the profile, conversation, turn and the ONE paired device. That device is
  also the user identity this gateway holds: `devices` has no account column, a paired device
  belongs to exactly one person's gateway, so device identity IS user identity here. A result or a
  progress report from any other device is refused and logged rather than applied, and the request
  stays pending for the device it was issued to. A second device attaching, or the target
  reconnecting, never moves the target.
- STATE ONLY MOVES FORWARD and the first terminal is sealed, the same rule capability 64's first
  terminal follows.
- DERIVED, NOT REPORTED. `requested`, `routed` and every terminal come from the gateway's own
  routing decision, lease, media claim and settlement.
- NO DUPLICATE EXECUTION. A reconnect still re-sends the original frame under the original request
  id and lease when the phone has reported nothing. It does NOT re-send once that phone reported a
  stage.
- `GET /bots/:name/mobile-requests?sessionId=` is device authenticated, answers
  `{ requests: BotMobileRequest[] }` for that conversation on that profile, bounded to 100, and a
  missing `sessionId` is `400 invalid_request`.
- The push half is `task_completed` in `contract/push-v0.md`, deduplicated against capability 64's
  completion notification record.

`contract/v1.md`, Mobile Node extension heading to `com.cozylabs.mobile-node: 6` plus the optional
frame:

```json
{ "type": "mobile_node_progress", "requestId": "...", "lease": "...", "stage": "device_received" }
```

`stage` is one of `device_received`, `consent_presented`, `approved`, `executing`. It is not a
result, carries no payload, can never settle a request, and is refused on a lease mismatch, a
non-target device, or an expired request. A phone below 6 sends none and behaves exactly as at 5.

`contract/push-v0.md`, registered category `task.completed` (alert, `aps.category`
`task.completed`, fallback "CozyChat / Task completed", collapse id = `taskId`, required) and the
payload:

```json
{ "kind": "task_completed", "taskId": "string", "threadId": "string", "agentId": "string" }
```

No goal, no reply, no artifact name. `threadId` is `bot:<name>`, or `group:<room>` for a room Task,
the namespacing the approval payloads already use. Sent once per Task, on the transition that
writes capability 64's completion notification record, and never to a device holding a live socket.

## RED then GREEN

RED, before any implementation, against the new seam
(`packages/gateway/test/mobile-request-lifecycle.test.ts`):

```
cd <repos>/worktrees/7a-device-terminal-states/packages/gateway
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run test/mobile-request-lifecycle.test.ts
```

```
 ❯ test/mobile-request-lifecycle.test.ts (13 tests | 12 failed) 20ms
 FAIL ... > binds the record to profile, conversation, turn and the one target device
 FAIL ... > reaches completed when the phone answers
 FAIL ... > reaches denied, cancelled, expired, failed, policy_blocked and foreground_required as their own outcomes
 FAIL ... > refuses a result from another device and leaves the request pending
 FAIL ... > refuses a progress report from another device and one carrying the wrong lease
 FAIL ... > never re-dispatches a request the phone is already executing when that phone reconnects
 FAIL ... > keeps re-dispatching for a phone that reports no progress, exactly as it did before row 68
 FAIL ... > records one row per request and moves it forward only
 FAIL ... > seals the first terminal state
 FAIL ... > answers only for the conversation and profile the request was issued in
 FAIL ... > answers the requests of one conversation
 FAIL ... > requires the conversation the request is scoped to
      Tests  12 failed | 1 passed (13)
```

GREEN, final state, serially in the foreground, Node 24:

| command | result |
| --- | --- |
| `pnpm -r typecheck` (repo root) | contract, relay, gateway, conformance all Done, 0 errors |
| `npx vitest run` in `packages/gateway` | **1520 passed, 2 skipped, 0 failed** (137 files) |
| `npx vitest run` in `packages/conformance` | **100 passed, 20 skipped, 0 failed** (10 files) |
| `npx vitest run` in `packages/contract` | **205 passed, 0 failed** |
| `npx vitest run` in `packages/relay` | **161 passed, 0 failed** |
| `npx vitest run test/mobile-request-lifecycle.test.ts` | **14 passed** |

Per the lead's ruling for this run, `pnpm -r test` was not run as one command; each affected package
suite was run in the foreground instead, which is every package this branch touches. The gateway
package needed `pnpm build` in `packages/contract`, `packages/relay` and `packages/gateway` first
(workspace packages resolve through `dist`).

Reproducible later, when `.121` returns and a physical phone is available (NOT run here, recorded as
UNKNOWN):

```
# a phone at mobile-node 6 reporting a stage, on a real device
#   1. pair the device, advertise mobile_node_advertise with foreground true
#   2. raise a mobile_request from the attach peer
#   3. send {"type":"mobile_node_progress","requestId":...,"lease":...,"stage":"consent_presented"}
#   4. background the app, drop the socket, reconnect
#   5. GET /bots/<bot>/mobile-requests?sessionId=<session> and assert one record, not two frames
# live model rollover / performance qualification against 192.168.99.121:1234 qwen3.8-27b-nvfp4
```

## Evidence per completion-criterion item

1. **Every terminal state reachable and typed.**
   `mobile-request-lifecycle.test.ts` "reaches completed when the phone answers" and "reaches
   denied, cancelled, expired, failed, policy_blocked and foreground_required as their own
   outcomes" drive all seven terminals through the real broker and assert the typed record.
   `packages/contract/test/ext-bots.test.ts` "closes the capability-68 request lifecycle record and
   its state vocabulary" pins the closed union, rejects `device_unavailable` as a user-facing state,
   and asserts `policy_blocked` and `foreground_required` are terminal names of their own.
2. **A cross-device or cross-conversation result rejected and logged rather than applied.**
   "refuses a result from another device, logs it, and leaves the request pending" asserts the
   result callback is never invoked, the lifecycle stays at `routed`, a `mobile_node_failure` trace
   line with reason `cross_device_result` is written, and the bound device can still settle it
   afterwards. "refuses a progress report from another device and one carrying the wrong lease"
   does the same for the new frame. Cross-conversation: "answers only for the conversation and
   profile the request was issued in" at the store, "requires the conversation the request is
   scoped to" at the route (`400`), and in the vertical e2e a read of a different conversation
   returns nothing for a request that exists. The pre-existing e2e cases for a request naming a
   non-active turn (`routine`, `scheduled`, `historical`) still settle `policy_blocked` and route to
   no phone.
3. **No duplicate execution across a simulated reconnect during `executing`.**
   Broker: "never re-dispatches a request the phone is already executing when that phone
   reconnects". Wire: `mobile-node-vertical-e2e.test.ts` now drops the phone's socket after it
   reported `executing`, reconnects and re-advertises, and asserts no `mobile_node_request` for that
   id arrives on the new socket and no result was produced, then settles it once. The pre-68
   behavior is pinned by its own test, "keeps re-dispatching for a phone that reports no progress,
   exactly as it did before row 68", and by the untouched existing `disconnect` case in the same
   e2e, which still asserts the resent frame is byte identical to the original.
4. **Explicit target selection surviving a second device attaching mid-request.**
   "keeps the original target when a second device attaching mid-request" asserts no extra send,
   every send addressed to the original device, and no lifecycle event naming the second device.
   At the wire, device B never receives the request frame, its result is ignored (pre-existing) and
   now its progress report is ignored too, with the typed record still reading `routed`.
5. **Portable route conformance for peers and clients below 68.**
   `packages/conformance/src/suite.ts` adds "phone capability request lifecycle capability 68"
   (gated on the new `mobileRequestLifecycle` env flag, so a third-party gateway that does not
   implement the row skips it): the advertised `com.cozylabs.bots >= 68` and
   `com.cozylabs.mobile-node >= 6`, the route is `401` unauthenticated, `400` with no `sessionId`,
   `200` with an empty list for a conversation that has none, and a `mobile_node_progress` frame
   from a socket that never advertised as a phone node creates no record and does not disturb the
   socket (a message round trip after it still commits). Every pre-68 assertion in that suite, the
   whole mobile-node group in the gateway package and the capability-39 receipt tests are unchanged
   and pass.

## What a Hermes peer gets by derivation

No Hermes change, and no attach-v1 change at all: `ATTACH_V1_CAPABILITIES` is untouched, no attach
frame gained or lost a field, and `mobile_request` / `mobile_result` are byte identical.

A Hermes mobile request gets, for free:

- `requested` when the gateway admits it, `routed` when the frame actually goes to the phone
  (including the wake path's later send on reconnect), and the typed terminal when the gateway
  settles it. Those are the gateway's own facts, so they exist for every peer.
- `executing` with no phone change at all for camera and file picks: the media upload claiming the
  lease IS the phone executing, so `beginMediaUpload` records it.
- The binding, the fail-closed cross-device rule and the sealed first terminal, because all three
  live in the broker and the store rather than in anything a peer sends.
- The `task_completed` push, because it is raised from capability 64's own completion notification
  record inside `Tasks.append`, which every peer's terminal already writes.

What a Hermes peer does NOT get is the three middle stages `device_received`, `consent_presented`
and `approved`. They are the phone's own facts and nothing else can honestly report them; a phone at
mobile-node 6 supplies them, a phone below 6 supplies none and its requests simply carry less
detail. The peer's `mobile_result` statuses are unchanged in every case.

## Files

Contract:

- `packages/contract/src/ext-bots.ts`: `MOBILE_REQUEST_STATES`, `MOBILE_REQUEST_TERMINAL_STATES`,
  `MobileRequestStateSchema`, `BotMobileRequestSchema`, `BotMobileRequestListSchema`;
  `BOTS_CAPABILITY_VERSION` 68 with its history note; `MOBILE_NODE_CAPABILITY_VERSION` 6.
- `packages/contract/src/ws.ts`: `MOBILE_NODE_PROGRESS_STAGES`, `MobileNodeProgressFrameSchema`,
  added to `ClientFrameSchema`.
- `contract/ext-bots-v1.md`, `contract/v1.md`, `contract/push-v0.md`.

Gateway:

- `packages/gateway/src/mobile-node.ts`: `MobileNodeLifecycleEvent`, the optional `lifecycle` dep,
  a `#life` step on every admission, routing, media-claim and settlement path, `progress()`, the
  per-request `stage` on `Pending`, and the reconnect rule that skips a resend once a stage exists.
- `packages/gateway/src/storage.ts`: `bot_mobile_requests` table and index, `recordBotMobileRequest`
  (forward-only, terminal sealed, binding checked), `nativeBotMobileRequests`, purge on bot delete.
- `packages/gateway/src/ws-hub.ts`: routes `mobile_node_progress` under the same selected-socket
  rule `mobile_node_result` follows.
- `packages/gateway/src/hermes-bridge/{bridge,native-data-plane,routes}.ts`: the `mobileRequests`
  surface method and `GET /bots/:name/mobile-requests`.
- `packages/gateway/src/push-crypto.ts`, `push-notifier.ts`: `TaskCompletionPushPayload` and
  `notifyTaskCompletion`.
- `packages/gateway/src/tasks.ts`: `TaskCompletionNotice` and `completions()`, fired in the existing
  guarded post-commit step only when this transition wrote the completion notification row.
- `packages/gateway/src/server.ts`: broker `lifecycle` wiring, `onMobileProgress`, completion push.

Relay:

- `packages/relay/src/categories.ts` and `packages/relay/README.md`: the `task.completed` category.

Tests:

- New `packages/gateway/test/mobile-request-lifecycle.test.ts` (14).
- `packages/gateway/test/mobile-node-vertical-e2e.test.ts`: the executing-then-reconnect case.
- `packages/gateway/test/push-notifier.test.ts`: three `notifyTaskCompletion` cases.
- `packages/contract/test/ext-bots.test.ts`: two schema-closure cases.
- `packages/conformance/src/suite.ts` and `test/reference-gateway.test.ts`.
- Version-pin updates: `packages/contract/test/{artifacts,ext-bots}.test.ts`,
  `packages/gateway/test/bots-delete-routes.test.ts`, `packages/relay/test/categories.test.ts`.

## Self-review

- **The reconnect rule is the one behavior change to an existing path.** Before this row a
  reconnect always re-sent a live request's frame. It still does for every phone that reports
  nothing, which is every shipped phone, so nothing deployed changes. A phone at mobile-node 6 that
  reports a stage and then loses the request (killed mid-flight) will now see it expire instead of
  arrive again. That is the deliberate trade the roadmap asks for: no duplicate execution beats an
  extra delivery, and packet 7b can re-request from the reconciliation route. It is written down in
  the contract section rather than left implicit.
- **A request refused before admission gets no durable record.** `MobileNodeBroker.reject`, which
  is what a wrong-conversation or wrong-turn attach request hits, has only the agent and request id,
  and the conversation the frame CLAIMED is not one the gateway has agreed the request belongs to.
  Writing a record under a peer-supplied session id would let a peer put rows into any conversation
  string. It stays a trace line plus the peer's typed `policy_blocked` result. If the lead wants
  those visible, the fix is to bind them at the `native-data-plane` seam where the active chat is
  known, not to widen `reject`.
- **`deviceId` is optional on the record**, absent exactly when no device was selected, which is
  itself the outcome. Blank string is refused by the schema, tested.
- **The receipt is untouched.** Making receipts cover failures would have changed what a client
  below 68 sees on the existing `bot_mobile_receipt` surface. The lifecycle is a separate record for
  that reason.
- **`#life` never throws into a request.** A store write that fails cannot lose the phone request it
  describes, the same guard the receipt write already had. `broker.close()` during shutdown runs
  through it against a closing database and is covered by the existing teardown tests.
- **The push refuses rather than truncates** a task id that cannot be a collapse id, following the
  approval leg exactly, and is excluded for any device with a live socket.

## Concerns

1. `task.completed` is a NEW relay category. A gateway at this revision talking to an older relay
   gets `400 invalid_request` for that one push and logs it; nothing else degrades, and no
   notification exists today anyway. It ships with the relay in this repo, so a paired upgrade
   fixes it. If the lead wants the push to work against an un-upgraded relay, the alternative is to
   send it with no category at all, which loses per-task collapsing and the honest fallback alert.
2. `bot_mobile_requests` has no pruner. One row per phone capability request, forever, until the
   owning bot is deleted. Reads are bounded to 100 per conversation. At human phone-request volumes
   this is small, but it is unbounded in principle; a retention sweep is a later, separate change.
3. The four middle stages are only reachable from a phone at mobile-node 6, which does not exist
   until packet 7b ships. Until then a real deployment sees `requested`, `routed`, `executing` (media
   only) and the terminals. Nothing is claimed beyond that.
4. `.121` and physical-device evidence are UNKNOWN. Everything above is deterministic in-process and
   real-socket evidence on this machine.

---

## Fix round 1

Against review r0. Three Critical and four Important, all addressed. RED captured first for every
one that has a test seam.

RED (before the fixes), `packages/gateway`:

```
npx vitest run test/mobile-request-lifecycle.test.ts test/push-notifier.test.ts
```

```
 FAIL ... > does not seal completed when the receipt the answer needs could not be written
 FAIL ... > calls a failure after the phone already ran the request a failure, not a policy block
 FAIL ... > records no terminal for a request the peer is never told about
 FAIL ... > answers the newest requests and a live one whatever its age, past the read bound
 FAIL ... > sweeps settled records past the retention window and never a live one
 FAIL ... > takes its lifecycle records with the bot they belong to
 FAIL ... > addresses a room Task by the session the room turn actually runs in
      Tests  7 failed | 40 passed (47)
```

GREEN after the fixes, Node 24, foreground, serially:

| command | result |
| --- | --- |
| `pnpm -r typecheck` (root) | contract, relay, gateway, conformance Done, 0 errors |
| `npx vitest run test/mobile-request-lifecycle.test.ts test/push-notifier.test.ts` | **47 passed** |
| the 15-file focused mobile / task / push / delete set | **154 passed, 2 skipped** |
| `npx vitest run` in `packages/gateway` | **1527 passed, 2 skipped, 0 failed** |
| `npx vitest run` in `packages/conformance` | **100 passed, 20 skipped, 0 failed** |
| `npx vitest run` in `packages/contract` | **205 passed, 0 failed** |
| `npx vitest run` in `packages/relay` | **161 passed, 0 failed** |

**C1, the read window and retention.** `nativeBotMobileRequests` now orders UNSETTLED requests
first, then settled ones newest-first, and the contract says so. A conversation past the bound
always sees the request the app came back to reconcile; the previous ascending order answered with
the oldest hundred forever. Settled records are swept 30 days after they settled, on the next write
to the table, and an unsettled record is never swept because its outcome is still owed to a person.
The window and the sweep are one documented rule in the row 68 section rather than a hidden
constant. Tests: 150 settled requests plus one live one opened before the newest hundred, asserting
the live one is first and the oldest are gone; and a retention case asserting the settled old row
is swept while the unsettled old row and the fresh one stay.

**C2, purge with the bot.** `purgeBot` gained `["mobileRequests", "bot_mobile_requests", "bot"]`,
so the delete route now reports the count as it does for every other area. The report's earlier
claim is now true. Test: two bots' records, purge one, assert the count, the emptied read and the
other bot untouched.

**C3, the receipt failure.** `#settle` no longer writes a terminal before it knows the outcome. The
receipt is attempted first; only then is the state sealed, `completed` when the receipt was written
and `failed` when it was not, so the record and the peer's `device_unavailable` agree. The test uses
the harness `receipt` option the review noticed was unused.

**I1, `policy_blocked` after routing.** A new `settledState` maps a post-routing `policy_blocked`
(an unusable phone answer, a failed media validation, a refused store) to `failed`. The peer's wire
status is deliberately unchanged; only the state a person reads differs, and the contract now says
so in as many words. Test drives an unusable status answer through the broker and asserts `failed`.

**I2, the room push identity.** The payload build moved into an exported `taskCompletionPayload`,
and a room Task now carries the room turn's own session (`group:<room>:<member>`) rather than the
invented `group:<room>`. `TaskCompletionNotice` carries `sessionId` for it. `push-v0.md`'s false
"same shape the approval payloads use" claim is corrected: `bot:<name>` for a 1:1 Task, the room
session for a room Task, with the reason for each. Test covers both branches directly.

**I3, the client half of the deduplication.** The row 68 section now states the rule 7b must
implement: announce at most once per `taskId`, keyed DURABLY on capability 64's notification record,
never on a set that lives for the process, because a phone pushed while backgrounded and then
relaunched reads a fresh process and would banner the same completion twice. The exact payload
fields are named there and in `push-v0.md`. The client change itself is 7b's, and until CozyKit
lands a `task_completed` case in `PushPayload.swift` the payload decodes as unrecognized and the
banner degrades to the relay's content-free alert with no deep link. That is recorded here so it is
not mistaken for working.

**I4, a terminal nobody was told.** `#terminalize` now answers whether the peer was actually told,
and a new `#refuse` records `requested` plus the terminal only when it was. `requested` itself is
recorded when the request becomes live rather than on entry, so a request dropped at the admission
ceiling records nothing at all instead of a dangling state, and the ceiling drop carries a
`ponytail:` comment naming the ceiling and the upgrade path (tell the peer, then record). The
contract's row 68 section names both uncovered edges (a pre-admission refusal and a ceiling drop)
and says the durable view holds no record rather than an untrue one. Test asserts a bounded broker
records nothing and tells the peer nothing for the dropped request.

Minor findings M1 to M6 are not addressed in this round and remain as the review filed them.

Files touched in this round: `packages/gateway/src/{mobile-node,storage,push-notifier,tasks,server}.ts`,
`packages/gateway/test/{mobile-request-lifecycle,push-notifier}.test.ts`,
`contract/ext-bots-v1.md`, `contract/push-v0.md`.
