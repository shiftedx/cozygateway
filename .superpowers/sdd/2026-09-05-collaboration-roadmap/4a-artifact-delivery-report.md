# 4a durable Artifact records and independent delivery

Status: IMPLEMENTED, LOCAL GATES PASS, NOT REVIEWED, NOT MERGED, NOT DEPLOYED.

## Exact heads

- Worktree: `/Users/kmcdowell/Documents/repos/worktrees/4a-artifact-delivery`, branch `codex/4a-artifact-delivery`, pushed to origin.
- Base: `398f927` (cozygateway origin/main, capability 64 durable Tasks).
- Commits on the branch:
  - `a9c7d9a` Add durable Artifact records and independent delivery (capability 65)
  - `2e617ff` Contract row 65, portable conformance and a closed-store presence fix
  - `b868482` Record the no-regression delivery rule, the location assertion and the changelog
- Node 24 selected explicitly for every command: `PATH=/opt/homebrew/opt/node@24/bin:$PATH` (v24.19.0). `pnpm install --frozen-lockfile --offline` succeeded.
- Scratch data and logs: `/private/tmp/claude-501/-Users-kmcdowell-Documents-repos/bf5c8bcc-70ce-49f1-b800-1c3b933baa40/scratchpad/4a/`. No production gateway, no live Hermes profile, and no live bot was touched.

## Contract row text (capability 65)

Added to `contract/ext-bots-v1.md`. The status header still read "capability version 63" while the
table already carried 64; it now reads 65, and the discovery example was corrected the same way.

> | 65 | Durable gateway Artifacts: byte-verified commitment over the bytes the existing attach media route stored, retained originals, explicit deletion with a tombstone, supersession and versions, and a delivery lifecycle with its own identity and retries. See the Artifact surface below. |

A new "Artifact surface (capability 65)" section documents the record fields, the producer routes
(`POST /attach/v1/artifacts`, `GET /attach/v1/artifacts/:artifactId`,
`POST /attach/v1/artifacts/:artifactId/commit`, `POST /attach/v1/artifacts/:artifactId/deliveries`,
`POST /attach/v1/artifacts/:artifactId/deliveries/:deliveryId`), the paired-device routes
(`GET /bots/:name/artifacts`, `GET /bots/groups/:name/artifacts`, `GET /artifacts/:artifactId`,
`GET /artifacts/:artifactId/latest`, `GET /artifacts/:artifactId/content`,
`DELETE /artifacts/:artifactId`), the queued/delivered/acknowledged meanings, the retention and
tombstone rules, and the explicit statement that capability 65 is the canonical Artifact commitment
producer capability 64 declared and left absent.

## What was built

- `packages/contract/src/artifacts.ts`: closed `ARTIFACT_STATES` (declared, committed, commit_failed, deleted), `ARTIFACT_MARKS` (draft, review_copy, final), `ARTIFACT_VALIDATIONS` (unvalidated, verified, mismatch), `ARTIFACT_DELIVERY_STATES` (queued, delivered, acknowledged, failed), `ARTIFACT_FAILURE_REASONS` (checksum, size, capacity, missing_bytes), plus `ArtifactSchema`, `ArtifactDeliverySchema`, `ArtifactListSchema` and the three request bodies. `BOTS_CAPABILITY_VERSION` is 65.
- `packages/gateway/src/artifacts.ts`: the durable record and delivery store. No second upload authority: bytes reach the gateway through the existing `POST /attach/v1/media/:mediaId` route, and `commit` recomputes SHA-256 and the byte count over the STORED bytes. A refusal is recorded on the record (`commit_failed` plus `failureReason`), never discarded.
- `packages/gateway/src/artifact-routes.ts`: the two authenticated surfaces. Producer routes are scoped to the authenticated attach identity, so a foreign or guessed id is the same 404 an absent one gets. The device download serves the retained original with `nosniff` and `Content-Disposition: attachment`, and reaching it under a paired credential is the acknowledgement.
- `packages/gateway/src/storage.ts`: `storage.artifacts`, `storage.deleteArtifact`, and three retention guards so a committed original survives media expiry pruning, `deleteUnreferencedAttachMedia`, and native session deletion. `purgeBot` takes a deleted owner's Artifact records and deliveries with it, because deleting the owner IS an explicit deletion.
- `packages/gateway/src/tasks.ts`: `artifactsSettled(taskId, runId, at)`, a public entry that re-runs the EXISTING settlement. The Task stays derived from its own append-only stream; an Artifact never writes a Task state.
- `packages/gateway/src/config.ts` and `server.ts`: optional operator `artifactStoreBytes` ceiling, applied at startup.

### The Task seam, connected explicitly

`Storage`'s constructor now binds capability 64's absent-default reader:

```
this.tasks.artifactReferences((source) => this.artifacts.taskReferences(source));
this.artifacts.onCommitment((taskId, runId, at) => { this.tasks.artifactsSettled(taskId, runId, at); });
```

`taskReferences` selects only rows whose `task_id`, `bot`, `created_by`, `session_id` and `run_id`
all equal the source the Task supplies, and maps a real record state to `pending` / `committed` /
`failed`. Nothing is inferred from attachments, `fileId` or delivery. What the Task seam now reads
is therefore exactly the set of explicit declarations bound to that Task, Bot, authenticated peer,
session and Run, with their actual commitment status; a declared reference that has not committed
keeps the Task in `verifying`, and a `commit_failed` one drives the existing
`artifact_commit_failed` transition to `blocked`.

## RED then GREEN

RED, contract (`/private/.../scratchpad/4a/logs/red-contract.log`):

```
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter cozygateway-contract exec vitest run test/artifacts.test.ts
Test Files  1 failed (1)      Tests  3 failed (3)
```

RED, gateway (`/private/.../scratchpad/4a/logs/red-gateway.log`), after building the contract
package so the workspace entry resolved:

```
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter cozygateway exec vitest run test/artifacts.test.ts test/artifact-routes.test.ts
Test Files  2 failed (2)      Tests  18 failed (18)
```

GREEN, same two gateway files: `Test Files 2 passed (2)   Tests 18 passed (18)`.

GREEN, contract package: `Test Files 19 passed (19)   Tests 186 passed (186)`, exit 0.

GREEN, gateway package (whole suite, the package the change is concentrated in):

```
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter cozygateway exec vitest run
Test Files  129 passed | 1 skipped (130)      Tests  1445 passed | 2 skipped (1447)      exit 0
```

The 2 skips are the pre-existing `mobile-node-hermes-e2e` cases that need `HERMES_AGENT_ROOT`.
1445 is 1427 (the 2b baseline) plus the 18 new tests.

GREEN, conformance: `Test Files 8 passed (8)   Tests 84 passed | 19 skipped (103)`, exit 0. That is
81 passed / 19 skipped before this packet plus the 3 new fixture tests; the new portable Artifact
group runs and passes on the configured reference gateway and is one more skip on the hookless
runner.

GREEN, typecheck: `PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm -r typecheck`, exit 0, all four
packages Done. Builds run where a test needed them: contract, relay and gateway
`tsc -p tsconfig.build.json`, all clean.

Per the lead's ruling for this run, the full `pnpm -r test` was NOT run; the relay package is
untouched and was not exercised beyond its typecheck.

## Evidence per completion-criterion item

| Criterion | Where it is proved |
| --- | --- |
| checksum / size mismatch | `artifacts.test.ts` "commits only against stored original bytes": a wrong digest records `commit_failed` / `mismatch` / `checksum`, a wrong declared size records `size`, and only the matching declaration commits `verified`. |
| invalid state transitions | `artifacts.test.ts` "refuses every invalid delivery transition": retry while an attempt is live, failing an already delivered attempt, failing an acknowledged one, a foreign peer, a guessed delivery id. Commit refuses a deleted record and a second `mediaId` for a committed one. |
| process restart at commitment and delivery boundaries | `artifacts.test.ts` "survives process restart": a real on-disk SQLite file is closed and reopened between declare, commit and settle; the reopened store reads the same record and answers a replayed commit with the ORIGINAL `committedAt`. |
| duplicate receipts and retries | `artifacts.test.ts` "keeps delivery a separate retryable object": a duplicate failure report keeps the first `failedAt` and reason; a second download leaves `acknowledgedAt` unchanged. A producer `delivered` report arriving after the client already downloaded is a replay, not a conflict, because states never regress. |
| receipt before commit | `artifacts.test.ts` (settle before commit is `not_committed`) and `artifact-routes.test.ts` "retries delivery ... and refuses a receipt before commitment" (`409`). |
| delivery failure with a completed Task | `artifacts.test.ts` "blocks the Task on a failed commitment but leaves a completed Task completed when delivery fails": after a real attach `commit` event and a real Artifact commitment the Task is `completed`; a delivery failure and a retry add no Task event and no attach command. |
| originals retained across cleanup | `artifacts.test.ts` "retains originals across cleanup and expiry": the media row carries a staging `expiresAt`, is referenced by a transcript attachment in a session that is then deleted, and survives `pruneExpiredAttachMedia`, `deleteUnreferencedAttachMedia` (answers `referenced`) and `deleteNativeBotSession`. Commit clears the staging deadline for exactly this reason. |
| explicit deletion | Same test plus `artifact-routes.test.ts` "tombstones an explicitly deleted Artifact": `DELETE` answers 204, the record keeps bot, Task, Run, digest and version with `state: deleted`, `location` is absent, `content` answers 410, and a second delete is 404. |
| supersession and version lookup | `artifacts.test.ts` "supersedes a version without rewriting the record it replaces" (supersession lands on commitment, not on the declaration) and `artifact-routes.test.ts` "answers supersession and version lookup", including `GET /artifacts/:id/latest`. |
| inaccessible foreign-profile / room artifacts, guessed identifiers | `artifacts.test.ts` "refuses foreign and guessed identities on every producer path" and `artifact-routes.test.ts` "refuses a foreign peer and a guessed identifier without telling them apart": a foreign attach bearer gets 404 for commit and read, a guessed id gets 404 on every surface, an unknown room is 404, and another bot's list is empty. |
| stable discovery without the original message | `artifacts.test.ts` "lists only the asked-for bot and room, and finds an artifact without its message": lists by bot, room and Task with no transcript row involved. `artifact-routes.test.ts` reads and downloads the record with no chat message at all. |
| capacity failures visible | `artifacts.test.ts` "refuses commitment when the declared bytes were never stored and when the store is full": `capacity` is recorded on the record and the original bytes are still stored. |
| portable public-route conformance, older peers keep attachment behavior | `packages/conformance/src/suite.ts` "durable Artifacts capability 65": health advertises >= 65, every Artifact route is 401 unauthenticated, a guessed id is 404 (absent, not forbidden) on read, download and delete, and `GET /bots/:name/chat/attachments/:fileId` still answers its own `ErrorBody` 404 rather than anything Artifact shaped. Plus the `artifact-delivery-v1.json` decoder fixture. |
| no placeholder generating Task, no client-only lifecycle | The Task seam tests drive real `enqueueAttachCommand` admission and a real attach `commit` event through the existing durable ingress; the route tests upload through the real `POST /attach/v1/media/:mediaId` route with a real bearer and a real paired device token. |

## Files changed

`CHANGELOG.md`, `contract/ext-bots-v1.md`, `packages/conformance/src/suite.ts`,
`packages/conformance/test/artifact-delivery-fixture.test.ts`,
`packages/conformance/test/fixtures/artifact-delivery-v1.json`,
`packages/conformance/test/reference-gateway.test.ts`, `packages/contract/src/artifacts.ts`,
`packages/contract/src/ext-bots.ts`, `packages/contract/src/index.ts`,
`packages/contract/test/artifacts.test.ts`, `packages/contract/test/ext-bots.test.ts`,
`packages/gateway/src/artifact-routes.ts`, `packages/gateway/src/artifacts.ts`,
`packages/gateway/src/config.ts`, `packages/gateway/src/http.ts`,
`packages/gateway/src/server.ts`, `packages/gateway/src/storage.ts`,
`packages/gateway/src/tasks.ts`, `packages/gateway/test/artifact-routes.test.ts`,
`packages/gateway/test/artifacts.test.ts`, `packages/gateway/test/bots-delete-routes.test.ts`.
21 files, 1284 insertions, 7 deletions.

## Self-review findings

- The new tests surfaced a REAL pre-existing crash, not a test artifact: a peer socket closing after
  the durable store was torn down threw an uncaught `ERR_INVALID_STATE` ("database is not open")
  out of `Tasks.presence`, which the existing test "closes safely after storage teardown while a
  trace sink is installed" claims is safe. Verified against a throwaway worktree at the base
  `398f927`: the whole file exited 0 there but that single test run alone failed identically on
  BOTH trees, so the hole predates this packet and my change only changed the timing that exposed
  it. Fixed at the seam by returning early from presence projection when the store is closed;
  the isolated run and four consecutive whole-file runs now pass.
- Two stale capability assertions (`packages/contract/test/ext-bots.test.ts`,
  `packages/gateway/test/bots-delete-routes.test.ts`) pinned 64 and were moved to 65 with a comment.
  Neither touches production source.
- First design pass had the download acknowledge only from `delivered`, which made a
  gateway-served download unreportable. Corrected: a download served by this gateway IS the
  platform commitment for that attempt, so it records both facts at once, while a `queued` delivery
  still READS as queued and is never reported as received.
- Ponytail cuts, and when to revisit them:
  1. The device-facing `GET /artifacts/:artifactId` answers for any artifact this account holds,
     exactly as `GET /tasks/:taskId` already does. Per-room or per-bot device scoping would be a
     new authorization model for both surfaces at once, so it belongs to whichever packet
     introduces that model.
  2. `artifactStoreBytes` is a single global ceiling, not a per-bot or per-room quota. Add the
     narrower quota when an operator actually needs to bound one bot.
  3. There is no `bot_artifact_updated` replacement frame. Clients read the REST record, which is
     what the completion criterion asks for. Add the frame when a client needs live updates rather
     than shipping an unused one.

## Concerns

- No live model qualification. The `.121` endpoint and hosted CI billing remain unavailable, so
  live rollover and performance qualification for capability 65 are UNKNOWN. All evidence here is
  deterministic local integration. Reproduce later with
  `PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm -r build && pnpm -r typecheck && pnpm -r test`
  against a scratch gateway pointed at `http://192.168.99.121:1234/v1`.
- Capability 65 is advertised the moment this branch merges, through the single
  `BOTS_CAPABILITY_VERSION` constant, exactly as 64 was. There is no flag: the routes are additive
  and a client below 65 never calls them, but the lead should confirm that is the intended rollout.
- No CozyAgents-side producer exists yet. Until a runtime peer declares and commits Artifacts, the
  Task seam reads an empty reference set for every Run, which is byte identical to the pre-65
  behavior. That is the intended shape, but it means capability 65's Task join has no production
  traffic to observe yet.
- `pnpm -r test` was not run for this packet per the lead's ruling; the relay package has only its
  typecheck as evidence here.

## Fix round 1 (review r0)

Head after this round: `32b3c2c` "Fix round 1: disposition sanitizer, room membership, closed-store
guard", on `codex/4a-artifact-delivery`, pushed. Node 24 (`PATH=/opt/homebrew/opt/node@24/bin:$PATH`)
for every command. M1, M3, M4, M5 and M6 were deferred by the lead and are untouched.

### I1, filename in `Content-Disposition`

`packages/gateway/src/artifact-routes.ts` now builds the header with `attachmentDisposition()` from
`hermes-bridge/documents.ts`, the same helper the four other download routes use. It strips control
characters, reduces to an ASCII `filename`, and emits the RFC 5987 `filename*`, so a name that
cannot be represented degrades rather than making the artifact permanently undownloadable.

### I2, producer-supplied `room`

`POST /attach/v1/artifacts` refuses a `room` whose membership does not contain the authenticated
bot. `bot` and `createdBy` were already derived server-side; `room` was the one identity a peer
supplied. An unknown room and a room the bot does not belong to are the same `403`, so neither can
be probed. Membership is read from the existing `storage.botGroup(key).members`, no new authority.

### I3, closed-store crash, at the root

The guard now lives in one place, `Tasks.#closed()`, and every ingress-facing entry point the
attach ingress reaches after teardown funnels through it: `hello`, `presence`, `reconcile`,
`dispatch` and `declareSlashCommands`. That is all five seams the review named, including the
`reconcile` and command flush that the still-armed heartbeat tick performs. The `presence` guard
now runs BEFORE the in-memory `#live` set is touched, so the in-memory view cannot advance past a
skipped durable projection. Admission paths are deliberately not guarded: they run inside a
transaction on an open store or not at all.

### M2, truthful `validation`

`validation` now says what the bytes proved rather than why the commit failed: `mismatch` only for
a digest or size mismatch, `unvalidated` when the bytes were never there to compare
(`missing_bytes`), and `verified` for a `capacity` refusal, where the bytes did match and the store
refused to retain them. `failureReason` still carries why. The closed contract set is unchanged, so
this needed no additive row edit; the contract row prose records the mapping.

### M7, producer routes registered unconditionally

`http.ts` registers both halves unconditionally, because `/health` advertises 65 unconditionally. A
gateway with no attach peer configured now answers a producer request with the `401` its own
middleware returns, never a `404` that says the surface does not exist.

### Red then green

RED, three route findings (`scratchpad/4a/logs/r1-red-routes.log`):

```
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter cozygateway exec vitest run test/artifact-routes.test.ts
Tests  3 failed | 7 passed (10)
  expected 500 to be 200   (I1: the download threw on a CR/LF filename)
  expected 201 to be 403   (I2: a non-member room was accepted)
  expected 404 to be 401   (M7: the producer routes were absent)
```

RED, the closed-store regression (`scratchpad/4a/logs/r1-red-tasks.log`):

```
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm --filter cozygateway exec vitest run test/tasks-closed-store.test.ts
Tests  2 failed (2)
  expected [Function] to not throw an error but 'Error: database is not open' was thrown   (x2)
```

GREEN, covering test files:

| Command | Result |
| --- | --- |
| `pnpm --filter cozygateway exec vitest run test/artifact-routes.test.ts test/artifacts.test.ts test/tasks-closed-store.test.ts` | 3 files, 23 passed, exit 0 |
| `pnpm --filter cozygateway exec vitest run` over the 18 files touching Tasks, attach ingress, rooms, storage and the new routes (`test/artifacts`, `test/artifact-routes`, `test/tasks-closed-store`, `test/durable-tasks`, `test/task-routes`, `test/task-public-ingress`, `test/task-terminal-immutability`, `test/attach-v1-ingress`, `test/attach-v1-media`, `test/attach-v1-storage`, `test/native-bot-data-plane`, `test/bots-rooms-interactions`, `test/bots-group-protocol`, `test/native-group-turn`, `test/server`, `test/documents`, `test/bots-attachments-routes`, `test/storage`) | 18 files passed, 302 passed, exit 0 |
| `pnpm --filter cozygateway-contract exec vitest run test/artifacts.test.ts test/ext-bots.test.ts` | 2 files, 87 passed, exit 0 |
| `pnpm --filter cozygateway-conformance exec vitest run` | 8 files, 84 passed / 19 skipped, exit 0 |
| `pnpm -r typecheck` | exit 0, all four packages Done |

New covering tests: `packages/gateway/test/artifact-routes.test.ts` gains "serves a filename
carrying header control characters through the shared sanitizer" (I1), "refuses a room the
producing bot is not a member of" (I2, both the refusal and a member room accepted and listed), and
"registers the producer half on a gateway that has no attach peer configured" (M7).
`packages/gateway/test/tasks-closed-store.test.ts` is new and covers I3: all five entry points on a
closed store, and the still-armed heartbeat tick advanced under fake timers so a throw lands in the
test body rather than as an uncaught exception. `packages/gateway/test/artifacts.test.ts` pins the
M2 statuses. Full `pnpm -r test` not run, per the standing ruling.
