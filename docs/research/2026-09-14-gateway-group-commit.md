# Durable gateway batching

Commit `198e478f0e551d98c9fd0c646b6e612d4ea6882f` batches attach admission and projection markers while retaining SQLite WAL with `synchronous=FULL`. This removes repeated durable commits from the measured hot path without changing the wire protocol or either harness plugin. Both Hermes and CozyAgents use the same ingress.

## Measured result

Three alternating before/after runs used the same Linux host, Node 24.20.0, dependency image, benchmark, and synthetic fixture. Each run used a disposable database with 128,000 retained events and sent 40 tool calls, 920 draft updates, and one terminal commit: 1,001 acknowledged events under the negotiated 64-event/byte window. No real agent, model, or external network was invoked. The baseline was the deployed `18939c2` image; the candidate mounted the final compiled gateway onto that same image.

| Measurement | Baseline median | Candidate median | Change |
| --- | ---: | ---: | ---: |
| Complete burst acknowledged | 4,847.32 ms | 894.41 ms | 5.42× faster; 81.5% less elapsed time |
| Process CPU during burst | 1,087.79 ms | 643.27 ms | 40.9% less CPU |
| Maximum sampled event-loop timer gap per run | 396.38 ms | 99.62 ms | 74.9% lower |
| Sampled RSS growth during burst | 3.375 MiB | 4.125 MiB | 0.75 MiB higher |

Burst times were 4,847.32 / 4,805.76 / 5,055.59 ms before and 894.41 / 942.62 / 843.04 ms after. All eight runs, including the paced pair below, passed every benchmark assertion: exact ACK identity/sequence, final transcript and terminal, 40 completed tool rows, app terminal delivery, open sockets, and empty event/command/dead-letter queues.

A separate ordinary-streaming pair used 80 drafts spaced 50 ms apart. Draft ACK median/p95 changed from 4.93/7.07 ms to 6.52/9.02 ms. The idle batching timer therefore costs approximately 1–2 ms on paced traffic in this fixture. Its first draft overlaps the initial tool burst; maxima of 123.63/145.12 ms include that overlap and must not be represented as steady streaming latency. These paced measurements are a single pair, not repeated-run medians.

The event-loop column is the median of each run's maximum sampled timer gap, not an event-loop p95 or a guaranteed latency bound. RSS is a sampled process measurement during the burst, not a steady-state memory ceiling. These gains apply to gateway event processing; they do not accelerate model inference or context compression.

## Mechanism and durability

- One connection FIFO holds at most 32 draft/tool/thinking events and respects the negotiated byte limit. As before, one valid oversized frame can progress from an otherwise empty window.
- A single refreshed native zero-delay timer collects an idle burst. `ws` yields between received frames through `allowSynchronousEvents: false`. Control frames, terminal events, and other semantic boundaries drain the preceding FIFO before proceeding.
- Storage commits each admission batch before projection and before ACKs. Gap/conflict outcomes stop at the valid prefix; unadmitted frames remain the sender's responsibility to replay. An exception rolls back the complete transaction.
- Projection markers batch only the ephemeral prefix. Markers are committed before a subsequent side-effecting callback. Successful callbacks whose marker write fails retain a bounded list of IDs for marker-only retry; they are not reinvoked while the process remains alive. Reconnect can finish these markers even if the peer only replays duplicates.
- Replacement, revocation, close, and shutdown discard unadmitted queues without acknowledging them. Existing durable journals remain the replay authority after process death.

Actual SIGKILL tests cover death before admission commit, after admission commit/before projection, and after real tool projection/before its marker commit. Recovery proves missing ACKs remain replayable, admitted rows survive, tool state is idempotent, and the eventual final message appears once. The crash hooks assert `FULL` on the actual writing connection. These are process-death tests, not physical power-loss testing.

Ponytail review retained the small FIFO, timer, and bounded marker retry state because they enforce ordering and recovery. No dependency, worker service, protocol version, schema migration, or Rust rewrite was added. A prototype that yielded each frame but did not refresh its idle timer broke too many batches and took 1,844 ms; the refreshed native timer retained useful batching. A pure immediate flush was somewhat faster in a preliminary run but blocked the event loop longer. The selected 32-event limit bounds each drain, not the cost of every possible valid frame or projection callback.

## Validation

The final complete Node 24 workspace gate passed: 208 contract, 164 relay, 1,903 gateway, and 165 conformance tests, totaling **2,440 passed and 26 existing skips**. Build, workspace typecheck, the complete gateway installer suite, and `git diff --check` passed. Tests also cover admission rollback, applied-marker rollback, reopen, duplicate/gap/conflict handling, terminal and desktop-resume barriers, count/byte bounds, teardown, marker retry exhaustion, and reconnect recovery.

The broader run exposed two fixture assumptions, both fixed before acceptance: packet arrivals were incorrectly assumed to share a batch, and one fake-clock conformance test never advanced the newly deferred WebSocket receiver. Deterministic barriers and the existing timer-aware wait helper preserve the original assertions; no production timeout was enlarged.

CozyAgents and Hermes code did not change in this batching pass. Their previously completed suites remain 3,629 and 598 passed respectively, for **6,667 passed and 41 skips** across the combined work. Native Windows-specific installer suites were not executable on this Mac; this is not a claim that those platform gates ran.

## Live Cleo incident

During validation, the user reported Cleo appearing unresponsive. Her command reached Hermes in 21 ms. Hermes then spent **113.439 seconds** compacting approximately 204,000 context tokens before normal model execution resumed. The final event applied in 29 ms and the turn completed. The app receipt was later, but it reports transcript-row realization and a queued POST, not socket arrival; the user may have switched chats. No restart was needed. See [the incident timeline](2026-09-14-cleo-response-delay.md).

The gateway also logged roster refresh timeouts. Their causal relationship to other symptoms remains unproven; the measured Cleo pause was context compression. An app-visible compaction status and separate Hermes context-performance work are concrete follow-ups, rather than reasons to restart a healthy gateway.

## Deployment and recovery

The gateway was deployed at **2026-09-14 04:48:48.273 UTC** to `warm.cozylabs.ai`, using image `cozygateway-gateway:perf-198e478`, ID `sha256:d98277029fc567e7ea1d6f9c2f34e1cfeda42724f98534a04daad9838fd3836f`. Docker smoke passed actual startup, setup-code pairing, authenticated settings changes, restart, and settings persistence. The Linux host has no native Node executable, so the smoke script's host-side JSON operations used Node from the same image in disposable containers. Compiled ingress and storage SHA-256 values exactly match the benchmarked artifacts.

There were no active turns at rollout. All four Hermes peers reconnected by 04:49:01 and all three CozyAgents peers by 04:49:13. Final public readiness and internal Docker health were healthy, with **7/7 online, zero queues and zero dead letters**. All 1,951 native messages, 38 paired devices, one runner, and all seven event cursors were preserved. The gateway had zero restarts after rollout. The runner stayed running; the pre-existing `breezy-aster` model-unavailable status remains separate from its healthy transport. Relay, tunnel, and maintenance containers were not recreated.

A fresh consistent SQLite backup is retained at `/Users/kmcdowell/.cozylabs-backups/gateway-group-commit-20260914/gateway-before.db` (782,856,192 bytes; SHA-256 `819410ea16fd4d9f13f6be3bfb525e58f17f48c3c7c1771283f4d2c7ed429df2`). `quick_check` passed and its hash matched the server-side snapshot before the temporary server copy was removed. The prior image `cozygateway-gateway:perf-18939c2` remains available. There is no schema migration; ordinary binary rollback should retain the current database. Restoring an old database after accepting new work requires reconciliation and is not an ordinary image rollback.

[Machine-readable evidence](2026-09-14-gateway-group-commit-evidence.json) includes all eight measurements, medians, validation, artifact hashes, and deployment state. Reproduce after `pnpm build` with `node scripts/bench-gateway.mjs`; use `DRAFTS=80 DRAFT_INTERVAL_MS=50` for the paced fixture.
