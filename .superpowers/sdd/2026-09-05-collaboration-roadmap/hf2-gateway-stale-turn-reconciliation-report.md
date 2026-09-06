# HF2 report: never lose a reply to a stale native turn

Branch `codex/hf2-stale-turn-reconciliation`, cut from cozygateway `origin/main` at `f3d70ef`.
Worktree `<repos>/worktrees/hf2-stale-turn-reconciliation`. Node 24.

## Status

DONE. Capability row 69 allocated: the fix needs two optional attach-v1 fields from the peer, and
everything else is behavior behind existing frames.

## The incident, and where each half of it was fixed

From the gateway logs, 2026-09-06:

1. the gateway dispatched a turn, the peer acked the command and dropped the turn internally, and
   no terminal ever came. The gateway kept the turn running.
2. nineteen minutes later the next message went out as a `steer` on that turn id, because the turn
   was still active.
3. the peer had restarted and held no such turn. It read the steer as a fresh inbound message,
   answered, and emitted `draft` and `commit` on `<turn>:steer`. The gateway declined both with
   "native commit event declined: no durable turn command", acknowledged them as orphaned, and the
   reply never reached the phone.
4. twenty-one minutes of silence later the sweep reaped the turn.

Four floors now stand between that sequence and a lost reply, in the order they fire:

- **hello reconciliation.** A peer declares `activeTurns` at hello. A nonterminal turn it does not
  name is sealed immediately for owner loss, through the ordinary `bot_chat_state` transition. A
  turn it names is never sealed by reconciliation and keeps the long window.
- **the owner-loss lease.** A turn no peer is carrying (the peer is disconnected, or re-attached
  without declaring it) runs on ADR 0004's provisional 120 second lease instead of the 30 minute
  silence ceiling. This is the short grace an older peer that cannot declare gets: one frame keeps
  the turn, no frame ends it. The lease never lengthens a window an operator already shortened
  (`min(120s, staleTurnCeilingMs)`), and a ceiling of 0 still disables reaping entirely.
- **steer promotion.** A steer left unanswered on a turn that is terminal, reaped, or answered
  `unknown_turn` becomes a new durable turn with the same text and media, and the person's own
  message row moves onto it, so the app sees a normal new turn and the reply names the question it
  answers. A promotion that cannot be dispatched records a visible marked failed-delivery row
  preserving the text.
- **orphaned commit rescue.** A commit carrying user-facing text or media on a turn id this gateway
  never issued is projected as an ordinary reply bound to no turn, instead of being acknowledged
  and dropped. An orphaned frame carrying nothing a person can read is still declined.

Step 2 of the incident can no longer happen at all: by the time the person's message arrives, the
stale turn is already sealed, so the send opens a fresh durable turn.

## Capability row 69

A row was needed. The gateway cannot tell a dropped turn from a slow one without the peer, and the
only party that knows is the peer. Two optional additions, both on frames the peer sends:

- `hello.activeTurns`: turn ids, at most 256, ids only. An empty array is the declaration "I hold
  none"; an absent field is a peer that cannot declare and is read as neither answer.
- `failed.reason`: a closed union whose only member is `unknown_turn`, which HF1 emits on the
  plugin side when it is handed a steer for a turn it does not hold.

Nothing the gateway sends changed: no route, no frame, no field, no status value, no new
`BotChatStateCause` member. A peer that sends neither field, and every client at any version, is
byte identical to its pre-69 self. The seal uses `phase: "failed"`, `status: "failed"`, both
existing closed values, so the owner-loss reason is carried in the log and the trace rather than by
widening a client-facing union.

Contract text: `contract/ext-bots-v1.md` row 69 and the header scalar, `contract/attach-v1.md`
capability 69 bullet, and the doc comment on `BOTS_CAPABILITY_VERSION`.

## Red, then green

RED, before any implementation, at the data-plane seam
(`/private/tmp/.../scratchpad/hf2/red-unit.txt`):

```
 Test Files  1 failed (1)
      Tests  8 failed | 2 passed (10)
```

with `TypeError: harness.plane.handleAttachHello is not a function` on the five reconciliation
tests, `expected [ { ... } ] to have a length of 2 but got 1` on promotion, `expected false to be
true` on the orphaned commit, and `expected undefined to be defined` on the disconnected-peer
lease. The two that passed are the negatives that must never regress: a still-active turn is not
sealed, and an orphaned frame with nothing to read is still declined.

RED for the end-to-end incident replay, run against the `f3d70ef` sources checked back into the
worktree (`git checkout f3d70ef -- packages/gateway/src packages/contract/src`, restored
immediately afterwards; no `git stash`)
(`/private/tmp/.../scratchpad/hf2/red-e2e.txt`):

```
 FAIL  test/native-bot-stale-turn-incident-e2e.test.ts > never loses a reply to a native turn the peer dropped and then re-attached without
Error: timeout
 ❯ test/native-bot-stale-turn-incident-e2e.test.ts:103:5
```

Line 103 is the wait for the stale turn's terminal after the peer re-attaches declaring it carries
nothing. At baseline it never arrives.

GREEN:

```
packages/gateway  vitest run (16 focused files)     220 passed (220)
packages/gateway  vitest run (7 adjacent attach files) 43 passed (43)
packages/contract vitest run                        207 passed (207), 20 files
packages/conformance vitest run                     108 passed | 20 skipped (128), 11 files
pnpm -r typecheck                                   contract, relay, gateway, conformance: Done
```

Exact focused command:

```
cd packages/gateway && npx vitest run \
  test/native-bot-stale-turn-reconciliation.test.ts test/native-bot-stale-turn-incident-e2e.test.ts \
  test/native-bot-data-plane.test.ts test/native-bot-attach-v1-e2e.test.ts \
  test/attach-v1-ingress.test.ts test/attach-v1-protocol.test.ts \
  test/attach-orphan-acknowledge-e2e.test.ts test/attach-capability-completeness.test.ts \
  test/bots-delete-routes.test.ts test/native-chat-execution-routing.test.ts \
  test/attach-v1-restart-e2e.test.ts test/bots-bridge-wiring.test.ts \
  test/native-bot-stale-turn-reaper.test.ts test/native-bot-interim-commit.test.ts \
  test/native-bot-sessions.test.ts test/turns.test.ts
```

The full `pnpm -r test` was not run: Kyle's ruling for this run is focused tests plus typecheck,
with the full suite by the lead.

## Files

- `contract/ext-bots-v1.md`, `contract/attach-v1.md`: row 69 and the two peer fields.
- `packages/contract/src/ext-bots.ts`: `BOTS_CAPABILITY_VERSION` 68 to 69 with its history comment.
- `packages/gateway/src/adapters/attach/protocol-v1.ts`: `hello.activeTurns`, `failed.reason`.
- `packages/gateway/src/adapters/attach/ingress-v1.ts`: `onHello` carries the declaration.
- `packages/gateway/src/server.ts`: hello reaches the native plane.
- `packages/gateway/src/hermes-bridge/native-data-plane.ts`: `handleAttachHello`, `#peerBot`,
  `#markOwnerLost`, `#sealOwnerLoss`, `#promoteSteer`, `#recordFailedSteerDelivery`, the pending
  steer record on the steer branch of `#send`, the orphaned-commit rescue and the `unknown_turn`
  branch in `handle`, and the lease in `#sweepStaleTurns`.
- `packages/gateway/src/storage.ts`: `nativeBotActiveTurns`, `rebindNativeBotMessageTurn`.
- `packages/gateway/test/native-bot-stale-turn-reconciliation.test.ts` (new, 10 tests).
- `packages/gateway/test/native-bot-stale-turn-incident-e2e.test.ts` (new, the incident replay).
- `packages/gateway/test/attach-orphan-acknowledge-e2e.test.ts`: expectation updated, see below.
- `packages/conformance/test/stale-turn-reconciliation-fixture.test.ts` and its fixture (new).
- Three `BOTS_CAPABILITY_VERSION` assertions moved to 69.

## Commits

- `62cf017` Reconcile stale native turns at hello and never lose a reply to one (capability 69)
- `1deabc3` Allocate capability row 69 and replay the incident end to end
- `1700806` Keep an orphaned reply, and let only the peer that runs a session speak for it

Pushed to `origin/codex/hf2-stale-turn-reconciliation`. No merge, tag, release or deploy.

## Self-review findings, and one deliberate reversal

- **An existing test asserted the opposite of Kyle's ruling.** `attach-orphan-acknowledge-e2e`
  (issue #193) asserted that a commit with no durable turn command is dropped from the transcript.
  Kyle's HF2 ruling is that an orphaned commit carrying user-facing text is never silently
  discarded. I changed the expectation rather than working around it by rewriting the message id,
  which would have made the old assertion pass for a cosmetic reason. The invariant #193 exists for
  is untouched and still asserted in the same test: the orphan is acknowledged, the stream keeps
  applying, and the real turn's own answer still lands and still seals.
- **One profile can be served by several attach identities.** A chat execution runs its own session
  on its own peer. The first draft let any hello for a profile seal every one of its turns, which
  would have let a profile peer kill a chat execution's live work. Reconciliation and presence loss
  now act only on sessions whose `#executionPeer` is the peer that spoke.
- **A promoted steer must not double-answer.** Promotion refuses if another turn is already active
  on that conversation, and the pending steer is dropped the moment the peer emits any frame for
  the turn, which is proof it holds it. The one exception is the `unknown_turn` failure, which is
  the peer saying the opposite. There is a test for a steer the peer actually answered.
- **The lease never lengthens an operator's window.** It is `min(120s, staleTurnCeilingMs)`, and a
  configured ceiling of 0 still means no reaping at all.

## Concerns

- The pending steer is process-local. A gateway restart between a steer and its owner-loss seal
  loses the promotion, and the fallback is the visible failed-delivery row, which still preserves
  the text. Marked `ponytail:` in the field's comment with the upgrade path (persist it beside the
  turn command when a durable steer command lands).
- The 120 second lease is ADR 0004's provisional default, adopted per the wave 2 ruling. It has not
  been measured against a real model endpoint, and .121 remains unavailable, so it is recorded as
  provisional rather than tuned. A legitimately long run is unaffected: the lease only applies once
  no peer is carrying the turn, and any frame at all clears that.
- Conformance coverage of the promotion is the wire fixture (both new fields, the closed reason,
  and the pre-69 frames that must stay untouched) plus the capability floor. The promotion behavior
  itself needs a peer that can drop a turn and re-attach, which a portable black-box suite has no
  way to script, so the behavioral proof lives in the gateway e2e and unit tests instead.
- HF1 is the plugin half. Until it ships, Hermes never sends `activeTurns` or `unknown_turn`, so
  Kyle's bots are protected by the lease and the orphaned-commit rescue rather than by the
  immediate hello seal. That is the intended order: the gateway side had to protect users of any
  peer, including one that is never updated.

---

# Fix round 1

Review `review-r0.md` (REQUEST CHANGES: 2 Critical, 5 Important, 4 Minor). Every item is addressed.
Commit `dd5d7f3`, plus the contract and conformance follow-up.

## C1: the rescue and the promotion both fired for the same steer

The rescue path returned before the block that cleared the pending steer, and the orphaned commit
arrives on a DIFFERENT turn id (`<turn>:steer`), so nothing ever cleared it. On an un-updated
Hermes peer, which is the deployment window this ships into, the person's question was asked and
billed twice.

A steer is now settled exactly once, and a rescued reply settles every steer still open on that
CONVERSATION, not just on the turn id the peer happened to invent: the peer demonstrably heard the
person, so nothing is left for promotion to re-ask. Rescue and promotion are therefore mutually
exclusive per steer by construction rather than by ordering.

RED (pre-round-1 sources, new assertion first):
`expected [ { …(4) }, { …(4) } ] to have a length of 1 but got 2` on
`projects an orphaned commit that carries the bot's own words instead of discarding it`, which is
the duplicated dispatch. GREEN: one turn, one reply, no open steer.

## C2: a message queued for a sleeping bot was failed the instant the bot returned

Reconciliation sealed any turn a declaration omitted, with no check of whether the peer had ever
been handed it, and it ran before the outbox flush. A peer that has not received a command cannot
declare it, so `activeTurns: []` was true and read as loss.

Two changes. `#reconcilableTurns` is now the single filter for reconciliation AND for the lease: a
turn counts only when `nativeBotTurnDelivery(owner, turnId).acknowledgedAt` is set, so a durably
queued turn for an absent peer is delivered normally and neither sealed nor leased. And the ingress
calls `onHello` AFTER `#flush`, so the ordering is unambiguous rather than incidental.

RED: `expected { status: 'failed' } to be undefined` on
`never seals a turn the peer has not been handed yet, and never promotes one`. GREEN: nothing
sealed, nothing promoted, one queued turn and one queued steer still waiting.

## I1: the lease could reap a live run

A heartbeat-terminated socket marked every turn lost, and an older peer cannot take one back off
the lease at hello, so a peer inside one long prefill-bound call faced 120 seconds of frame silence
rather than 30 minutes. polished-satellite already spends 49 seconds in one such call.

The two situations are now different windows, and which one applies is recorded when ownership is
lost rather than inferred later:

- `detached`: the peer has no socket. `OWNER_LOSS_LEASE_MS`, 120 seconds, unchanged.
- `undeclared`: the peer re-attached but could not declare. `UNDECLARED_OWNER_GRACE_MS`, 10
  minutes, well past any observed prefill stall and still far short of the ceiling.

Any frame resets either window, and neither ever lengthens a window an operator shortened. New
test: a re-attached older peer, 60 seconds silent, is not reaped, and one `thinking` frame resets
the window.

## I2 and I3: pending steers are durable, ordered, and never silently dropped

`bot_native_pending_steers` is a durable table keyed by `(bot, messageId)`, carrying the text,
media, chat context and origin device, with a `settled_at` that is set exactly once. It replaces
the process-local map entirely.

- several steers on one dead turn are kept in arrival order. The oldest is promoted to the new
  durable turn; the rest are re-dispatched onto that turn as steers, in order, and stay open there.
- every path that does not deliver a person's words now records the visible failed-delivery row:
  no peer, a conversation that moved on, and a refused dispatch alike. Previously only the refused
  dispatch did.
- a restart preserves the steers, so the fallback the first report CLAIMED (I3) now actually
  exists. The report's concern bullet said otherwise and was wrong; it is corrected below.

New tests: two steers promoted in order; a restart that rebuilds the plane on the same store and
still promotes; a refused dispatch that leaves a `delivery.failed` row carrying the text.

## I4: a promoted turn keeps what the dead turn had

Promotion now carries the dead turn's `chatContext` (workspace and model, remembered when the turn
was dispatched and persisted on the steer row so a restart keeps it), its origin device for push
suppression, `recordAcceptedTurn`, and `#sweepStaleDelegations`. It also cancels a steer command
the peer never took off the wire, so a queued steer cannot arrive after the turn that replaced it,
and it broadcasts the rebound user row so a live client does not keep it pinned to a dead turn id.

## I5: a bad declaration no longer closes the socket

`hello.activeTurns` is `Type.Unknown()` on the wire, exactly as capability 56's `detail` and 62's
`repair` are, with `sanitizeActiveTurns` as the sole authority. A declaration that is not an array
of 1 to 256 character ids, or that carries more than 1024 of them, degrades to "cannot declare"
with one bounded log line. It is NEVER truncated: a partial declaration would seal turns the peer
actually holds. Repeated ids collapse, because a repeated id says the same true thing twice.

## Minor items

- `#reconcilableTurns` compares `normalize(owner)` against `normalize(peer)`, so a profile key that
  is not already lowercase no longer silently disables reconciliation and the lease.
- the rebound user row is broadcast.
- `rebindNativeBotMessageTurn` is scoped by `(bot, sessionId, messageId)`.
- `#sealOwnerLoss` is unchanged in shape; the promotion guard is now explicit about the two reasons
  it declines and records the words either way.

## Not changed, and why

The reviewer's "cannot verify" note about the Hermes plugin de-duplicating an inbound turn by
`messageId` stands. Promotion deliberately re-sends the person's ORIGINAL message id, because it is
the same message; if HF1's plugin dedupes on it, promotion would be a no-op on the peer. That is a
question for HF1 and is called out here rather than guessed at. The 120 second and 10 minute
windows remain provisional; .121 is still unavailable.

## Round 1 counts

```
pnpm -r typecheck                                  contract, relay, gateway, conformance: Done
packages/gateway  vitest run (23 focused files)    268 passed (268)
packages/contract vitest run                       207 passed (207)
packages/conformance vitest run                    108 passed | 20 skipped (128)
```

The 23 gateway files are the 16 from round 0 plus `attach-v1-storage`, `attach-boot-replay`,
`attach-deadletter-hygiene`, `attach-v1-captured-session-stress`, `bots-group-turn`,
`native-group-turn` and `attach-adapter-v1`, which is the set the first report named but did not
list. The reconciliation file itself is now 15 tests. Full suite still by the lead.

## Correction to the round 0 report

The "Concerns" bullet claiming a restart falls back to a visible failed-delivery row was wrong when
it was written: after a restart the map was empty and `#promoteSteer` returned before recording
anything, so the restart case was a silent drop. It is now true, because the steers are durable.
