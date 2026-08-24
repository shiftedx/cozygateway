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
