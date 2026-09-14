# Gateway deployment and focused performance pass

Deployment began September 13, 2026 CDT (September 14 UTC), after the user authorized deployment for hands-on testing. Historical disconnect diagnosis is parked unless it recurs. Ponytail remains the implementation rule: measured work removed first; existing SQLite indexes and native runtime facilities preferred.

## Deployed components

| Component | Deployment identity | Verification |
| --- | --- | --- |
| Gateway | 0.8.4, final runtime commit `18939c28` | Public health/readiness; seven attach peers; zero queue depth and dead letters. |
| Hermes plugin | Reviewed `integrations/attach-plugin` in all four Mac profiles and global plugin directory | Full plugin-tree hashes match; service restarts and attach hellos verified. |
| CozyAgents | `v0.2.17-perf.20260913`, commit `d6de09cb2af35b01bed71e161f0643eacfc2c728` | Installer checksums, launchd, three runtime health endpoints and attach streams verified. |

The final gateway image is `cozygateway-gateway:perf-18939c2`, image ID `sha256:7597892c1e35b7d6989c4a2d8ce8729f81d090f99d2ce16054b36074026e1b20`, started at `2026-09-14T03:45:30.548926865Z`. A live Cleo turn finished before the final idle gate and restart. All seven peers returned online, all queues were empty, all 38 paired devices and the runner remained, and durable native message count grew from 1,936 to 1,938 across the user's test turn.

The initial gateway image was `cozygateway-gateway:perf-c870fb5`, image ID `sha256:b6ba50382368efd07548598908f86b7b3a0fca8b8e6e3dd055eb741b4c512daf`. It was built on the production Linux host from a tracked-file archive of the reviewed commit. Docker smoke passed actual startup, pairing, authenticated settings changes and persistence across restart using a disposable container. The live gateway uses Docker's `local` logging driver, three 10 MB files and a nonblocking 1 MB buffer. Relays and the Cloudflare tunnel were not recreated.

CozyAgents was installed through the normal generated installer with a retained private release directory and `--no-pair`; no public release was published. Bundle SHA-256 is `a147d9380f182ae5a5715fcad23a23a62f623e1e3bfc6808bb31363060f86154`. Its recorded manifest is `/Users/kmcdowell/.cozyagents/releases/perf-d6de09cb/agents-release.json`; that directory must remain available for local repair. All three prior JSON spools are now SQLite, including their existing `.json` pathnames. Events, command counts, stable IDs, and sequence cursors match the quiesced snapshots; SQLite integrity checks passed.

The pre-existing `breezy-aster` model-unavailable state remains. Its runtime and transport are healthy; the other two CozyAgents bots are ready. There are still 38 paired devices and one runner. No pairing credentials were rotated.

## Measured live behavior

These measurements describe this host and workload, not an absolute performance ceiling.

| Measurement | Result | Scope |
| --- | --- | --- |
| Cleo pending-event query | 0.0324 ms median; 0.0505 ms p95 | 30 read-only queries on the live database, both partial indexes confirmed in the plan. Earlier production query measurements were 113–120 ms. |
| Container-local `/health` | 2.42 ms median; 3.75 ms p95 | 50 requests, includes HTTP and response consumption; first/cold maximum 57.4 ms. |
| Public `/health` from LAN | 62.1 ms median; 132.2 ms p95 | 25 new curl connections through `warm.cozylabs.ai`; every request returned 200. Includes connection, TLS and edge/tunnel costs. |
| Quiet process CPU | 0.733% of one CPU core | 30-second `/proc/1/stat` sample; Linux clock tick rate verified as 100 Hz. |
| Quiet process RSS | About 207 MiB | Process resident pages, distinct from Docker's working-set-style memory display. |

The production host initially had only 341 MB free on a 16 GB filesystem. Unused Docker build cache older than 24 hours freed 1.8 GB. Two old release backups (v0.7.8 and v0.7.9) were moved to a private Mac archive, and all 22 contained files were hash-verified before their host copies were removed. The current production database and recent rollback releases were retained. After the first image build, the host had 2.6 GB free.

## Focused pass findings

A private copy of the consistent production database contained 189 tasks, 178 terminal, and 670 task events. `Tasks.reconcile()` rebuilt every task view before ignoring terminal tasks. This runs on the attach heartbeat. Thirty warm measurements found 17.1 ms median / 21.2 ms p95 for reconciliation and 34.0 ms median / 42.6 ms p95 for public task listing, which reconciled before rebuilding views again.

The focused change selects candidate task IDs by their latest durable event using the existing `(task_id, seq)` primary key. It retains the existing full view and reconciliation logic for unfinished tasks. It adds no cache or materialized state. Public list freshness and task state semantics remain intact. Thirty warm measurements after the change found 3.714 ms median / 6.562 ms p95 for reconciliation and 19.913 ms median / 24.460 ms p95 for listing. A fixture with 10,000 terminal tasks plus one active task reconciled in 6.248 ms median. Selection still scans one indexed latest event per task; an active-task index would only be justified if that remaining scan becomes material.

Counterchecks on the same snapshot did not justify additional changes: largest tool history (846 rows) read in 0.88 ms median, largest message history (172 rows) in 0.27 ms, and attachment pages in 0.54–0.65 ms. These reads still have a growth ceiling; this pass does not claim unbounded histories cost constant time.

Deployment also exposed a quote-only token comparison in the bot provisioner. A local quoted token and the same plain token on the host could be treated as a change and trigger gateway recreation. The fix compares simple literal token scalars while retaining exact comparison for complex/escaped values; credentials remain unchanged.

## Recovery and evidence

Private gateway backup: `/Users/kmcdowell/.cozylabs-backups/gateway-performance-20260913/gateway-before.db`, consistent SQLite backup, SHA-256 `f4d912a4c17f4d1e58594d4024e9223f25abbf7297dd47220c7b04e13ca70e3b`. Prior image retained as `cozygateway-gateway:rollback-before-perf-c870fb5`; prior source retained on remote branch `codex/rollback-before-perf-c870fb5`. Remote config snapshots and deployment logs are under `/home/kmcdowell/cozygateway/backups/perf-c870fb5-20260913`.

CozyAgents quiesced snapshot: `/Users/kmcdowell/.cozyagents/backups/pre-v0.2.17-perf-20260913T220648`. Hermes snapshots: `/Users/kmcdowell/Library/Application Support/cozylabs/deployment-backups/hermes-attach-20260914T030239Z`. These directories contain private state and are access-restricted.

Restoring an old database/spool after new work has been accepted can discard that new work. Recovery must quiesce first and reconcile the state admitted since the snapshot; a blind data rollback is not a normal release rollback.

Predeployment validation passed 6,644 tests across gateway/workspace, CozyAgents and Hermes Python, with 41 existing skips. Installer, lifecycle, bundle, typecheck, package and dependency checks passed. Native Windows-specific suites require a Windows host; they were not executed on this Mac. Docker smoke, previously unavailable locally, passed on Linux during this deployment. Raw timing evidence is in `/tmp/cozygateway-deployed-perf-20260913`; the original audit and evidence remain beside this report.

## Statement preparation and remaining cost

The full projection benchmark exposed repeated SQL compilation: native `prepare` consumed about 244 ms in a 542 ms local burst. A connection-scoped cache of 128 prepared statements avoids that work for Storage, Tasks, Artifacts and Observe. It uses a short native `DatabaseSync` subclass and a bounded FIFO map, with no new dependency, proxy, timer, result cache, or transaction-policy change. Current callers use synchronous `get`/`all`/`run` and no mutable per-statement options or iterators. Tests cover fresh positional/named bindings, rollback, SQLite automatic reprepare after schema changes, eviction, and close/reopen. [Node SQLite statement documentation](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html) describes reusable parameterized statements; its native tag cache requires a different tagged-template call style and is not a drop-in replacement for this code.

The checked-in `scripts/bench-gateway.mjs` runs real WebSocket ingress, durable admission, native chat projection and app delivery with 128,000 retained events, 40 completed tools, 920 drafts and a terminal commit. Its sender obeys the negotiated 64-event/byte window and it uses production heartbeat defaults. It verifies all 1,001 ACKs, the final message/terminal, all 40 tool rows, empty queues, no dead letters, and eight open sockets. CPU profiles cover only the burst, excluding database seeding and handshake. No real bot or provider is invoked.

Local final-class measurements: ACK drain 509.4 → 264.1 ms; CPU 475.2 → 225.8 ms; temporary RSS growth 9.3 → 2.6 MB; maximum observed timer gap 79.4 → 62.9 ms. These are individual comparable runs, not medians. On the Linux host, the prototype on the same compiled gateway reduced CPU 2579.9 → 1305.1 ms and ACK drain 6364.1 → 5127.1 ms. The actual final Docker image measured 5125.8 ms ACK drain and 1301.5 ms CPU, with a 304.5 ms maximum timer gap. All protocol, persistence and app-delivery checks passed. Compared with the same host/fixture before statement reuse, this is 49.6% less CPU and 19.5% less elapsed burst time. These remain single-run characterizations.

The remaining Linux cost is dominated by durable transaction commits: about 4.7 seconds of the 5.1-second profiled prototype burst was inside acceptance/applied-marker transaction `exec` calls. The host filesystem and its sync latency therefore matter. This pass retains the full durability policy; it does not claim the absolute performance ceiling has been reached. Batching durable admission/ACK boundaries is a separate semantic change requiring explicit crash/replay qualification; rewriting the existing transaction pattern in Rust would not remove those disk syncs.

An earlier saturation characterization intentionally sent all 1,001 frames without respecting the negotiated window. It must not be interpreted as current harness behavior. With production heartbeat defaults it took 6.37 seconds on Linux, and a deliberately shortened test heartbeat caused the app-delivery check to fail; the final benchmark uses the actual protocol limits and heartbeat defaults.

Re-run locally after `pnpm build` with `node scripts/bench-gateway.mjs`. Set `CPU_PROFILE=/absolute/path/profile.cpuprofile` to capture a native Node CPU profile. For the Docker artifact, mount only the synthetic benchmark directory and use `--network none`, `GATEWAY_BUILD_ROOT=/app/dist`, and a disposable `TMPDIR` on the host filesystem.

Final validation after the task and statement-reuse changes: 2,420 gateway/workspace tests passed with 26 existing skips. Together with the unchanged, previously verified CozyAgents and Hermes suites this is 6,647 passed and 41 existing skips. The complete gateway installer suite and final Docker smoke passed again. [Machine-readable evidence](2026-09-13-gateway-deployment-performance-evidence.json).

After final deployment, a quiet 30-second sample measured 0.267% of one CPU core and about 137 MiB RSS. This is a short post-restart observation, not a steady-state memory ceiling. Final disposable build-cache cleanup left about 2.8 GB free. The provisioner payload was refreshed to the committed source; its quote-normalization preflight and a full watcher interval left the gateway container intact.
