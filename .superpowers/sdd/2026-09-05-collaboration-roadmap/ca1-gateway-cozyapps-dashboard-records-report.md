# CA1 report: gateway CozyApps v2 dashboard records

## Heads

- Base: `4997ac174f22c6fda02a10f42c4adbceaa5b28f9` (cozygateway `origin/main`, rows 65 Artifacts and 66 scoped approvals)
- Branch: `codex/ca1-cozyapps-dashboard-records`, worktree `<repos>/worktrees/ca1-cozyapps-dashboard-records`
- Head: `2a64540` (pushed)
- Commits, oldest first:
  - `de6b99f` Add cozyapps v2 dashboard record schemas to the contract
  - `bdfea5d` Store and serve the cozyapps v2 dashboard records
  - `02f01ba` Carry the cozyapps v2 records over a gated attach lane
  - `2a64540` Contract the cozyapps v2 records and add the portable conformance fixture

## What was built

`com.cozylabs.cozyapps` becomes 2, a document-contract version. Three additive record kinds sit
beside the v1 library. Nothing above them changed.

1. **Saved editable input value.** `cozy_app_values`, keyed `(app_id, value_id)`, typed to product
   field types only (`string`, `number`, `boolean`, `date`, `selection`). Its revision is its own,
   independent of the app tree's. `PUT /cozyapps/:id/values/:valueId` takes
   `{expectedRevision, idempotencyKey, type, value}`; a stale write answers `409` with `current`,
   and replaying the key that last wrote a value returns the prior result and writes nothing. This
   is the ONLY write path: no attach frame reaches the table.
2. **Action receipt with a source-attributed snapshot.** The receipt is a projection of the
   existing `cozy_app_actions` row, not a parallel table. `requested` presents as `queued`,
   `delivered` as `running`, `completed` and `failed` unchanged. Three additive nullable columns
   carry the binding (`app_revision`, `value_revisions_json`) and the bot's snapshot (`data_json`).
   `GET /cozyapps/:id/receipts` serves them.
3. **The small versioned envelope.** `cozy_app_dashboards` holds
   `{id, revision, owner, creatorBot, documentVersion, document, data, updatedAt}` with its own
   revision. `document` is a bounded typed dashboard: sections of closed component kinds
   `metric`, `text`, `list`, `chart`, `input`, `action`, with semantic `valueRef` and labels. The
   gateway validates structure and bounds and never interprets it.

The bot-side half is gated on a new attach-v1 capability literal `cozyapps_dashboard`, negotiated
beside the flat `cozyapps` literal, following the `memory_management` / `memory_ownership`
precedent. Two new events (`cozyapp_dashboard_upsert`, `cozyapp_action_receipt`) require it; the
`cozyapp_action` command's optional `values` is present only for a peer that negotiated it.

## Contract text added

### `contract/ext-cozyapps-v1.md`, new section

The full section is in the file. Its load-bearing sentences:

> `com.cozylabs.cozyapps: 2` is a document-contract version. It adds three durable record kinds
> beside the v1 library and changes nothing above. Every v1 route, frame, node and action behavior
> is byte identical for a peer or client that does not negotiate the new attach capability and does
> not call the new routes; `CozyApp` and `CozyAppAction` gain no member, because the shipped client
> decoder refuses an unknown key on both.

> Kyle's live bots run the Hermes cozygateway plugin, which this row does not update: a Hermes peer
> stays at cozyapps 1, keeps v1 behavior unchanged, and still gets everything the gateway derives
> without it.

> THIS IS THE ONLY WRITE PATH: a saved value is written by the user action, and no attach frame
> reaches it. A bot READS values, which ride to it on the action command below.

> The gateway derives `queued` when it accepts the action and `running` when the peer acknowledges
> the command, so a v1 peer produces both without changing. HTTP ACCEPTANCE AND MODEL OUTPUT ARE
> NEVER A COMPLETED ACTION: only the peer's own terminal event settles one.

> There is no member for a colour, font, coordinate, HTML fragment, script, URL scheme, permission
> or executable tool, and `valueRef` admits no `:` or `/`, so no URL can occupy it. Bounds are
> <=12 sections, <=24 components per section, <=100 components, unique ids, and <=32KiB serialized;
> a bounded string carries no C0/C1 control, Unicode Format character or lone surrogate. THE
> GATEWAY VALIDATES STRUCTURE AND BOUNDS AND NEVER INTERPRETS THE DOCUMENT.

> Server schedules, notifications and thumbnails are out of scope for this version: the existing
> server-owned Bot Routines path stands, and artwork is client-local presentation. Gateway bot
> deletion purges the new records with the app.

### `contract/ext-bots-v1.md`, row 68

> | 68 | CozyApps dashboard records: saved editable input values, action receipts with
> source-attributed data snapshots, and the small typed document envelope. THIS ROW IS A
> CROSS-REFERENCE ONLY. It is carried by `com.cozylabs.cozyapps: 2` and the attach-v1
> `cozyapps_dashboard` capability, not by a `com.cozylabs.bots` version: the bots capability stays
> at 66 here, because 67 is reserved for device terminal states and a client comparing `>=` must
> never read a bots version as proof of a row that does not exist yet. See
> `contract/ext-cozyapps-v1.md`, section CozyApps 2, for the routes, frames, bounds and the
> derivation a peer at cozyapps 1 gets for free. |

`BOTS_CAPABILITY_VERSION` is deliberately NOT advanced. Advertising 68 while 67 does not exist
would tell every `>=` client that 7a's device terminal states are present. The real gate for this
row is `com.cozylabs.cozyapps: 2` plus the attach literal. Flagged for the lead below.

## RED then GREEN evidence

Node 24 (`PATH=/opt/homebrew/opt/node@24/bin:$PATH`), run from the worktree. Raw captures are under
the packet scratch directory.

### 1. Contract seam

RED, before any schema existed:

```
packages/contract $ npx vitest run test/cozyapps-dashboard.test.ts
 Test Files  1 failed (1)
      Tests  6 failed | 2 passed (8)
TypeError: (0 , cozyAppReceiptStatus) is not a function
```

GREEN, after `packages/contract/src/cozyapps.ts`:

```
packages/contract $ npx vitest run test/cozyapps-dashboard.test.ts
 Test Files  1 passed (1)
      Tests  8 passed (8)

packages/contract $ npx vitest run
 Test Files  20 passed (20)
      Tests  200 passed (200)
```

### 2. Storage seam

RED, before any table or method existed:

```
packages/gateway $ npx vitest run test/cozyapps-dashboard-records.test.ts
 Test Files  1 failed (1)
      Tests  10 failed (10)
```

GREEN:

```
packages/gateway $ npx vitest run test/cozyapps-dashboard-records.test.ts
 Test Files  1 passed (1)
      Tests  10 passed (10)
```

### 3. Route seam

RED:

```
packages/gateway $ npx vitest run test/cozyapps-dashboard-routes.test.ts
 Test Files  1 failed (1)
      Tests  5 failed | 1 passed (6)
```

GREEN:

```
packages/gateway $ npx vitest run test/cozyapps-dashboard-routes.test.ts
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

### 4. Attach-frame seam

RED:

```
packages/gateway $ npx vitest run test/cozyapps-dashboard-attach-v1-e2e.test.ts
 Test Files  1 failed (1)
      Tests  2 failed (2)
```

GREEN:

```
packages/gateway $ npx vitest run test/cozyapps-dashboard-attach-v1-e2e.test.ts
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

### 5. Gates

```
$ pnpm -r typecheck
packages/contract typecheck: Done
packages/relay typecheck: Done
packages/gateway typecheck: Done
packages/conformance typecheck: Done

packages/gateway $ npx vitest run
 Test Files  135 passed | 1 skipped (136)
      Tests  1495 passed | 2 skipped (1497)

packages/conformance $ npx vitest run
 Test Files  10 passed (10)
      Tests  99 passed | 19 skipped (118)
```

The full `pnpm -r test` is the lead's batch gate and was not run here, per the dispatch ruling.
Every package this packet touches was run in full: contract 200, gateway 1497, conformance 118.

## Evidence per completion-criterion item

1. **Schema export and round-trip.** `packages/contract/test/cozyapps-dashboard.test.ts`
   "round-trips one typed document through the schema unchanged" compares the serialized document
   before and after `assertValidCozyAppDocument`.
   `packages/gateway/test/cozyapps-dashboard-records.test.ts` "round-trips the typed document
   through storage unchanged" does the same across a SQLite write and read.
   `packages/gateway/test/cozyapps-dashboard-routes.test.ts` "round-trips the envelope through the
   route unchanged" does it across HTTP, and asserts the envelope's exact member set.
   `packages/gateway/test/cozyapps-dashboard-attach-v1-e2e.test.ts` does it across the attach wire.
   The version/fixture export is `packages/conformance/test/fixtures/cozyapps-dashboard-v1.json`
   with `packages/conformance/test/cozyapps-dashboard-fixture.test.ts` (7 tests), which pins the
   capability floor, the three closed sets, the document, the envelope and the receipts.
2. **Old-client and unknown-document rejection.** The attach e2e test "gives a peer that stays at
   cozyapps 1 unchanged v1 behavior plus everything the gateway derives" asserts the dashboard
   event is acked `discarded: true, reason: "capability_not_negotiated"`, that
   `GET /cozyapps/:id/dashboard` stays `404`, and that the `cozyapp_action` command that peer
   receives has exactly the four pre-2 keys. The route test "leaves every v1 route byte identical"
   asserts the exact member sets of the summary, the app and the `202` action body. The contract
   test "leaves the v1 action payload byte identical" asserts `CozyAppActionSchema` still refuses
   both a public status name and a new member. Unknown and out-of-bounds documents are refused in
   the contract test (6 shapes), the route test (`400`, envelope revision unchanged at 1), and the
   conformance fixture (9 refused documents including colour, font, coordinates, a script URL, an
   https URL, an executable tool, duplicate ids and an unknown top-level member).
3. **Value revision conflicts and idempotency replay.** Storage test "refuses a stale write with
   the current value" and "replays an idempotency key with the prior result and writes nothing a
   second time" (the replay asserts the revision did not advance). Route test "writes a saved
   value, replays its key, and answers a stale write 409 with the current value". Type mismatch is
   covered by "refuses a value that is not a product field type of its declared kind" at both
   seams; nested JSON, an unknown type, a negative revision and a smuggled `permissions` member are
   all refused in the conformance fixture.
4. **Action receipt lifecycle across restart.** Storage test "keeps every receipt state across a
   process restart with no lost or duplicated terminal": four actions are driven to `queued`,
   `running`, `completed` and `failed`, the store is closed, a new store is opened on the same file
   path, all four read back with the same public names, a duplicate settle with a different terminal
   returns `false` and does not change the record, and a delivery mark on a settled action returns
   `false`.

Deterministic fixtures and conformance are the qualification. The `.121` endpoint is unavailable:
live model rollover and performance qualification are UNKNOWN for this packet. No live gateway, no
production host and no Hermes profile was touched; scratch output went to the packet scratch
directory only.

## What a v1 (Hermes) peer gets by derivation

Kyle's live bots run the Hermes cozygateway plugin, which neither packet updates. Such a peer
negotiates `cozyapps` and not `cozyapps_dashboard`. Without any peer change it gets:

- **Every v1 behavior unchanged.** Its `cozyapp_upsert`, `cozyapp_action_status` and the
  `cozyapp_action` command it receives are byte identical to their pre-2 selves. Asserted by the
  member-set check in the attach e2e test.
- **A public `queued` receipt** the moment the gateway accepts the action, derived from the
  unchanged internal `requested`.
- **A public `running` receipt** the moment that peer acknowledges the command on the wire. This is
  new plumbing on the gateway side only: an `onCommandDelivered` hook on the attach ingress fires
  on the command ack and stamps the existing `delivered` state. The peer sends nothing new.
- **User-written saved values.** A value is written by the user route and never by a bot, so it
  works for any creator bot at any version. Asserted in the v1 half of the attach e2e test.
- **`completed` / `failed`** from its existing `cozyapp_action_status`, unchanged.

What it does not get: the document envelope, which is simply absent for a v1 app
(`GET /cozyapps/:id/dashboard` answers `404`), the source-attributed snapshot, which only the
richer receipt event carries, and the saved `values` on the action command.

## Files changed

```
 CHANGELOG.md                                                     |  18 +
 contract/ext-bots-v1.md                                          |   2 +
 contract/ext-cozyapps-v1.md                                      |  79 +
 packages/conformance/test/cozyapps-dashboard-fixture.test.ts     | 111 +
 packages/conformance/test/fixtures/cozyapps-dashboard-v1.json    | 129 +
 packages/contract/src/cozyapps.ts                                | 206 +-
 packages/contract/test/cozyapps-dashboard.test.ts                | 123 +
 packages/gateway/src/adapters/attach/ingress-v1.ts               |  25 +-
 packages/gateway/src/adapters/attach/protocol-v1.ts              |  37 +-
 packages/gateway/src/http.ts                                     |  46 +-
 packages/gateway/src/server.ts                                   |  53 +-
 packages/gateway/src/storage.ts                                  | 146 +-
 packages/gateway/test/cozyapps-dashboard-attach-v1-e2e.test.ts   | 157 +
 packages/gateway/test/cozyapps-dashboard-records.test.ts         | 182 +
 packages/gateway/test/cozyapps-dashboard-routes.test.ts          | 132 +
 packages/gateway/test/server.test.ts                             |   2 +-
 16 files changed, 1432 insertions(+), 16 deletions(-)
```

`packages/gateway/test/server.test.ts` changes one line: the advertised
`"com.cozylabs.cozyapps"` moves from 1 to 2.

## Self-review findings

- **No fifth internal action state.** The brief's ruling says `running` is new in the status set.
  `cozy_app_actions.status` is a STRICT table with a `CHECK` constraint, and SQLite cannot ALTER a
  CHECK: adding a literal means rebuilding the table, and this repo has no table-rebuild migration
  precedent, only additive column ALTERs. `delivered` already means exactly "handed to the peer"
  and already maps to the public `running`, so a fifth value would present the same public name
  through more migration risk. A peer's explicit `running` receipt therefore stamps `delivered`.
  The ceiling: the gateway cannot distinguish "handed to the peer" from "the peer started work".
  The upgrade path is an additive nullable `started_at` column when a product needs that
  distinction, which needs no rebuild. Marked in code and named here rather than done silently.
- **`valueRevisions` is the client's assertion.** The gateway records which value revisions the
  person's tap was made against; it does not verify them against the current values. It is a
  binding a peer and a client can read, not a precondition the gateway enforces. Enforcement would
  be a product decision about whether a stale tap fails or proceeds, and the plan does not make one.
- **Values ride the command decided at enqueue time.** `sendCozyAppAction` includes `values` only
  when the CURRENT connection negotiated `cozyapps_dashboard`, and `commandCapabilities` refuses to
  enqueue a valued command for a peer that lacks it. The durable outbox row is shaped once, so a v2
  peer replaced by a v1 peer before that command is flushed would receive a member its schema does
  not know. Narrow and today impossible on Kyle's fleet, where no peer negotiates the new literal
  at all. The upgrade path is shaping the command at flush time against the live connection.
- **No bot read route for values.** A bot reads values through the action command and through
  nothing else. A standalone read lane would be a surface nothing in this packet uses.
- **`owner` is a constant.** The gateway serves one person and holds no user identity, so the
  envelope's `owner` is the constant `"user"` written by the gateway, never accepted from a bot or
  a request. The field exists because the product decision names one.
- **A value write broadcasts `cozyapps_snapshot`.** That frame does not carry values, so the
  broadcast is a change signal rather than the changed data. It is what the existing cozyapps
  routes do and costs one frame; a values frame would be a new wire shape this packet does not need.
- **Two appId conventions on the lane, unchanged.** `cozyapp_dashboard_upsert` namespaces its
  `appId` by creator, exactly as `cozyapp_upsert` does, so a plugin writes only its own record.
  `cozyapp_action_receipt` takes the id the `cozyapp_action` command carried, exactly as
  `cozyapp_action_status` does. That split is pre-existing v1 behavior and this packet matches it
  rather than inventing a third rule.
- **Purge is by foreign key.** `cozy_app_values` and `cozy_app_dashboards` cascade from
  `cozy_apps`, and `PRAGMA foreign_keys` is ON, so `deleteCozyApp` and `purgeBot` take them with
  the app without a new entry in the purge list. Proven by the storage test rather than assumed.

## Concerns for the lead

1. **`BOTS_CAPABILITY_VERSION` stays 66.** Row 68 is documented as a cross-reference only. If the
   lead wants the bots capability advanced to 68, 7a's row 67 has to land first, or the row has to
   be renumbered. Decide before this branch merges alongside 7a.
2. **The client is not updated.** `CozyAppsContract.swift` still decodes only v1, which is correct
   and intended: every v1 payload it sees is byte identical. Packet CA2 and the CozyChat side own
   the decoders for the new records.
3. **`.121` UNKNOWN.** No live model qualification. Reproducible commands for later are the four
   focused suites above, which need no endpoint.
