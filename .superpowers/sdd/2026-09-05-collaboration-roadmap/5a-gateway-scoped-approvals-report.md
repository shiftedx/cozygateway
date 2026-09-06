# 5a: gateway typed scoped approvals with payload binding and category policy

Packet 5a, capability row 66. Worktree `<repos>/worktrees/5a-gateway-scoped-approvals`, branch
`codex/5a-gateway-scoped-approvals`.

## Heads

- Base (reviewed 4a head, PR #370, merge pending): `bada668` "Redact the worktree path in the 4a report"
- `835a13a` Typed scoped approvals with payload binding and category policy (capability 66)
- `e6e9efa` Contract row 66, portable conformance fixture and changelog for scoped approvals
- (this report is the third commit on the branch)

Node 24.19.0 (`/opt/homebrew/opt/node@24/bin`), pnpm 10.30.1.

## What was built

One additive contract row, no second authority. The existing `ApprovalEvent` gains one typed block
and the existing approve route gains one optional body; everything else is the approval path that
was already there.

1. **`BotApprovalScope`** (contract): the typed block an approval may carry. `kind`
   (`scoped_approval`), `action`, `category`, `system`, `resource`, `change`, `effects[]`, `reason`,
   `payloadHash` (lowercase sha256 hex), `expiresAt`, `retry`, `requested`. Every set closed, the
   object closed, every string bounded.
2. **`sanitizeApprovalScope`** (attach protocol): the sole authority, modelled exactly on capability
   62's `sanitizeApprovalRepair`. Schema plus the C0/C1, Unicode Format, lone-surrogate and
   whitespace-only refusal. All or nothing: a failing block is DROPPED and the approval KEPT, which
   fails closed because only a scoped approval can leave or be covered by a grant.
3. **Carried surfaces**: `bot_approval_pending`, the durable interaction payload, the
   `GET /bots/approvals` inbox row, and the reconnect rebroadcast all carry the validated block byte
   for byte, exactly as `repair` is carried.
4. **Binding and grants**: new `bot_approval_grants` table. A `once` grant binds bot (profile),
   deciding device (user), session (conversation), turn (task), system plus resource (target),
   payload hash, and expiration. A `category` grant binds the same minus turn and payload hash, with
   a person-set expiry capped at one day. `grant_id` is derived from the approval, so a retried
   decision writes no second grant.
5. **Consult, never replay**: on a pending scoped approval the gateway asks
   `Storage.standingApprovalGrant`. A `once` grant matches only the same task and the same payload
   hash, and only when the peer called the retry `idempotent`. A `category` grant matches any
   payload of the same action on the same resource. A changed material field changes the hash and
   nothing covers it; an expired or revoked grant matches nothing; the ask's own `expiresAt` bounds
   the consult too.
6. **Always-require list**: `ALWAYS_REQUIRE_APPROVAL_CATEGORIES` = money_movement, secret_access,
   destructive, lock_or_alarm, public_publishing, account_change. No grant of either kind is ever
   RECORDED for one, none is ever CONSULTED for one, and an explicit `grant: "category"` on one is
   `409 approval_category_forbidden`. The per-invocation decision still works.
7. **Relay, not execute**: a covered ask still raises its card, names the grant on
   `bot_approval_pending.grantId`, and settles through the same `resolve_approval` a tapped card
   sends. The peer performs the action; the gateway records nothing about the outcome beyond the
   existing settlement.
8. **Revocation view**: `GET /bots/:name/approvals/grants` and
   `DELETE /bots/:name/approvals/grants/:grantId`. Rows carry no payload hash, no deciding device,
   no payload value. Revocation is immediate: the row leaves every later consult in the same
   statement that marks it.
9. **Decision log**: one bounded content-free log line for a dropped block, and one
   `approval_grant_honored` trace carrying hashed profile, session, approval and grant ids only.

## Contract row 66 (contract/ext-bots-v1.md)

Status header and the discovery example moved from 65 to 66, and this row was added to the history
table:

> | 66 | An approval can name exactly what it would do, and a decision can leave a standing policy:
> `ApprovalEvent` on attach-v1 gains optional `scope`, one typed block a runtime peer sends
> alongside an approval it raises. The block is `BotApprovalScope`: `kind` (`scoped_approval`),
> `action` (the action type, 1-64 characters), `category` (closed: `money_movement`,
> `secret_access`, `destructive`, `lock_or_alarm`, `public_publishing`, `account_change`, `other`),
> `system` (the target system, 1-64), `resource` (the target resource, 1-256), `change` (the exact
> material change in one sentence, 1-400), `effects` (0-16 entries of 1-200 naming what else
> happens), `reason` (`always_require`, `guardrail`, `peer_policy`, `first_use`), `payloadHash`
> (lowercase sha256 hex of the exact payload, the BINDING), `expiresAt` (gateway-clock
> milliseconds), `retry` (`idempotent`, `not_idempotent`, `unknown`) and `requested` (`once`,
> `category`). Every set is closed, the object is closed, and no secret, credential, URL, header or
> env value is ever in a string: `change` and `effects` describe an action, they never carry its
> arguments. The gateway treats the block exactly as capability 62 treats `repair`: it validates the
> closed sets and bounds and refuses any C0/C1 control or Unicode Format (Cf) character, a lone
> surrogate, or a whitespace-only value, and a block that fails is DROPPED while the approval is
> KEPT, with one bounded content-free log line; a valid block is carried byte for byte on
> `bot_approval_pending`, the durable interaction record, the `GET /bots/approvals` inbox row, and
> the rebroadcast a reconnecting app gets. Dropping FAILS CLOSED: a plain approval can leave no
> grant behind and can be covered by none. BINDING AND GRANTS:
> `POST /bots/:name/approvals/:toolCallId/approve` gains an OPTIONAL `BotApprovalDecisionRequest`
> body, `{ grant?: "once" | "category", expiresAt? }`. No body is the pre-66 request and reaches the
> surface unchanged. An approve on a scoped approval records a standing grant bound to profile,
> user, conversation, task, target, payload hash and expiration: `once` covers exactly that payload
> on that task and is consulted only when the peer called the retry `idempotent`, so a mutation is
> never automatically replayed; `category` covers any payload of that action on that resource until
> `expiresAt` (required, in the future, at most one day away, `400 invalid_request` otherwise) or
> revocation. A GRANT IS A POLICY RECORD, never a stored payload to replay: a changed material field
> changes `payloadHash` and no standing approval covers it, and an expired grant is dead whatever
> its scope says. The six always-require categories are covered by NOTHING: no grant of either kind
> is recorded for one, none is ever consulted for one, and `grant: "category"` on one is
> `409 approval_category_forbidden` (`409 approval_scope_required` when the approval carries no
> block to bound a grant by). When a grant does cover an ask, the gateway still raises the card,
> names the grant on `bot_approval_pending.grantId`, and settles it through the same
> `resolve_approval` a tapped card sends: it relays and validates, it never executes.
> `GET /bots/:name/approvals/grants` is the revocation view (`BotApprovalGrant` rows: the grant id,
> its scope, the action, category, system, resource, conversation, expiry and creation time, never
> the deciding device, the payload hash or a payload value), and
> `DELETE /bots/:name/approvals/grants/:grantId` ends one immediately, `404` for a grant this
> gateway does not hold. Decision logs and traces carry ids, reason codes and the grant id only.
> Additive: an approval with no block, and a decision sent with no body, are byte identical to their
> pre-66 selves on every surface, and a peer emits `scope` only when the gateway advertised
> `com.cozylabs.bots >= 66` on `hello_ack`; a client renders the card, sends a body, or opens the
> revocation view only on `>= 66`. |

`contract/attach-v1.md` gained the matching `approval` bullet beside the capability-56 `detail` and
capability-62 `repair` bullets.

## RED then GREEN

RED, before any implementation existed, with the seam test written first
(`packages/gateway/test/native-bot-scoped-approvals.test.ts`):

```
$ cd packages/gateway && npx vitest run test/native-bot-scoped-approvals.test.ts
 FAIL  test/native-bot-scoped-approvals.test.ts
 AssertionError: expected undefined to be '{"kind":"scoped_approval",...}'    (block not carried)
 AssertionError: expected 'requested' to be 'category_forbidden'              (no always-require rule)
 TypeError: plane.surface(...).approvalGrants is not a function               (no grant store)
 Test Files  1 failed (1)
      Tests  6 failed | 4 passed (10)
```

(The four that "passed" red were the drop-the-invalid-block and pre-66-byte-identity cases, which
pass vacuously while the field does not exist; they are the guards that must stay green afterwards.)

GREEN, same command after implementation:

```
$ cd packages/gateway && npx vitest run test/native-bot-scoped-approvals.test.ts
 ✓ test/native-bot-scoped-approvals.test.ts (10 tests) 40ms
 Test Files  1 passed (1)
      Tests  10 passed (10)
```

Focused approval seam, live and route, including the capability-56/62 neighbours that must not move:

```
$ cd packages/gateway && npx vitest run test/bots-approval-grants-routes.test.ts \
    test/native-bot-scoped-approvals.test.ts test/native-bot-approval-repair.test.ts \
    test/bots-pending-approvals-routes.test.ts test/approvals.test.ts
 Test Files  5 passed (5)
      Tests  37 passed (37)
```

Package suites for every package touched (Kyle's ruling for this run: focused tests plus
`pnpm -r typecheck`, no full `pnpm -r test`):

```
$ cd packages/contract    && npx vitest run    Test Files 19 passed (19)   Tests 192 passed (192)
$ cd packages/gateway     && npx vitest run    Test Files 132 passed | 1 skipped (133)
                                               Tests 1467 passed | 2 skipped (1469)
$ cd packages/conformance && npx vitest run    Test Files 9 passed (9)
                                               Tests 92 passed | 19 skipped (111)
$ pnpm -r typecheck
  packages/contract typecheck: Done
  packages/relay typecheck: Done
  packages/gateway typecheck: Done
  packages/conformance typecheck: Done
```

(The gateway and conformance typechecks need `packages/contract` and `packages/gateway` built
first; `pnpm build` was run in each before the workspace typecheck.)

## Evidence per completion-criterion item

| Criterion | Evidence |
| --- | --- |
| Payload-hash mismatch forces re-approval | `native-bot-scoped-approvals.test.ts` "honors a standing once grant for the same payload hash and refuses a changed one": approval-2 (same hash) is relayed, approval-3 (changed `change`, changed hash) is not. |
| Expired approval replay is refused | Same file, "refuses to replay an expired grant regardless of category policy": grant expires at 2000, clock moved to 3000, the identical ask is not covered. `Storage.standingApprovalGrant` also filters `expires_at > ?`. |
| Category approval bounded by scope and expiry, honored only within bounds | Same file, "honors a category grant across payloads inside its bounds and never outside them": a different payload on the same resource is covered, a different resource is not. A `grant: "category"` whose `expiresAt` is past or beyond the one-day ceiling is `400` (route test). |
| Always-require list blocks a category grant | Same file, "blocks a category grant over an always-require action and never consults one": `category_forbidden`, then a plain approve leaves zero grants, then the identical later ask is not covered. Route mapping to `409 approval_category_forbidden` in `bots-approval-grants-routes.test.ts`. |
| Revocation removes a standing category grant immediately | Same file, "removes a standing category grant the moment it is revoked": revoke, view empty, the next matching ask is not covered. Route `DELETE` coverage in the route test. |
| Portable route conformance: peers below 66 byte identical | `packages/conformance/test/scoped-approvals-fixture.test.ts` "keeps a peer and a client below 66 byte identical to their pre-66 selves" pins the pre-66 pending frame keys, the pre-66 inbox row keys and the empty decision body. Gateway side: "leaves an approval without a block byte identical to its pre-66 self" pins the frame, the durable payload and the inbox row; `bots-approval-grants-routes.test.ts` pins that a body-less approve reaches the surface with the pre-66 ARITY, and that a deny never reads a body. `native-bot-approval-repair.test.ts` (capability 62) still passes unchanged. |
| Node 24 build/typecheck/tests | Counts above, Node 24.19.0. Full `pnpm -r test` deliberately NOT run: the lead runs the batched heavy gate. |
| .121 and hosted billing | UNKNOWN. No live model qualification and no hosted CI run was attempted; nothing in this packet needs a model. Reproduction later: point a CozyAgents peer at `http://192.168.99.121:1234/v1` (`qwen3.8-27b-nvfp4`), have it raise a scoped approval, and check the card, the grant and the revocation view. |

## Files changed

Source:
- `packages/contract/src/ext-bots.ts`: `BotApprovalCategorySchema`, `ALWAYS_REQUIRE_APPROVAL_CATEGORIES`, `BotApprovalScopeSchema`, `BotApprovalGrantSchema`, `BotApprovalGrantsSchema`, `BotApprovalDecisionRequestSchema`; optional `scope` and `grantId` on `BotApprovalPendingFrameSchema`; optional `scope` on `BotPendingApprovalSchema`; `BOTS_CAPABILITY_VERSION` 65 to 66.
- `packages/gateway/src/adapters/attach/protocol-v1.ts`: `ApprovalEvent.scope` (untyped on the wire, as `repair` is) and `sanitizeApprovalScope`.
- `packages/gateway/src/storage.ts`: `bot_approval_grants` table and index; `recordApprovalGrant`, `approvalGrants`, `revokeApprovalGrant`, `standingApprovalGrant`; `scope` projected on `pendingNativeApprovals`; grants added to the session-delete and `purgeBot` sweeps.
- `packages/gateway/src/hermes-bridge/native-data-plane.ts`: scope validation and storage on ingest, the consult, `#honorApprovalGrant`, grant recording on a fresh approve, `#approvalGrants`, `#revokeApprovalGrant`, `APPROVAL_GRANT_MAX_MS`.
- `packages/gateway/src/hermes-bridge/approvals.ts`: `BotApprovalDecisionScope`, outcomes `category_forbidden`, `scope_required`, `invalid_grant`.
- `packages/gateway/src/hermes-bridge/bridge.ts`: `BotsSurface.resolveApproval` optional fifth argument, optional `approvalGrants` and `revokeApprovalGrant`.
- `packages/gateway/src/hermes-bridge/routes.ts`: optional approve body, the two new extension error codes, the two grant routes.

Docs: `contract/ext-bots-v1.md`, `contract/attach-v1.md`, `CHANGELOG.md`.

Tests: `packages/gateway/test/native-bot-scoped-approvals.test.ts` (new, 10),
`packages/gateway/test/bots-approval-grants-routes.test.ts` (new, 7),
`packages/conformance/test/scoped-approvals-fixture.test.ts` plus
`packages/conformance/test/fixtures/scoped-approvals-v1.json` (new, 8),
`packages/contract/test/bots-approvals.test.ts` (6 added, 2 key lists extended),
version pins moved to 66 in `packages/contract/test/ext-bots.test.ts`,
`packages/contract/test/artifacts.test.ts`, `packages/gateway/test/bots-delete-routes.test.ts`.

## Self-review findings

- The first draft passed a fifth argument (`undefined`) to `chat.resolveApproval` on every
  body-less approve, which broke the existing capability-27 route test. That test was right: a
  pre-66 request must reach the surface unchanged down to the arity. The route now branches, and the
  route test pins it.
- A NUL byte was written literally into the new test file, breaking the "no control byte in this
  source" habit the capability-56 code documents. It is now the same `u0000` escape the repair test
  uses.
- `BotApprovalGrantSchema` is an open object like every other contract object, so an extra
  `payloadHash` or `deviceId` VALIDATES. The contract test therefore asserts the schema's property
  list rather than pretending validation forbids it, which is the stronger claim: the shape names no
  member a payload value could ride out on.
- A dropped scope block leaves a plain approval, which can neither leave nor be covered by a grant.
  That is the fail-closed direction and it is now stated in the code, the row and the attach bullet.
- `sanitizeApprovalScope` refuses control characters in `change` and `effects` rather than stripping
  them the way capability 56 strips `detail`. That is deliberate: unlike `detail`, this block decides
  policy, so a malformed one should not be half-shown. The cost is that one bad character in the
  description sentence costs the whole card; the approval itself always survives.

## Ponytail: what was skipped

- No resource PREFIX or wildcard scoping. A category grant is bounded to the exact resource the
  approval named. Add prefix scope when a real client asks for "any file under this directory", and
  put the matching rule in the contract row before the code.
- No grant list on the interaction inbox and no per-grant usage counter. A person sees which grant
  settled an ask on the frame and can list and revoke; counting how often a grant fired is a
  reporting feature, not a safety one.
- No cross-conversation grants. Every grant is bound to the conversation it was made in, which is
  the safest reading of the binding rule; widening it is a decision, not a refactor.

## Concerns

1. **Honoring is a real behaviour change, gated on the block.** The gateway now relays an approve on
   its own when a standing grant covers the ask. That is what "a category approval is honored within
   its bounds" has to mean to be testable, and it stays a relay (the peer acts, the card is still
   raised and names the grant). It is invisible to a peer below 66 because such a peer sends no
   block. If the lead reads the settled ruling as "the gateway may only ANSWER a consult and never
   relay a decision", the change is small: drop `#honorApprovalGrant` and keep `grantId` on the
   frame as an advisory the client acts on.
2. **`retry: "idempotent"` is the peer's own claim.** A `once` grant is only ever consulted on that
   claim. It is bounded by the same turn, the same target, the same payload hash and the ask's own
   expiry, so a lying peer buys itself a repeat of one identical idempotent call inside one turn,
   never a mutation and never a second target. Named here rather than hidden.
3. **A second decision on the same approval cannot upgrade a once grant to a category grant.** The
   grant id is derived from the approval, so the first fresh admission wins and a later
   `grant: "category"` on the same approval returns `already_requested` with no new record. A person
   who wants a category grant asks for one on the decision they make; there is no upgrade path yet.
4. **Grants are not swept.** An expired grant stays in the table (invisible to every read and every
   consult) until its bot is deleted or its session is deleted. That is the same posture the
   terminal interaction rows had before their trim; a retention sweep is worth adding if this table
   turns out to grow.
5. **Two route-table cells use the em-dash placeholder** the rest of that table already uses for an
   empty request cell. Prose everywhere in this packet has none; changing the glyph on two rows would
   have made the table inconsistent with its other forty.
6. **UNKNOWN**: no `.121` qualification and no hosted CI. Deterministic fixtures, the seam tests and
   the portable conformance fixture are the qualification for this packet.

## Fix round 1

Review: `review-r0.md` (independent, Opus 5 high). Spec compliance PASS; blocking C1, I1, I2, I3,
plus I4 as a docs correction. Head after this round: `1d88538`, pushed. The lead settled report
concern 1: auto-answering a covered CATEGORY grant is the roadmap's "no prompt, covered by user
policy" level, stays relay-only, and is kept.

### C1: a plain approve created a standing grant nobody asked for

`native-data-plane.ts` recorded a grant whenever the decision was an approve on a scoped approval,
consulting `grantRequest` only for WHICH KIND. A body-less approve, which is every client below 66
and every plain tap of Approve, therefore wrote an unlimited-use standing policy whose expiry came
straight from the peer's block.

Now: no grant is recorded unless `grantRequest.grant` is present. A `once` grant is single use, and
the claim and the spend are one transaction (`Storage.claimApprovalGrant`), so two asks arriving
together cannot both take it. Its expiry is `min(scope.expiresAt, now + APPROVAL_ONCE_GRANT_MAX_MS)`
with the ceiling at ten minutes, the same bound the durable interaction record already falls back
to, so a peer value can only shorten it. A spent grant is dead: absent from the view and from every
later consult.

### I1: a duplicate decision reported success for a policy it did not create

The `already_requested` branch returned before the grant block, so a person tapping Approve and then
choosing a category policy got `202 requested` and nothing. Now both the `requested` and
`already_requested` branches run one shared recording path: the grant the person asked for is
created if the decision carries none, and a second, different one answers the new outcome
`grant_not_recorded`, which the route renders as `409 approval_grant_not_recorded` saying the
decision stands and the policy was not created.

### I2: an auto-approved ask was un-deniable and lost its reason on reconnect

`grantId` is now persisted on the durable interaction payload (`Storage.attachInteractionGrant`,
written BEFORE the relay so a reconnect in between still shows it), projected on
`BotPendingApproval.grantId` and re-emitted on the reconnect rebroadcast. A deny on an ask the
gateway settled from a grant now REPLACES the gateway's own requested marker instead of returning
`409 approval_resolution_pending`: `requestNativeInteractionResolution` takes an `override` flag,
used only when the payload names a covering grant and the standing requested decision is the
gateway's approve, and the replacement command carries its own outbox id. A second decision the
gateway did not make still conflicts exactly as before, and the first TERMINAL is untouched, because
this replaces a requested marker and the peer's terminal remains the only proof.

### I3: a grant could decide while being invisible

`approvalGrants` and the consult now read ONE bounded window (`LIVE_APPROVAL_GRANT` plus
`APPROVAL_GRANT_WINDOW`, newest first): a grant outside the view is consulted by nothing. Revoked,
spent and expired grants are dead in both.

### I4 and M4: contract prose

Row 66 and the attach bullet now say that `category` is ASSERTED BY THE PEER, that the gateway
cannot classify an action at this seam, and that the guarantee is only that a peer-declared
always-require category is never covered by a grant, with classification owned by the raising
harness (packet 5b) and the `change` sentence as the person's independent check. The row also now
states the explicit-grant rule, the once-grant bounds, the duplicate-decision answer, the persisted
`grantId` and the deny path, and the shared window. M4 fixed: the row 66 line was separated from the
capability table by blank lines and rendered as a paragraph of pipes; it is contiguous again.

Not taken in this round, unchanged from the review's own triage: M1 (peer strings in the grant row,
the same posture as rows 56 and 62), M3 (a decision body without `application/json` is ignored,
which now yields no grant at all rather than a wrong one), M5 (the two em-dash placeholder cells,
lead's call), M6 (the two expirations, now bounded by C1's ceiling). M2 is closed: the expired-grant
test carries a second case with a FRESH ask over an expired grant, which reaches the storage filter.

### Covering tests

- `packages/gateway/test/native-bot-scoped-approvals.test.ts` (15 tests): "records no standing grant
  for a plain approve, so the next identical ask asks again" (C1), "covers exactly one later ask
  with an explicit once grant, and asks again after that" (C1), "bounds a once grant by the ask and
  by its own ceiling, never by the value the peer chose" (C1), "creates the grant a duplicate
  decision asks for, and never reports one it did not create" (I1), "says what covered an
  auto-approved ask on the rebroadcast and the inbox, and lets the person deny it" (I2), "keeps
  every grant that can auto-approve inside the view a person can revoke from" (I3, at the 101st
  grant), "refuses to replay an expired grant regardless of category policy" (now with the fresh-ask
  case, M2).
- `packages/gateway/test/bots-approval-grants-routes.test.ts` (8 tests): "answers 409 rather than
  success when the decision stands but the grant was not created" (I1 at the route).
- `packages/contract/test/bots-approvals.test.ts`: `grantId` on the inbox row shape and its position
  in the pinned key list.
- `packages/conformance/test/scoped-approvals-fixture.test.ts` plus its fixture: `inboxRowCovered`
  proves the attribution survives to a cold inbox read (I2) and the always-require case is restated
  as a peer assertion (I4).

### Commands and counts

RED, with the new cases written before any of the fixes:

```
$ cd packages/gateway && npx vitest run test/native-bot-scoped-approvals.test.ts
 × records no standing grant for a plain approve, so the next identical ask asks again
 × covers exactly one later ask with an explicit once grant, and asks again after that
 × bounds a once grant by the ask and by its own ceiling, never by the value the peer chose
 × creates the grant a duplicate decision asks for, and never reports one it did not create
 × says what covered an auto-approved ask on the rebroadcast and the inbox, and lets the person deny it
 × keeps every grant that can auto-approve inside the view a person can revoke from
 Test Files  1 failed (1)
      Tests  6 failed | 9 passed (15)
```

GREEN:

```
$ cd packages/gateway && npx vitest run test/native-bot-scoped-approvals.test.ts
 Test Files  1 passed (1)
      Tests  15 passed (15)

$ cd packages/gateway && npx vitest run test/bots-approval-grants-routes.test.ts \
    test/native-bot-scoped-approvals.test.ts test/native-bot-approval-repair.test.ts \
    test/native-bot-approval-detail.test.ts test/bots-pending-approvals-routes.test.ts \
    test/approvals.test.ts test/attach-v1-storage.test.ts test/attach-v1-ingress.test.ts \
    test/attach-v1-protocol.test.ts test/bots-rooms-interactions.test.ts \
    test/bots-delete-routes.test.ts test/native-bot-data-plane.test.ts
 Test Files  12 passed (12)
      Tests  211 passed (211)

$ cd packages/contract    && npx vitest run   Test Files 19 passed (19)   Tests 192 passed (192)
$ cd packages/conformance && npx vitest run   Test Files 9 passed (9)     Tests 92 passed | 19 skipped (111)
$ cd packages/gateway     && npx vitest run   Test Files 132 passed | 1 skipped (133)
                                              Tests 1473 passed | 2 skipped (1475)
$ pnpm -r typecheck
  contract, relay, gateway, conformance: Done
```

The shared resolution path in `storage.ts` is touched by the `override` flag, so the gateway package
suite was run whole (1473 passed, up 6 from 1467 with the new cases). Full `pnpm -r test` still not
run: the lead owns that gate. `.121` and hosted CI remain UNKNOWN.

### Fix round 1 addendum: plain approvals are bound too

Kyle's ruling: Hermes peers get no code changes, and the gateway derives as much benefit for them as
it can. Head after this addendum: `ef441c6`, pushed.

**What a plain ask has to bind on.** Nothing. On this wire an `ApprovalEvent` carries no structured
arguments at all: row 10's ruling is that the free-text `command` and `description` Hermes sends are
never forwarded, and `BotApprovalPendingFrame` deliberately has no `argSummary` member. The only
deterministic content a plain ask has is its rule NAME plus the capability-56 `detail` sentence the
peer sent to say what the ask concretely covers, both of which are already validated and already
carried. `plainApprovalScope` hashes those two into the same payload binding a typed ask gets
(`sha256("plain\n<name>\n<detail>")`) and fills the rest of the binding from them: `action` is the
rule name, `resource` is the sentence, and `system` is the constant `attach`, its own namespace, so a
derived binding can never match a grant a typed peer made against a real system it named.

**Uncoverable asks, named.** A plain ask with no `detail`, a rule name outside the grant row's 1 to
64 bound, or a sentence longer than the row's 256, has nothing that identifies ONE ask rather than a
KIND of ask. Binding to a bare rule name would cover asks a person never saw, so such an ask is
uncoverable: asking for a grant on it answers `409 approval_scope_required`, and no later ask is ever
covered. Truncating to fit was rejected: a truncated binding is a wider binding.

**Nothing changes below 66.** The derived scope is internal. It is never emitted on a frame, never
stored on the interaction record, and never sent to a peer, so a plain approval's frame, durable
payload, inbox row and settlement are byte identical to their pre-66 selves, which the second test
below pins. A grant can only exist because a client at 66 asked for one, so a deployment with no
66 client behaves exactly as before.

**What it honestly cannot promise**, now stated in row 66 and the attach bullet: a plain ask declares
no category, so the gateway records `other` and the always-require exclusion cannot bite on it; and
it claims no idempotency, so once coverage of a plain ask rests on the person's own single-use grant,
the same task and the ask's own expiry rather than on a peer claim (`#claimGrant` takes an explicit
`derived` flag rather than reading a `retry` nobody set).

Covering tests, `packages/gateway/test/native-bot-scoped-approvals.test.ts`:
"covers a later identical plain approval from a grant a person made on the plain card" (a once grant
covers exactly one, then a category grant covers repeatedly, then a different sentence is not
covered) and "refuses to cover a plain approval that carries no deterministic content" (both grant
kinds refused with `scope_required`, no grant recorded, no later coverage, and the card's key set
still the pre-66 one).

```
RED  $ cd packages/gateway && npx vitest run test/native-bot-scoped-approvals.test.ts
     × covers a later identical plain approval from a grant a person made on the plain card
       AssertionError: expected 'scope_required' to be 'requested'
     Test Files  1 failed (1)
          Tests  1 failed | 16 passed (17)

GREEN $ cd packages/gateway && npx vitest run test/native-bot-scoped-approvals.test.ts
     Test Files  1 passed (1)
          Tests  17 passed (17)

$ cd packages/gateway     && npx vitest run   Test Files 132 passed | 1 skipped (133)
                                              Tests 1475 passed | 2 skipped (1477)
$ cd packages/contract    && npx vitest run   Test Files 19 passed (19)   Tests 192 passed (192)
$ cd packages/conformance && npx vitest run   Test Files 9 passed (9)     Tests 92 passed | 19 skipped (111)
$ pnpm -r typecheck                           contract, relay, gateway, conformance: Done
```

The uncoverable test passed RED as well as GREEN: nothing was coverable before the change, so it is
the guard that the derivation did not widen anything, not a case the change made pass.
