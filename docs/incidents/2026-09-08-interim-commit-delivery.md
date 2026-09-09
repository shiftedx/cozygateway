# Interim commit silently blocks later replies

Cleo accepted a production message at 21:26:08 America/Chicago. Hermes reset its idle session and emitted a reset notice at 21:26:11. The adapter correctly marked that message `commit, continues: true`, but `AttachSpool.enqueue_event` inserted every commit into `turn_terminals`. The client silently discarded later events after catching `TerminalSealed`. The gateway remained healthy and acknowledged the notice; the model continued successful tool calls until an interrupt at 21:26:58. A subsequent follow-up was delivered as steering for the stopped turn.

## Repair

Only final commits seal the spool; `continues: true` commits remain durable messages and allow later drafts, tool activity, replies, and termination. Real failure, cancellation, interruption, and final-commit fencing remain intact. The existing interim-reply tests mocked the durable queue; new coverage uses the real adapter, client, and SQLite spool, and separately checks restart durability.

The original isolated reproduction against the installed plugin failed with `TerminalSealed`. The new adapter regression failed with one delivered commit instead of three before the fix, then passed. All 587 plugin tests passed (one skipped). The focused adapter suite also passed against the repaired installed plugin.

## Production application

Applied only `attach_spool.py` to the four installed profile copies, global plugin copy, and staged provisioner copy, keeping their content identical so the provisioning sweep cannot revert the repair or trigger unrelated restarts. Restarted only Cleo's idle launchd service. Shutdown confirmed zero active turns, cron jobs, API calls, and deferred work. Existing chat, session, and spool databases were preserved. Other running bot processes retain their loaded code until their next normal restart.

Cleo reconnected and became writable at 21:34:51 America/Chicago. Production health reported 5/5 attach identities online, zero degraded or absent identities, zero queued work, and zero dead letters. Other bot service PIDs were unchanged. The original installed-plugin reproduction now passes, and its patched checksum remained intact after the provisioning sweep.

The source fix is based on Gateway v0.8.1 revision `a33e3bd` and must be included in the next release; reinstalling an unpatched release can overwrite the local repair. This repair does not replay the user's cancelled request. End-to-end confirmation requires a new user message.

Deployed file SHA256: `88ae7950141d289934be067a08d4721e7654c82e06d581bb185a9b7d5dcc23e5`.
