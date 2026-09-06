# 4e: join a declared Artifact to its Task by Run identity, and let an unstated mark stay unstated

Status: IMPLEMENTED, LOCAL GATES PASS, NOT REVIEWED, NOT MERGED, NOT DEPLOYED.

## Exact heads

- Worktree: `<repos>/worktrees/4e-artifact-task-join`, branch `codex/4e-artifact-task-join`, pushed
  to origin after every commit.
- Base: `aa76bc5` (cozygateway origin/main, "Derive Artifact records from legacy attachment
  deliveries (capability 65, additive) (#373)"), carrying rows 65, 66 and 67.
- Commits on the branch:
  - `eb471de` Red: join a declared Artifact to its Task by Run identity, and an unstated mark
  - `5f7d08d` Join a declared Artifact to its Task by Run identity, and keep an unstated mark
    unstated (capability 65)
  - `561eac6` Cover the joined and unresolved Task provenance shapes in the portable fixture
- Node 24 for every command: `PATH=/opt/homebrew/opt/node@24/bin:$PATH` (v24.19.0).
  `pnpm install --frozen-lockfile --offline` succeeded. Contract, relay and gateway
  `tsc -p tsconfig.build.json` were built because vitest resolves the workspace entries through
  `dist`.
- Scratch logs: `<scratch>/4e/logs/`. No production gateway, no live Hermes profile, no live bot.
  The 7a worktree and every other worktree were left untouched; the only files I wrote are in this
  worktree. `.121` UNKNOWN, not attempted.
- The worktree did not exist when I started, so I created it myself from `aa76bc5`
  (`git worktree add -b codex/4e-artifact-task-join ... aa76bc5`) at the path and branch the
  dispatch named. The lead's later correction and this tree agree on both.

## What was built

Two gateway-owned, additive seams that the 4b harness producer named and stopped at.

### 1. The Task join, resolved from the Run

`packages/gateway/src/tasks.ts` gains `taskOfRun(peer, runId)`, eleven lines over the existing
`run()` lookup plus the `tasks` row: the Task that Run belongs to, its Bot, and the Run's own
session. No new table, no new frame, no new authority.

`packages/gateway/src/artifacts.ts` binds it as `taskJoin(...)` and decides every record's Task in
one private place:

```
#join(input: { createdBy; bot; sessionId; runId? }): string | null {
  if (input.runId === undefined) return null;
  const run = this.#taskOfRun?.(input.createdBy, input.runId);
  if (run === undefined || run.bot !== input.bot || run.sessionId !== input.sessionId) return null;
  return run.taskId;
}
```

Three facts must all hold or there is no join: the Run is one the AUTHENTICATED peer owns
(`task_runs` is keyed on `(peer, run_id)`), the Task it belongs to is a Task of the same Bot the
record is filed under, and the declared session is that Run's own. The Bot check is the wrong-bot
guard: one attach peer can serve several bots, because `Tasks.admit` reads the Bot off the session
or the group turn rather than off the peer, so a Run whose Task is luna's cannot join a record
filed under sage.

`declare` writes `this.#join(input)` into `task_id`, and `commit` re-decides it ONLY while it is
still absent, which is the "declared before the turn was admitted" case. A join already recorded is
never re-decided, so a commit replayed after a process restart answers with the same Task and the
same `committedAt`. `#sameDeclaration` no longer compares a producer-stated `taskId` (there is none
now); the join is a function of the peer, Bot, session and Run it already compares, so a replay is
still a replay.

`#notify` then fires on the joined row, so `Tasks.artifactsSettled` re-runs the settlement that
already existed and the 4a reference reader, which selects on `task_id`, `bot`, `created_by`,
`session_id` and `run_id` together, now matches. The record is in the Task view's `artifacts`, it
keeps the Task `verifying` until it commits, and a `commit_failed` one drives the existing
`artifact_commit_failed` transition. An Artifact still never writes a Task state itself.

`packages/gateway/src/artifact-routes.ts` drops a producer-supplied `taskId` (`const { taskId:
_claimed, ...stated } = declaration`) instead of storing it: a Task id a peer sends is a claim this
gateway did not resolve. `packages/gateway/src/storage.ts` binds the resolver in the same
constructor that already binds the reference reader and the commitment notifier, three lines.

### 2. An unstated mark

`mark` is optional on `ArtifactDeclareRequestSchema` and stays optional on `ArtifactSchema`, where
4d already made it so for derived records. The gateway stores `input.mark ?? ""` in the existing
NOT NULL column and `#record` already omits an empty mark, so absence reaches a client as an absent
field. Nothing defaults to `draft`. Row 65's three values are the three things a producer can say;
"did not say" is absence.

## Contract text

`contract/ext-bots-v1.md`, row 65, gained ", and the gateway's own join from the Run a producer
named to the Task that owns it". The Artifact surface gained the optional-mark paragraph and a new
"The Task join, resolved from the Run" section, which states: a producer cannot name a Task because
the id is minted gateway-side and no attach-v1 frame carries it, capability 64 already made the
existing attach turn identity the Run identity, so a declaration names its session and Run and the
gateway resolves the owning Task itself; the three conditions, including that a wrong-bot Run
cannot join another bot's Task and one peer's Run cannot reach another peer's Task; that a Run the
gateway cannot map records ABSENT Task provenance and never guesses, with `runId` kept exactly as
stated so a reader can tell an unresolved Run (`runId` present, `taskId` absent) from a declaration
that named no Run (both absent); that the join is decided at declaration and again at commitment
only while absent, so a replayed commit after a restart is idempotent; that a joined record is in
the Task's artifact reference set; and that `taskId` on `POST /attach/v1/artifacts` is accepted for
the first row 65 clients and IGNORED. The derived-records section's `sha256` / `mark` sentence and
the additive paragraph were updated: a `declared` record omits `mark` when its producer left it
unstated, and a peer at 65 that still sends `mark` and `taskId` is decoded unchanged, its mark
stored as it always was and its `taskId` dropped in favor of the gateway's own join.

`BOTS_CAPABILITY_VERSION` is UNCHANGED at 67. This is additive to row 65, not a new row.

## RED then GREEN

RED, all three seams before any source change (`<scratch>/4e/logs/red-*.log`), commit `eb471de`:

```
pnpm --filter cozygateway exec vitest run test/artifact-task-join.test.ts
  Test Files  1 failed (1)     Tests  4 failed | 2 passed (6)
pnpm --filter cozygateway-contract exec vitest run test/artifacts.test.ts
  Test Files  1 failed (1)     Tests  1 failed | 4 passed (5)
pnpm --filter cozygateway-conformance exec vitest run test/artifact-delivery-fixture.test.ts
  Test Files  1 failed (1)     Tests  1 failed | 4 passed (5)
```

The four red gateway cases are the join, the join at commit time, restart idempotency, and the
unstated mark (which failed as `TypeError: Provided value cannot be bound to SQLite parameter 12`,
the required-mark column refusing absence). The two that passed at RED are the two GUARD cases
(absent provenance, wrong bot): with no join at all they passed vacuously, and they are meaningful
only against the implementation, where they now hold while the four positive cases also hold.

GREEN, after the implementation (`<scratch>/4e/logs/green-*.log`, `typecheck.log`):

| Command | Result |
| --- | --- |
| `pnpm -r typecheck` | exit 0, four packages Done |
| `pnpm --filter cozygateway exec vitest run test/artifact-task-join.test.ts test/artifacts.test.ts test/artifact-routes.test.ts test/derived-artifacts.test.ts` | Test Files 4 passed, Tests 37 passed |
| `pnpm --filter cozygateway exec vitest run` | Test Files 137 passed \| 1 skipped (138), Tests 1519 passed \| 2 skipped (1521) |
| `pnpm --filter cozygateway-contract exec vitest run` | Test Files 20 passed, Tests 205 passed |
| `pnpm --filter cozygateway-conformance exec vitest run` | Test Files 10 passed, Tests 102 passed \| 19 skipped (121) |

The 2 gateway skips are the pre-existing `mobile-node-hermes-e2e` cases that need
`HERMES_AGENT_ROOT`; the 19 conformance skips are the pre-existing hookless-runner cases. This
packet adds 6 gateway tests, 1 contract test and 2 conformance tests, so the base counts are 1513,
204 and 99; every pre-existing test file passes, with the six assertion edits listed under Files.
Per the lead's ruling for this run the full `pnpm -r test` was NOT run; the relay package has only
its typecheck and its build as evidence.

## Evidence per completion-criterion item

| Criterion | Where it is proved |
| --- | --- |
| A commit with Run and session but no `task_id` joins the right Task and appears in that Task's artifact references | `artifact-task-join.test.ts` "resolves the owning Task from the Run the producer named and shows it on the Task": a real admitted turn, a declaration carrying only `sessionId` and `runId`, `record.taskId` equal to the gateway's own Task id, `tasks.read(taskId).view.artifacts` equal to `[{ artifactId: "artifact-1" }]` while `verifying`, `list({ taskId })` finding it, and the Task completing on commitment. Also "joins at commit time when the Run only became mappable after the declaration", where the declaration precedes admission, claims no Task, and the commit records the join. |
| A Run with no Task records absent provenance visibly | "records absent Task provenance for a Run it cannot map, and never guesses one": an unmapped Run keeps `runId` exactly as stated with `taskId` absent, through the commit as well; a declaration naming no Run keeps both absent, which is the visible difference; neither reaches or blocks the real Task. |
| A wrong-bot Run cannot join another bot's Task | "refuses to join a Run whose Task belongs to another bot, or whose session differs": one peer serving two bots admits luna's Task and files sage's record against luna's Run, and no join is made at declare or at commit and luna's Task shows no artifact; a second peer naming the first peer's Run joins nothing; a second session of the same bot naming the other session's Run joins nothing. |
| Restart between commit and join is idempotent | "keeps the join idempotent across a restart between the commit and its replay": a real on-disk SQLite file, declared, committed and joined, closed, reopened, and the replayed commit answers `replayed` with the same `taskId` and the ORIGINAL `committedAt`, with exactly one reference on the Task and one record in `list({ taskId })`. |
| A declared commit with no mark stores and lists as unstated | "stores and reports a declared record with no mark as unstated, never as draft": declared, replayed, committed, listed and read back with `mark` undefined on every surface, and a later declaration that DOES state `draft` is a conflict rather than a replay, so absence and `draft` are not the same record. |
| Conformance covers both | `artifact-delivery-fixture.test.ts` "decodes a declared record whose producer left the mark unstated" over a new `unstated` fixture record (declared, verified, joined to its Task, no mark, and `mark: "unstated"` refused), plus the declare request decoding with and without `mark`; and "decodes the joined and the unresolved shapes of Task provenance": the joined shape, the unresolved shape (`runId` present, `taskId` absent), the runless shape, and a declaration that names a Run and no Task id. `packages/contract/test/artifacts.test.ts` "lets a declared record leave its mark unstated and never defaults one" pins the same at the schema. |
| Peers and clients below 65 byte identical | `BOTS_CAPABILITY_VERSION` unchanged; no frame, route or response field added or removed; the whole pre-existing gateway suite passes, including `derived-artifacts`, `attach-v1-*`, `turn-media-receipts` and the Task suites. A peer that still sends `mark` is stored exactly as before; one that still sends `taskId` is decoded unchanged and its claim is dropped. |
| Node 24 typecheck plus focused contract, gateway and conformance tests | The GREEN table above. |

## Files changed

`CHANGELOG.md`, `contract/ext-bots-v1.md`,
`packages/conformance/test/artifact-delivery-fixture.test.ts`,
`packages/conformance/test/fixtures/artifact-delivery-v1.json`,
`packages/contract/src/artifacts.ts`, `packages/contract/test/artifacts.test.ts`,
`packages/gateway/src/artifact-routes.ts`, `packages/gateway/src/artifacts.ts`,
`packages/gateway/src/storage.ts`, `packages/gateway/src/tasks.ts`,
`packages/gateway/test/artifact-routes.test.ts`,
`packages/gateway/test/artifact-task-join.test.ts` (new),
`packages/gateway/test/artifacts.test.ts`, `packages/gateway/test/derived-artifacts.test.ts`.
14 files, 392 insertions, 30 deletions. Source change is 44 lines in `artifacts.ts`, 11 in
`tasks.ts`, 5 in `artifact-routes.ts` and 3 in `storage.ts`.

Existing-test edits, all of them removing a producer-stated `taskId` that the gateway no longer
stores: four declarations and one tombstone assertion in `artifacts.test.ts` plus one list-by-Task
assertion moved to the new file (it needs a real Task to join to now), two declarations and one
upgrade assertion in `derived-artifacts.test.ts`, and one route tombstone assertion in
`artifact-routes.test.ts` which now asserts the claim was DROPPED. No production source was
weakened to make a test pass.

## Self-review findings

- The first design kept a producer-stated `taskId` when the Run did not resolve, so the record
  would have carried an unverified claim beside an absent join. That is exactly what "never
  guesses" forbids, so the claim is now dropped at the route and the column is gateway-established
  or absent. The cost is the test edits above and one behavior change for the only 65 producer that
  can send the field, which is 4b's hand-made qualification script; the harness itself cannot
  supply it and does not.
- The join is decided at declaration AND at commitment rather than only at commitment. The brief
  says commit time; declaring first is the ordinary case and resolving there means the record is
  truthful the moment it exists, and the commit-time pass covers the case where the Run became
  mappable later. Re-deciding an existing join was deliberately NOT done: that is what makes a
  replay after a restart answer with the same Task instead of a fresh decision on a moved world.
- The join UPDATE is deliberately outside the commit savepoint and before the byte checks, so a
  `commit_failed` record is bound to its Task too and the existing `artifact_commit_failed`
  transition reaches it. `artifacts.test.ts` "blocks the Task on a failed commitment" now proves
  that through the join rather than through a stated Task id.
- Considered and rejected: a new explicit field saying the join was attempted and did not resolve.
  The closed shape already carries that distinction, because `runId` is kept as stated: `runId`
  present with `taskId` absent is an unresolved Run and both absent is a declaration that named no
  Run. A new field would be a second way to say the same thing on a wire two other packets are
  reading right now.
- Ponytail cuts, and when to revisit them:
  1. `taskId` remains in `ArtifactDeclareRequestSchema`, documented as ignored, rather than being
     removed. Removing it would change nothing at runtime (the decoder tolerates unknown members)
     and would break the type for a client that still sets it. Drop it when no 65 producer sends it.
  2. There is no re-join for a record that was already committed with no Task and whose Run becomes
     mappable afterwards. That ordering does not occur on this wire: the Run is the turn, and the
     turn is admitted before a peer can execute it. Add a re-join only if a producer path appears
     that can commit before admission.
  3. The live conformance group still exercises only the device-facing half, because the harness
     holds no attach peer credential. The producer side, including the join and the unstated mark,
     is covered by the portable decoder fixture and by the authenticated gateway tests.

## Concerns

- Records written before this change keep whatever `task_id` a peer claimed. There is no
  migration: a stale claim still has to match `bot`, `created_by`, `session_id` and `run_id` before
  the Task reference reader will look at it, so it cannot reach a Task it does not belong to, but
  the field on such a row is a peer's word rather than the gateway's. Only records declared from
  here on carry the gateway's own join.
- The wrong-bot guard rests on `Tasks.admit` deriving the Bot from the session or the group turn.
  If a future admission path ever files a Task under a Bot the session does not name, this join
  inherits that decision. The test constructs the two-bot case through the real admission path so a
  change there fails here.
- `mark` becoming optional on a declaration is a relaxation of a row 65 input. A gateway at this
  commit accepts a declaration an older gateway would have refused; nothing a client sends today is
  refused that was accepted before, and no record shape a pre-4d client could already meet has
  changed, since `mark` has been optional on the RECORD since 4d.
- No live model qualification. `.121` and hosted CI remain unavailable, so live rollover and
  performance for this change are UNKNOWN. All evidence here is deterministic local integration.
  Reproduce later with
  `PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm -r build && pnpm -r typecheck && pnpm -r test`
  against a scratch gateway.
- Base counts (1513 / 204 / 99) are stated by arithmetic from the added tests rather than by a
  separate run of the base tree; every pre-existing test file passes on this branch.
- 4b's harness producer needs no change to benefit: it already declares `sessionId:
  command.threadId` and `runId: command.turnId`, which is exactly what this join consumes. Its
  `ponytail:` comment about filing an unstated mark as `draft` can now be removed, and its report's
  two named gaps are both closed by this branch. That follow-up is a CozyAgents change and is not
  in this worktree.
