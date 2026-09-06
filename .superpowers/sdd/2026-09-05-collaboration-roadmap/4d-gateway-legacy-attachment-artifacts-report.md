# 4d: Artifact records derived from legacy attachment deliveries

Status: IMPLEMENTED, LOCAL GATES PASS, NOT REVIEWED, NOT MERGED, NOT DEPLOYED.

## Exact heads

- Worktree: `<repos>/worktrees/4d-legacy-attachment-artifacts`, branch
  `codex/4d-legacy-attachment-artifacts`, pushed to origin after every commit.
- Base: `4997ac1` (cozygateway origin/main, capability 66 typed scoped approvals, carrying row 65
  Artifacts).
- Commits on the branch:
  - `31dc1ce` Red: derived Artifacts for legacy attachment deliveries
  - `97e994f` Derive Artifact records from legacy attachment deliveries (capability 65)
  - `0a49163` Bound derivation by the operator ceiling with a visible refusal
- Node 24 for every command: `PATH=/opt/homebrew/opt/node@24/bin:$PATH` (v24.19.0).
  `pnpm install --frozen-lockfile --offline` succeeded; contract, relay and gateway
  `tsc -p tsconfig.build.json` were built because vitest resolves the workspace entries through
  `dist`.
- Scratch logs: `<scratch>/4d/logs/`. No production gateway, no live Hermes profile, no live bot,
  and no other worktree was touched. `.121` UNKNOWN, not attempted.

## What was built

The seam is the one place a peer's attachment becomes a durable, announced fact: `#commit` in
`packages/gateway/src/hermes-bridge/native-data-plane.ts`, where a turn reply or a scheduled
delivery is projected into the transcript with its attachment blocks. Right after that append, the
gateway derives one record per delivered attachment. Nothing else in the delivery path changed.

- `packages/contract/src/artifacts.ts`: closed `ARTIFACT_ORIGINS` (`declared`, `derived`) with
  `ArtifactOriginSchema`; `origin` and `sourceMessageId` optional on `ArtifactSchema`; `sha256` and
  `mark` are now optional, present exactly when a producer declared them.
  `BOTS_CAPABILITY_VERSION` is unchanged at 66: this is additive to row 65, not a new row.
- `packages/gateway/src/artifacts.ts`:
  - `origin` and `source_message_id` columns, with the repo's `PRAGMA table_info` + `ALTER TABLE`
    migration so a store written by row 65 last night widens in place and its existing rows read
    as `declared`.
  - `derive(input, at)`: one record per stored object, pointing at the SAME bytes. Identity is
    `derived-<sha256(peer NUL mediaId) sliced to 32>`, so a redelivery, a replayed commit event and
    a duplicate receipt all name the record that already exists. The staging deadline is cleared
    on those bytes, and the delivery is created already `delivered`, because projecting the row
    into the durable transcript and announcing it IS the platform commitment for that delivery.
  - `acknowledgeMessage(bot, messageId, at)`: the row 31 displayed receipt is the acknowledgement.
  - `commit(...)`: when a derived record already stands for the media being committed, the
    declaration UPGRADES it in place (origin, digest, mark, Task, Run, version, supersession) and
    the separately declared row is removed, so one media has one record under the identity clients
    already discovered. The commit answers with that record.
  - Capacity is now retained BYTES, counted once per stored object
    (`SELECT DISTINCT created_by, media_id, size_bytes`), and a commit over an object already
    retained adds nothing. That is deferred minor M5, fixed here because this packet makes two
    records over one object ordinary rather than exotic.
  - Derivation is bound by the same ceiling. Over it the record is written `commit_failed` with
    `failureReason: "capacity"` and binds no bytes, so the refusal is visible and the attachment
    keeps exactly the retention it already had; a later delivery retries it.
- `packages/gateway/src/storage.ts`: `recordBotMessageDisplayed` acknowledges derived records for
  the ids it just recorded, outside the receipt transaction, so an acknowledgement that could not
  be written never loses the receipt that earned it.
- `packages/gateway/src/hermes-bridge/native-data-plane.ts`: eight lines at the delivery seam.

Nothing was added to `artifact-routes.ts`: a derived record is an Artifact, so listing, reading,
`latest`, `content` and `DELETE` already serve it, and the download acknowledgement already works.

## Contract text

`contract/ext-bots-v1.md` row 65 gained ", and the gateway's own `derived` records for attachments
a peer delivered without declaring one", and the Artifact surface gained a
"Derived records, for peers that never declare one" section. It states: the closed `origin` and its
`declared` default when absent; one record per stored object over the same bytes with the same
discovery, download, deletion, supersession and retention rules; the derivable identity; that a
derived record claims only filename, media type, byte size, Bot and `sourceMessageId`, with
`validation: unvalidated` and `sha256`, `mark`, `taskId`, `runId` ABSENT; that delivery is
`delivered` from the platform commitment and acknowledged from the row 31 receipt; that a
declaration for the same media upgrades in place, answers with the existing identity, and that a
peer MUST read `artifactId` from the commit response; that retention follows the Artifact rule so
deleting the message or the conversation no longer removes the bytes and an explicitly deleted
record is never re-derived; that the ceiling counts each object once and refuses visibly. The
additive paragraph now reads: a client below 65 is byte identical to its pre-65 self, and a client
at 65 written before `origin` existed still decodes every record; only a `derived` one omits
`sha256` and `mark`.

## RED then GREEN

RED (`<scratch>/4d/logs/red-*.log`), all three seams before any source change:

```
pnpm --filter cozygateway-contract exec vitest run test/artifacts.test.ts
  Test Files  1 failed (1)      Tests  1 failed | 3 passed (4)
pnpm --filter cozygateway exec vitest run test/derived-artifacts.test.ts
  Test Files  1 failed (1)      Tests  5 failed (5)
pnpm --filter cozygateway-conformance exec vitest run test/artifact-delivery-fixture.test.ts
  Test Files  1 failed (1)      Tests  1 failed | 3 passed (4)
```

GREEN, after the implementation (`<scratch>/4d/logs/green-*.log`, `typecheck.log`):

```
pnpm -r typecheck                                   exit 0, four packages Done
pnpm --filter cozygateway exec vitest run           Test Files 133 passed | 1 skipped (134)
                                                    Tests 1483 passed | 2 skipped (1485)
pnpm --filter cozygateway-contract exec vitest run  Test Files 19 passed (19)   Tests 193 passed
pnpm --filter cozygateway-conformance exec vitest run
                                                    Test Files 9 passed (9)
                                                    Tests 93 passed | 19 skipped (112)
```

The 2 gateway skips are the pre-existing `mobile-node-hermes-e2e` cases that need
`HERMES_AGENT_ROOT`; the 19 conformance skips are the pre-existing hookless-runner cases. This
packet added 6 gateway tests, 1 contract test and 1 conformance test, so the base counts are 1477,
192 and 92; every pre-existing file passes unchanged. Per the lead's ruling for this run the full
`pnpm -r test` was NOT run; the relay package has only its typecheck and its build as evidence.

## Evidence per completion-criterion item

| Criterion | Where it is proved |
| --- | --- |
| A Hermes-shaped attachment delivery produces one derived record with truthful fields | `derived-artifacts.test.ts` "derives exactly one truthful record for an attachment a peer never declared": a peer that only uploads media and commits a turn reply, exactly the Hermes shape, yields one record with `origin: derived`, the bot, session, `sourceMessageId`, filename, media type and byte size, `state: committed`, `validation: unvalidated`, `delivery: delivered`, and asserts `sha256`, `mark`, `taskId` and `runId` are all absent. |
| Duplicate delivery receipts do not create a second record | Same test: two `recordDisplayed` calls from two devices leave one record and the first `acknowledgedAt`. Also "keeps one record when the same media is delivered again and when the event is replayed": a second delivery of the same media, and a delivery naming media the gateway never stored, both leave the count at one. |
| A capable peer declaring the same media upgrades rather than duplicates | "leaves a capable peer's declaration alone and upgrades a derived record in place": declare + commit before delivery derives nothing (one record, `origin: declared`); delivery before declaration upgrades the derived record in place, the commit answers with the derived identity, the record now carries the declared digest, mark, Task and Run, and the separately declared id no longer resolves. |
| Derived records list, download, delete and retain like declared ones | "lists, downloads, deletes and retains a derived record the way a declared one behaves": `GET /bots/sage/artifacts` lists it, `GET /artifacts/:id/content` serves the exact bytes with the sanitized disposition, `pruneExpiredAttachMedia` past the staging deadline removes nothing, `deleteNativeBotSession` leaves the bytes, `DELETE /artifacts/:id` answers 204 and `content` then answers 410, and a later receipt for the deleted record's message does not resurrect it. |
| Peers and clients below 65 remain byte identical | Same first test asserts the broadcast transcript row carries the identical attachment block and that no frame mentions an artifact. The whole pre-existing gateway suite passes unchanged, including `turn-media-receipts`, `attach-v1-storage`, `attach-v1-delivery-receipts`, `native-bot-scheduled-media` and `native-bot-inline-media-positions`. The conformance suite still asserts `GET /bots/:name/chat/attachments/:fileId` answers its own `ErrorBody` 404. |
| Conformance covers the derived path | `artifact-delivery-v1.json` gained a `derived` record and `artifact-delivery-fixture.test.ts` a case: the derived shape decodes through `ArtifactSchema` and `ArtifactListSchema`, `sha256`, `mark`, `taskId` and `runId` are absent, a record with no `origin` still decodes (the pre-`origin` client), and `origin: "inferred"` is refused. |
| M5, shared media counted once | "counts media shared by two records once against the operator capacity": with the ceiling set to exactly one object, a second record over the same media still commits. |
| Node 24 typecheck plus focused contract, gateway and conformance tests | The GREEN block above. |

## Files changed

`CHANGELOG.md`, `contract/ext-bots-v1.md`,
`packages/conformance/test/artifact-delivery-fixture.test.ts`,
`packages/conformance/test/fixtures/artifact-delivery-v1.json`,
`packages/contract/src/artifacts.ts`, `packages/contract/test/artifacts.test.ts`,
`packages/gateway/src/artifacts.ts`, `packages/gateway/src/hermes-bridge/native-data-plane.ts`,
`packages/gateway/src/storage.ts`, `packages/gateway/test/derived-artifacts.test.ts`.
10 files, 560 insertions, 24 deletions.

## Self-review findings

- First pass had no ceiling on derivation. That was wrong once retention changed: a derived record
  is what makes a staged attachment permanent, so an operator ceiling that only bound declarations
  would have been silently unbounded growth. Fixed in `0a49163` as a visible `commit_failed`
  refusal with the attachment's original retention untouched, plus a retry on the next delivery so
  raising the ceiling is enough.
- Deriving a record with a gateway-computed digest was considered and rejected. The upload route
  does verify a producer-claimed digest, but the record's `sha256` in row 65 means "the declaration
  the commit proved", and a derived record has no declaration. `unvalidated` with no digest is the
  truthful shape the brief asks for. The cost is that `sha256` and `mark` had to become optional,
  which is the one part of this change that is not strictly additive for a strict decoder written
  at 65 before `origin`; only a derived record ever omits them, and the contract says so.
- The upgrade path answers a commit with an artifactId that may differ from the one the peer
  declared, and the peer's own id stops resolving. That is the only way to keep one identity per
  object AND keep the identity clients already discovered. It is stated in the contract, and there
  is no shipped capable producer today, but a future producer must read `artifactId` back.
- Ponytail cuts, and when to revisit them:
  1. Derivation is wired at `#commit` only. The device-to-bot attachment path is not derived: that
     is a person's upload, not a peer delivering an output. Revisit if Artifacts ever mean
     "any file in this conversation" rather than "a Bot's output".
  2. A derived record carries no `room`. The native chat seam has a session, not a room. Add it
     when a room-scoped delivery path exists to read it from.
  3. No `bot_artifact_derived` frame. Clients read the REST record, which is what row 65 already
     established.

## Concerns

- Retention genuinely changes for legacy attachments: the bytes behind a delivered attachment are
  now kept until an explicit Artifact deletion instead of expiring with the producer's staging
  deadline. That is the brief's requirement and wave 2's retention ruling, and it is the reason the
  ceiling now binds derivation, but an operator running without `artifactStoreBytes` will see the
  store grow where it previously self-pruned. Worth a release note beyond the changelog line.
- `sha256` and `mark` becoming optional is a schema relaxation. A pre-`origin` client at 65 that
  requires them will fail on a derived record. No such client has shipped; 4b and 4c are still in
  flight and can adopt `origin` directly.
- The commit-time identity swap on upgrade is a real behavior a future capable producer must be
  written for. Called out in the contract, and worth naming in whatever packet writes that
  producer.
- No live model qualification. `.121` and hosted CI remain unavailable, so live rollover and
  performance for this change are UNKNOWN. All evidence here is deterministic local integration.
  Reproduce later with
  `PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm -r build && pnpm -r typecheck && pnpm -r test`
  against a scratch gateway.
- Base counts (1477 / 192 / 92) are stated by arithmetic from the added tests rather than by a
  separate run of the base tree; every pre-existing test file passes on this branch unchanged.

## Fix round 1 (review r0)

Head after this round: `27df8f9` on `codex/4d-legacy-attachment-artifacts`, pushed. Node 24 for
every command. The three items the lead deferred (orphan `commit_failed` row after a capacity
refusal that a declaration later wins, the schema not expressing the `sha256` / `mark` pairing, and
no `room` on derived records) are untouched.

### I1, a redelivered attachment could never be acknowledged by the later message

`acknowledgeMessage` matched on `source_message_id` alone, so a bot that sent the same file twice
had one record naming the FIRST message, and a receipt for the second acknowledged nothing. The
match is now every message that references the record's media: the record's own
`source_message_id`, or any durable transcript row for that bot whose attachments name the record's
`media_id`. No schema change and no second table; the same JSON reference the retention guards
already use. A receipt for either message acknowledges once, and the later one keeps the first
`acknowledgedAt`. Proved by "acknowledges a redelivered attachment from the later message's
receipt".

### I2, retention was unbounded by default and undeclared to operators

`DEFAULT_ARTIFACT_STORE_BYTES` is 2 GiB, applied by `Artifacts` itself and by `server.ts`
(`config.artifactStoreBytes ?? DEFAULT_ARTIFACT_STORE_BYTES`), so an existing deployment that
changes no config upgrades into a bounded store rather than an unbounded one. Two GiB is far above
what a normal deployment accumulates and far below a disk; an operator raises or lowers it with the
existing `artifactStoreBytes` key. The refusal stays visible: `commit_failed` with
`failureReason: "capacity"`, no bytes bound, the attachment keeping the retention it already had,
and a later delivery retrying once the ceiling is raised.

The operator-facing half is now written down: a new "Artifact retention and the store ceiling"
section in `docs/self-host-docker.md` says plainly that attachments which used to expire are now
retained until the Artifact is deleted, what does and does not reclaim them, the config key with an
example, the 2 GiB default, and what the refusal looks like. The CHANGELOG entry carries the same
warning and the key. The contract's derived-records section says the ceiling is bounded by default.
Proved by "bounds retained artifact bytes by a conservative default when the operator sets none".

### Minors taken

- The `derived-` id space is reserved: `declare` answers a new `reserved` outcome for any id with
  that prefix and the producer route maps it to `400`, so a peer cannot claim a derived identity
  and silently suppress the record for its own attachment.
- The upgrade can no longer produce a self-superseding or dangling record: a declaration that named
  the record it is folded into supersedes nothing, and anything that named the retired declaration
  is repointed at the surviving identity. Proved by "never leaves a dangling or self-referencing
  supersession when it upgrades" plus two assertions added to the existing upgrade test.
- The derive lookup is one query with an explicit `ORDER BY` (the derived identity first, then
  oldest), so it no longer depends on `UNION ALL` row order.
- Derivation moved after `seal?.()` in `#commit`, so a store failure while deriving cannot leave a
  turn unsealed. An Artifact is a secondary fact and must not block a turn's terminal.

### Fix round 1 gates

```
pnpm -r typecheck                                    exit 0, four packages Done
pnpm --filter cozygateway exec vitest run test/derived-artifacts.test.ts test/artifacts.test.ts \
  test/artifact-routes.test.ts test/attach-v1-storage.test.ts test/attach-v1-delivery-receipts.test.ts \
  test/turn-media-receipts.test.ts test/native-bot-scheduled-media.test.ts \
  test/native-bot-inline-media-positions.test.ts test/native-bot-data-plane.test.ts test/config.test.ts
                                                     Test Files 10 passed (10)  Tests 168 passed
pnpm --filter cozygateway exec vitest run            Test Files 133 passed | 1 skipped (134)
                                                     Tests 1487 passed | 2 skipped (1489)
pnpm --filter cozygateway-contract exec vitest run test/artifacts.test.ts        4 passed
pnpm --filter cozygateway-conformance exec vitest run test/artifact-delivery-fixture.test.ts  4 passed
```

RED for this round, before the fixes (`<scratch>/4d/logs/`, same file):
`Test Files 1 failed (1)   Tests 4 failed | 6 passed (10)`, the four new cases for I1, I2, the
reserved id space and the supersession guards. GREEN: `Tests 10 passed (10)`. The whole gateway
package moved from 1483 to 1487 passing, which is the four new cases and no regression; the default
ceiling was run against the whole package deliberately, because it changes startup for every
deployment.
