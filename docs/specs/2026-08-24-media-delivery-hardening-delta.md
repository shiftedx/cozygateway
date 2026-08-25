# Media delivery hardening: delta and adoption notes (2026-08-24)

Companion to Cleo's engineering notes (2026-08-24-media-delivery-hardening-cleo.md), recorded by
the coordinating agent after the same-day fix wave. Status: ADOPTED as the next media epic.

## Closed the same day (before/while the notes were written)
- Standalone/resend/proactive media routing (PRs #159 #163 #164 #165)
- 415 diagnostics with filename, MIME, status (#159); media pair normalization (#164)
- Fetch-id shape unification: the "photo is no longer available" defect (#165)
- Canonical-home destination semantics for scheduled/cron sends (#159 #163 #164)
- Displayed receipts end to end: displayed is a durable recorded state on all three hops
  (#160 #161 cozychat#265), live-proven. Finding 3's foundation exists; remaining work is
  wiring media-level states onto it.
- Approval hook surfaces (#166), unrelated but same wave.

## Remaining scope (accepted, in Cleo's priority order)
- P0: `partial` result for multi-attachment replies; user-visible attachment failure in the
  committed message; persisted per-media lifecycle rows in the spool.
- P1: byte-sniffing MediaDescriptor (drop mimetypes.guess_type as the decider); pre-upload
  destination authorization; content-hash + occurrence + destination dedupe persisted in the
  spool (replace process-local _absorbed_media); async projection (accepted_pending + durable
  upgrade via the receipts machinery) replacing the 2s wait.
- P1: one upload/commit service shared by active-turn, resend, proactive, scheduled.
- P2: streaming uploads + hashing, bounded concurrency, size limits, descriptor cache,
  backpressure.
- Tests: adopt her unit + fake-gateway integration matrix and the 12 live acceptance tests
  verbatim as the epic's definition of done.

## Also standing (same wave, different layers)
- cleo's visual-reporting skill must emit MEDIA: tags (agent-side authoring fix, Cleo owns).
- approvals.timeout/expiresAt follow-up (CozyLabs#1474 family).
- hermes-core upstream: cron fallback payload loss; send handler args=None lane.

## Live acceptance run (2026-08-24, Lane E)

Run against the deployed stack: gateway 0.2.8, six attach plugins online, cleo's plugin byte
identical to the epic head (06f9c28). Deliveries were driven through `zz-accept-` prefixed
`--no-agent` cron jobs on cleo's own profile (the scheduled/canonical-home lane) and, for the
interruption test, on the quiet `rustic-squirrel` profile. Every row was read back from both
sides: the profile spool (`plugin-data/cozygateway/attach-v1.sqlite`, `media_lifecycle` and
`media_occurrences`) and the box (`/data/cozygateway.db`, `attach_scheduled_deliveries`,
`bot_native_messages`, `bot_message_receipts`).

`displayed` is receipts-based. It appears below only where the owner actually opened the chat and
the device receipt landed; nothing was simulated.

| # | Test | delivery_id (short) | message_id (short) | media_id (short) | upload | projection | receipt | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | PNG on an active text reply | n/a | n/a | n/a | not run | not run | not run | BLOCKED, see deviations |
| 2 | Baseline JPEG | `scheduled:e9086489` | `scheduled-dbf9f9e3` | `b8de3ac0` (image/jpeg) | uploaded | projected | displayed | PASS |
| 3 | H.264 + AAC MP4 | `scheduled:64e64260` | `scheduled-5d3de0f1` | `636d3a68` (video/mp4) | uploaded | projected | displayed | PASS |
| 4 | Resend the same video after the earlier turn closed | `scheduled:44aa6551` | `scheduled-0cd15653` | `c1810caa` (video/mp4) | uploaded | projected | displayed | PASS |
| 5 | Image-only proactive canonical home | `scheduled:04cf81ec` | `scheduled-00a20ef5` | `225231eb` (image/png) | uploaded | projected | displayed | PASS |
| 6 | Text plus image proactive | `scheduled:c8df7fc0` | `scheduled-fe44618c` | `a2607c45` (image/png) | uploaded | projected | displayed | PASS |
| 7 | Scheduled text plus image | `scheduled:ba29b24e` | none | `58c88f5f` (image/jpeg) | uploaded | never projected | none | FAIL, wedged stream |
| 8 | PDF document | `scheduled:f846b539` | `scheduled-3d3a2901` | `68c3e226` (application/pdf) | uploaded | projected | displayed | PASS |
| 9 | Unsupported ZIP | `scheduled:7fc09036` | none | `02dc3f70` (application/zip) | refused locally, no request | none | none | PASS |
| 10 | Multi-attachment, one file rejected | `scheduled:e9148859` | none | `e4b831f2` zip blocked, `9183125e` png rolled back | png uploaded then deleted | none | none | PASS with a caveat |
| 11 | Socket interruption during upload | `scheduled:d718b438`, `scheduled:c889272b` | `scheduled-b050dd51`, `scheduled-85dc0c28` | `7641e156`, `b3d31bfe` (video/mp4, 30.6 MB) | uploaded | projected | displayed | PASS |
| 12 | Receipt reconciliation across the three layers | all rows above | | | agree | agree | agree | PASS |

Tests 9 and 10 record the policy as it stood on the run date. `application/zip` has since been
admitted as a FILE attachment (delivered and shareable, never rendered inline) under the 20 MiB
document cap; see the canonical media allowlist in `contract/ext-bots-v1.md`. The rows are left
as recorded because they are evidence of a run, not a live statement of policy.

Test 4 resent identical bytes under a new occurrence and correctly got a new media id: identity is
(occurrence, content hash, destination), so a genuine resend is not suppressed. Test 9 never made a
network request; the bytes answered the question and the reason names the fix. Test 10 refused the
ZIP, rolled the already-uploaded PNG back, and `attach_media` on the box confirms the rolled-back
bytes are gone. Test 11 restarted the profile 1.3 s into a 30.6 MB upload; the durable occurrence
survived, no state ever claimed a delivery that had not happened, and the retry converged through
`journaled` to `displayed`.

### RED: a rolled-back media event wedges the agent's whole event stream

Test 10's rollback left cleo unable to deliver anything at all, and it has not recovered.

`AttachSpool.begin_media_cleanup` DELETES the media descriptor row from `event_outbox` when an
atomic occurrence is abandoned. When that row was allocated a sequence but never delivered, the
plugin's outbound sequence stream skips a number permanently. The gateway requires strict
contiguity (`packages/gateway/src/storage.ts`: `frame.sequence !== stream.sequence + 1` answers
`gap`), and the plugin answers an event `gap` by calling `replay()`, which re-sends the same rows
starting after the hole. Neither side can fill it, so the two livelock in silence.

Observed on cleo: `event_outbox` sequence 107842 was deleted by test 10's rollback at 16:00:51.
Every event from 107843 on is unsent; `attach_streams.last_event_sequence` for cleo is still
107841 and `attach_event_inbox` ends at 107841. Heartbeats keep flowing the whole time, so the
gateway reports the plugin online (degraded) and nothing errors. Test 7 is the first casualty:
`journaled` in the spool, never projected, honestly reported as
"delivery is durable but projection is not yet confirmed". A gateway restart and a fresh
`hello_ack` do not clear it, because the hole is in the durable numbering, not in memory.

Operator repair for the current wedge (advance the gateway past the deleted sequence, then the
plugin's next drain is contiguous again):

```sql
-- inside cozygateway-gateway-1, against /data/cozygateway.db
UPDATE attach_streams SET last_event_sequence = 107842, updated_at = <now_ms>
 WHERE agent_id = 'cleo' AND last_event_sequence = 107841;
```

The fix belongs in the plugin: an abandoned media descriptor must not vacate its sequence. Either
leave the row in place and rewrite it to an inert no-op event that the gateway accepts and drops,
or make the gateway tolerate a producer-declared skip. Deleting a numbered row from a strictly
ordered stream cannot be made safe by ordering alone, and the current docstring on
`begin_media_cleanup` ("`event_cursor` remains monotonic") is true but not sufficient.

### Second finding: the event loop is blocked by spool reads on a large outbox

While the wedge grew, the profile logged asyncio slow-callback stacks through
`AttachSpool.pending_events` and Discord reported its shard heartbeat blocked for more than ten
seconds. Cleo's outbox holds 103,045 rows in a 73 MB spool, and `pending_events` runs on the event
loop. Lane E moved the media BYTES off that loop; this read is the remaining hog, and it wants
either a worker thread or an index and a retention sweep on `event_outbox`.

### Deviations from Cleo's 12

- Tests 1, 2, 3 and 10 are written as ACTIVE-TURN replies. An active turn begins when the owner
  messages the bot, which cannot be synthesized without speaking as him, so every delivery here
  went through the scheduled/canonical-home lane. Since the epic routes all four paths through one
  `MediaUploadService`, the probe, policy gate, dedupe claim, upload and lifecycle marks under test
  are the same code; what is NOT covered is active-turn reply anchoring and the `partial` result
  shape, which only that lane returns. Test 1 was not run at all because the event stream was
  already wedged by test 10.
- Test 7's `/new` half was skipped on purpose: resetting the owner's session is his to do.
- Test 10 proves rollback, not `partial`. On the proactive/scheduled lane a refused attachment
  fails the whole occurrence, so the person sees nothing rather than the text plus a sentence
  naming what was lost. That is atomic and honest, but the finding-2 remedy (commit the text,
  append the failure sentence) exists only on the active-turn path. Worth deciding whether a
  scheduled report should degrade to text rather than vanish.
