# Gateway durability, performance, and complexity audit

Date: 2026-09-13, America/Chicago. Source baseline: `5785d30053a14acff685eda964bcb294ce548817` (gateway 0.8.4). Production reported 0.8.1. Changes are local on `codex/gateway-performance-audit`; production was inspected read-only.

## Decision

Keep the gateway in TypeScript for this repair. The strongest measured defect is an indexed-lookup problem: the live event path repeatedly scans already-applied journal history. Rewriting that algorithm in Rust would retain its growing workload. Fix the algorithm, bound live memory and queues, then measure production again before choosing a different runtime.

The gateway should own authentication, transport, durable admission/replay, normalized chat projection, and delivery. Harnesses should own execution, model context, provider configuration, and harness-specific operations. Both CozyAgents and Hermes remain supported. OpenClaw should enter through the existing attach command/event contract with a small harness adapter; it should not require another copy of chat delivery, history, or connection recovery.

More aggressive **journal compaction** is warranted. More aggressive **restarts** are not supported by the evidence. Forty tool calls should not require a process or model-context rollover.

## Incident evidence

The app used the public `warm.cozylabs.ai` route while on LAN, so its traffic still crossed the public edge/tunnel. The gateway runs in Docker on the Linux host; Hermes runs on the Mac. Local source and production versions differ, which limits how directly a local test describes the deployed behavior.

Two useful clusters in the production logs:

| Local time on September 13 | Observation |
| --- | --- |
| 19:52:27 CDT | Cleo finished a turn; the app closed abnormally with code 1006; six other attach peers closed with 1006 within roughly 1.2 seconds. Cleo's attach connection remained up. |
| 20:00:07–08 CDT | A second Cleo terminal event was followed by another app 1006 and six other attach 1006 closes. Hermes control probes also failed around this period, then recovered. |

The gateway container had no restart or OOM event. The tunnel container also remained running. Tunnel errors in the sampled logs did not align with these two clusters. At the later health check, all seven configured attach peers were online, with no pending commands or dead letters. This matches transient connectivity loss followed by recovery, rather than demonstrated lost chat data.

These simultaneous failures do **not** prove which side terminated each socket. Closer timestamp review found Cleo projection/event pairs every 117–170 ms, continuing until 15 ms before the first app close. That rules out a continuous multi-second gateway event-loop stall in this captured window. Shared tunnel or client-network failure remains plausible but unproven. There is no claim here that the specific 1006 incident has been reproduced locally or conclusively fixed.

Three recent Cleo turns contained 996 transport events: 907 drafts, 67 tool events, 19 thinking events, and three commits. The largest was about 7.8 KB. Tool-call count substantially understates the transport workload.

## Ranked findings

### P1 — Already-applied inbox history is scanned on live projection

`Storage.unappliedAttachEvents` selects pending events before the earliest dead-letter barrier. The original query used the primary key for both reads and walked retained history even when nothing was pending.

Production contained 147,907 inbox rows, including 127,757 for Cleo. Three read-only executions of the Cleo query returned zero rows in 120.24, 115.05, and 113.05 ms. These are synchronous database operations on the process serving sockets. [Node documents `DatabaseSync` as synchronous](https://nodejs.org/api/sqlite.html); lengthy callbacks delay other clients sharing its event loop. [Node event-loop guidance](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop)

**Implemented:** partial indexes for pending accepted events and accepted dead letters, with explicit query-plan selection. SQLite otherwise preferred the primary key on this `WITHOUT ROWID` table even when the new indexes existed. The predicates preserve projection order and the earliest dead-letter barrier, including a barrier whose row was subsequently marked applied.

On a temporary local WAL database seeded with 127,757 applied rows, one pending event, and a later dead letter, the median query fell from 19.97 ms to 0.03 ms; the actual storage method also measured 0.03 ms. This is about 600× for that query on that fixture, not a 600× improvement to the whole gateway. Production and local timings are separate measurements on different hardware/data.

The final local rerun, including retention indexes, measured 15.96 ms versus 0.03 ms for the same comparison. Forty tools / 80 events completed in 39.8–59.7 ms across the tested history/command variations. All runs preserved 40 tool steps, projected 80 events, and emitted two coalesced activity frames. [Machine-readable measurements](2026-09-13-gateway-performance-evidence.json)

Final query-plan review found the same planner problem in per-peer dead-letter counts and earliest-dead-letter release. Those now explicitly use the dead-letter index too: local fixture medians fell from 9.80 to 0.01 ms and 9.14 to 0.01 ms respectively. Global dead-letter counts and the dead-letter listing select the new index without a hint.

The follow-up pass also replaced health's lifetime event/terminal aggregates with indexed endpoints. At 127,757 inbox rows, latest-event lookup measured 3.11 ms before and 0.01 ms after. At 24,000 attach plus 24,000 native terminal receipts, the terminal aggregate measured 14.34 ms before and 0.01 ms after. Attach terminal timestamps are copied from their existing inbox receipt during migration; normal receipt writes now persist that timestamp directly.

The indexes are created when storage opens, including existing databases. The first upgraded startup therefore pays a one-time index build over existing data; steady-state measurements do not describe that startup cost.

### P1 — CozyAgents rewrites its entire accumulated JSON spool

`CozyAgents/src/gateway/attach-v1.ts` retains acknowledged events and processed commands in one JSON document. Every event admission and ACK rewrites that document. Bounds cover pending work, not accumulated history. Heartbeat handling shares the serialized operation queue with these writes.

The reproducible `CozyAgents/scripts/bench-attach-spool.mjs` uses the real client and spool with a synthetic ACKing transport. It queues 40 tool running/finished pairs, then a heartbeat:

| Acknowledged historical events | Total burst and ACK drain | Heartbeat response wait | Final spool size | Process RSS |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 54.8 ms | 25.4 ms | 0.11 MB | 89.8 MiB |
| 1,000 | 364.6 ms | 177.3 ms | 1.41 MB | 108.8 MiB |
| 10,000 | 3,099.9 ms | 1,649.4 ms | 13.20 MB | 320.3 MiB |

These are single-run characterization results, not benchmark medians. RSS includes the synthetic seed and accumulated runtime allocations; it is not an isolated spool allocation measurement. Maximum event-loop delay was much smaller than heartbeat wait, demonstrating that serialized queue wait matters in addition to synchronous stalls.

**Implemented in the sibling CozyAgents repository:** native SQLite with WAL/FULL transactions, indexed pending reads, exact encoded-frame byte limits, and migration of legacy JSON. Event IDs, command deduplication, and restart/cursor semantics remain durable. The client reads only the negotiated event window and closes the database after queued writes and active command/recovery handlers finish. SQLite is part of the supported runtime; no dependency was added. [Node 22.19 SQLite API](https://nodejs.org/download/release/v22.19.0/docs/api/sqlite.html)

Initial replacement runs measured roughly 30–60 ms for the same 10,000-history/40-tool case, versus 3,099.9 ms before. The final three-run alternating comparison measured a median 2,780.8 ms for JSON and 33.2 ms for SQLite (84× for this workload); heartbeat wait fell from 1,386.5 to 15.4 ms. Startup includes the one-time migration and is separate from burst timing: 32.7 ms for JSON versus 109.7 ms for SQLite migration. The new database occupied 14.26 MB versus 13.20 MB for JSON; this change reduces repeated work, not the initial file size. SQLite burst timing was too short to obtain consistent event-loop histogram samples, so no zero-lag claim is made. These are local characterizations; parallel test activity changes timings. This defect affects CozyAgents; it is **not** evidence that the Hermes Cleo incident came from this spool. Hermes already uses a SQLite spool and an unacknowledged-event index. At 128,000 retained Hermes events, its indexed pending read measured 0.111 ms median and health 0.007 ms; the same index existed in deployed 0.8.1.

Independent review found and fixed concurrent migration replacement and incomplete initial provisioning: both now publish a fully committed staged database while holding a native SQLite exclusive provisioning lock. Waiters retry asynchronously and re-check the target, so they cannot replace an already-live database with an older snapshot. The small lock file remains to preserve its inode; SQLite releases ownership on process death. A failed or incomplete source fails closed. The migrated filename remains unchanged and contains SQLite, so older JSON-only binaries cannot open it; rollback needs a pre-upgrade state snapshot.

### P2 — Completed tool turns remain in live memory

`NativeBotDataPlane` restored tool steps from up to 10,000 historical sessions on startup and retained terminal turns in `#toolFrames` indefinitely.

**Implemented:** restore only active turns and release a turn's live tool map after its final persisted/broadcast state. Historical tool rows remain on disk and are still returned through chat history. Existing active-turn restart behavior is preserved. A regression check first failed on the old behavior and passes with the change.

### P2 — App writes have no sender-queue bound

The attach side already negotiates 64 in-flight events / 4 MiB. The app write path previously called `ws.send` without examining buffered bytes, allowing a slow consumer to retain an ever-growing sender queue. Observer delivery had a separate bounded queue, so the write path was the gap.

**Implemented:** centralize app writes behind a 4 MiB backlog high-water mark, serialize each broadcast once, and close a stalled consumer with 1013 so it can resume through existing history/sync. Stop sync work once a send fails.

The current contract permits individual frames larger than 4 MiB, including a combined CozyApps snapshot and a large committed message. A strict total-frame cap would permanently reject those frames on every reconnect. The backlog rule therefore allows the next valid frame while existing backlog is below 4 MiB, then admits no further frames once the threshold is reached. Its bound is less than 4 MiB plus one valid frame, **not** a hard 4 MiB process-memory limit. A separate contract/app change is needed to bound individual message sizes and page large snapshots. The regression check covers this oversized-frame compatibility case.

### P2 — Liveness decisions lack enough causal evidence

App WebSocket heartbeats run every five seconds and terminate a socket on the next tick without a pong. Attach heartbeat cadence is 15 seconds with a 45-second silence timeout. App liveness only observes pongs; attach liveness refreshes on authenticated inbound traffic. Changing both to still shorter deadlines would increase sensitivity to delay.

**Implemented:** attach timeout traces now include observed silence, configured timeout, and heartbeat-tick delay, using the existing timer and monotonic clock. No extra watchdog loop, per-event metric persistence, or timeout-policy change was added.

**Follow-up:** use last ACK/projection progress and oldest pending age alongside transport liveness. A responsive idle peer with no pending work needs no reset. If the gateway itself was delayed, allow the event loop to service incoming traffic before deciding every peer is dead. Only a persistent failure to make progress should trigger targeted reconnect; repeated local readiness failure can justify a supervised process restart with backoff. Record the reason before acting.

### P2 — Retention and history reads still grow with lifetime activity

Before this patch, the gateway retained raw inbox frames, command history, and structured tool history without an automatic tool-history expiry. Production had 6,787 structured tool steps and a 740 MiB main database plus a 36 MiB WAL. Cleo's raw inbox JSON accounted for roughly 70 MB; the whole database size cannot be attributed to that journal alone.

The unused blanket `sweepBotChatToolSteps` method was removed; the new maintenance path checks durable terminal evidence. Chat history reads all stored tool rows for the selected session. In the local test, history reads grew from roughly 0.8 ms with no historical tools to roughly 4 ms with 2,000. This is a scaling liability, not evidence that four milliseconds caused the incident.

Live tool activity also resends cumulative step lists. The existing 100 ms coalescer reduces an immediate 40-tool burst to two activity frames / 41 step objects, but 80 updates spaced beyond the coalescing window can serialize 1,640 step objects. A future delta representation requires coordinated app/contract support; silently changing the existing wire shape is not a safe optimization.

## Retention and watchdog policy

The user selected this policy during the review:

| Data | Policy |
| --- | --- |
| Completed tool detail | Keep seven days, then clear verbose detail/error text while retaining name, outcome, ordering, and timing. |
| Completed tool summaries | Delete after 14 days. Active/running work and turns without durable terminal evidence remain protected. |
| Applied raw transport payloads | Remove expendable copied content after 14 days; preserve sequence/event identity and the minimal delivery/media/task evidence used by recovery. Unapplied, dead-lettered, and unresolved interaction payloads remain protected. |
| Gateway diagnostic observation history | Default seven days, maximum 14 even when an older configuration requested a longer window. |
| Docker stdout/stderr | Rotate three 10 MB files per container; a 1 MB nonblocking delivery buffer prevents logging pressure from blocking the application. |
| Chat messages, files, unresolved approvals | Preserved. They are user data, not disposable logs. |

Tool and raw-payload cleanup runs every 15 seconds in bounded indexed batches, with its timer stopped before storage closes. Old backlogs drain over multiple passes rather than one large startup deletion. Retention is asynchronous: cutoff-eligible records disappear as the bounded maintenance queue drains.

Each tool pass touches at most 256 rows. Each raw-payload pass selects at most 256 rows and rewrites at most 4 MiB of source UTF-8 JSON, except that one larger valid row is allowed so it cannot block progress forever. A single trusted field map defines both candidate selection and removal. The compactor covers draft, thinking, tool, commit, scheduled, failure, delegation display data, media descriptors, desktop-message text, and CozyApp payload copies. It keeps full interaction payloads, ignored/unapplied rows, and dead letters; these are not silently reclassified as disposable logs.

Retention also bounds source scanning. Tool deletion and detail compaction each inspect at most 256 ordered keys; together they mutate at most 256 rows. Raw maintenance inspects at most 256 keys before protected-state checks. Three durable cursors in one table let those passes resume beyond protected/orphan prefixes and cycle back to reconsider them later. On 127,757-row protected-prefix fixtures, first/resumed tool windows measured 0.71/0.65 ms and raw windows 1.48/1.45 ms. Removing data frees reusable SQLite pages; it does not guarantee an immediate smaller database file, and no blocking `VACUUM` was added.

Docker's native `local` driver supports size/count rotation, not a 14-day age deadline. The checked-in Compose change therefore guarantees a byte/count budget for stdout, **not** exact time-based deletion of quiet old container logs. External log collectors and host/Hermes log files need their own 14-day expiry; they are outside this gateway's storage control. Existing containers must be recreated through the release process for logging changes to apply. [Docker logging configuration](https://docs.docker.com/engine/logging/configure/), [local driver options](https://docs.docker.com/engine/logging/drivers/local/)

Use bounded work as the governing rule, not an arbitrary tool threshold:

1. Keep unacknowledged work durable and bounded by entries and bytes. Expose oldest age and last ACK progress.
2. Once an event is safely projected and outside a defined replay window, compact transient draft/thinking/tool payloads. Preserve sequence checkpoints and the minimal deduplication evidence needed by reconnects.
3. Preserve durable messages, terminal/delivery evidence, unresolved interactions, task relationships, and media ownership. These currently have readers that consult the inbox; compaction must migrate those dependencies or retain the required evidence atomically.
4. Perform small maintenance batches outside admission/projection callbacks. Do not run a large delete/VACUUM or reset a live sequence counter in response to a busy turn.
5. Release completed live state immediately; fetch paginated history on demand. A model-context rollover belongs to the harness and should not interrupt gateway connectivity.
6. Reuse existing supervision. Diagnose local readiness, tunnel reachability, attach progress, and app socket health separately before restarting their shared process.

Retained tiny replay identities and durable proof fields still grow with history; a future checkpoint/replay-window contract is needed before deleting those identities. This patch does not claim a hard byte ceiling for the whole SQLite database. It preserves durable chat and recovery semantics while removing expired tool content and expendable transport payloads.

Harness event copies now compact separately using their existing heartbeat cadence. CozyAgents keeps ACKed bodies for 14 days from their ACK timestamp, then retains minimal valid envelopes and stable IDs; legacy ACKs conservatively begin this clock at migration. Hermes compacts ACKed draft/tool/thinking/terminal copies after 14 days, but leaves media rollback descriptors, unresolved interactions, scheduled delivery and other specialized payloads intact. Its ACK proves durable gateway admission, not a separate projection guarantee. Both passes use indexed candidates, at most 256 rows and 4 MiB of actual source bytes (one oversized first row may make progress). Maintenance errors cannot close the transport. Processed command bodies remain outside this event-payload cleanup; retention is not a blanket deletion of every transport row.

## Architecture and complexity disposition

The dependency footprint is already small: gateway runtime dependencies are Hono, its Node server adapter, TypeBox, `ws`, and the workspace contract. There is no new dependency in this patch. Removing a web framework or schema validator would trade maintained functionality for custom code without addressing the measured scan.

Keep one durable transport/projection core with harness-owned operations behind it. The existing shared attach contract is the expansion point. Hermes-specific SDK/RPC compatibility belongs at the Hermes boundary; do not spread additional harness-name branches throughout routing and history. Both current harnesses must pass the same reconnect, ordering, duplicate-delivery, cancellation, tool lifecycle, and capability-negotiation checks.

A Rust experiment would earn its keep only after representative profiles show a remaining runtime-bound hot path after these fixes, and an equivalent prototype improves CPU, memory, or latency while preserving the same recovery contract. No Rust comparison was performed, so this review does not make language-level performance claims.

The independent Luna inventory found the following production source footprint before cleanup (generated code/assets and tests excluded):

| Subsystem | TypeScript modules | Lines |
| --- | ---: | ---: |
| Gateway core | 35 | 17,142 |
| Gateway adapters | 7 | 2,598 |
| Hermes bridge | 33 | 18,862 |
| Runner | 5 | 1,750 |
| Observe | 12 | 2,783 |
| Gateway total | 92 | 43,135 |
| Contract | 20 | 4,961 |
| Relay | 11 | 1,402 |

The attach plugin adds 14 production Python modules / 11,737 lines. Its declared runtime dependency, `websockets`, is in use. This is a broad product integration surface; module size alone does not prove that its behavior is disposable.

Ponytail dispositions, ranked by concrete production-source cut:

- `delete:` move the 179-line unused production markdown parity port into test support. **Applied**, including its Python vector-test reference; parity coverage remains intact.
- `delete:` remove the 74-line private Observe barrel and import concrete modules in its six test callers. **Applied**. No runtime caller or package export used the barrel.
- `shrink:` consolidate exact `asRecord`/`asString` duplicates in seven Hermes parsers into the existing `rpc.ts` helper module. **Applied by Luna:** 18 added / 54 removed lines, with parser checks and typechecking.
- `delete:` remove unused `rosterPollMs`, `routinesPollMs`, and `focusTtlMs` options and two unused imports. **Applied**.
- `shrink:` move the duplicated `errorBody` constructor into existing `errors.ts`; about 2–4 lines possible. Deferred as low-value churn during a durability repair.
- `delete:` three internal declaration-only attach type aliases are potential further cleanup. Their active schemas must remain.

The `/bots/focus` API currently stores focus state that has no downstream reader. It deserves removal of the ineffective behavior or a product decision, not a claim that the documented endpoint is unused. Legacy runner tokens, Hermes password auth, multi-endpoint federation, provider handoffs, and relay delivery all have live callers or supported deployments and were retained.

These cleanup slices remove 300 lines from production locations, including 179 moved to test support and the unused six-line tool sweep. This is not the net line count of the whole patch, which adds retention behavior, indexes, and regression checks. No dependency removal was justified. Terra handled storage, transport, and independent durability review; Luna handled the bounded parser consolidation; the primary agent retained architecture and integration decisions.

## Validation and limitations

Environment: Node 24.19.0, pnpm 10.30.1, frozen lockfile install, gateway Vitest 4.1.11 / CozyAgents Vitest 4.1.9. A clean gateway build and typecheck passed. The full four-package test run passed 2,417 tests, with 26 skipped; 209 files passed and one file was skipped. The full Hermes Python run passed 598 tests with three skipped (601 discovered). Focused retention, transport, and parity checks also passed. Node 22.22.3 also passed the focused SQLite/lifecycle checks.

CozyAgents' final full suite passed 3,629 tests, with 12 skipped (207 files passed, one skipped).
The first run exposed a CozyApp fixture that assumed the old slow spool would let an action's
file reads finish before a later chat command started. The fixture now explicitly starts the
action before sending that later command, then proves that the running action does not block it.
No runtime delay or command serialization was added to satisfy the old timing assumption.

The additional CozyAgents portable gates passed: PowerShell units (10 checks), bundle smoke,
and native POSIX lifecycle (restart, update/rollback, retained state, ownership refusal, uninstall).
Gateway `pnpm test:installer` and contract `lint:package` both exited 0. The installer gate includes
its portable PowerShell lock, rollback, attach diagnosis, Hermes installer, harness selection,
provisioning, plugin rollout, and hygiene fixtures. Gateway production dependency audit and
CozyAgents dependency audit also exited 0 at the configured moderate threshold.

There are no failures in the executed suites: 6,644 test cases passed, with 41 existing skips
across the three full suite groups. Native Windows suites were not run on this macOS host.
Docker smoke could not run because the local Docker daemon socket was unavailable; it is not
counted as a pass. No test was newly skipped or disabled to make the runs green.

New checks cover indexed command lookup through malformed legacy JSON and reopen migration; retained inbox query plans and dead-letter ordering; completed tool memory restoration; app slow-consumer recovery and oversized-frame compatibility; and live app/peer heartbeats with 128,000 retained inbox rows. The expanded transport case sends 1,000 events, including 40 tools, with an app and six idle peers. An isolated run received all ACKs in 377 ms with a 358 ms maximum timer gap and no abnormal closes. It is a regression workload, not a reproduction of the production 1006 incident. Assertions use the test watchdog budget, not the isolated benchmark's machine-specific timing.

Retention checks cover seven/fourteen-day boundaries, active/stale-running/late-result cases, total batch bounds, UTF-8 byte budgets, old tool-table migration, idempotence, duplicate ACK/conflict behavior, dead-letter preservation, interim-commit evidence, scheduled delivery/media references, durable messages, and the maintenance timer's invocation and shutdown. The moved markdown helper still passes both TypeScript parity coverage and the Python export-vector test. Compose's rendered gateway/relay logging configuration was validated without using production secrets.

The 40-tool storage benchmark exercises real admission, projection, persistence, and history, but collects broadcasts rather than running the entire app/tunnel/harness stack. No production load test, sustained soak, mobile-device profile, Rust benchmark, or production deployment was performed. Private logs remain outside the repository; only aggregate timings and connection metadata appear here.

Reproduce from the gateway repository with Node 24:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm -r --workspace-concurrency=1 exec vitest run --maxWorkers=2
cd packages/gateway
pnpm exec vitest run test/gateway-storage-audit.test.ts test/gateway-transport-audit.test.ts
```

From the CozyAgents repository:

```sh
node scripts/bench-attach-spool.mjs
```

The production acceptance step is to deploy the reviewed change through the normal release path, run representative 40+ tool turns with several attached bots and an app on the public URL, and compare abnormal closes, event-loop delay, ACK age, CPU, and memory. Acceptance requires durable replay correctness and stable connectivity; a healthy snapshot after a reconnect is insufficient evidence by itself.
