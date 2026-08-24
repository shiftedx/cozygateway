# CozyChat media delivery — engineering review notes

**Prepared for:** the agent implementing and optimizing the Hermes ↔ CozyGateway ↔ CozyChat media path  
**Date:** August 24, 2026  
**Scope:** outbound images, video, audio, and documents from an agent response, resend, proactive tool call, and scheduled delivery  
**Security:** no credentials or secret values are included

## Executive summary

Media delivery is not inherently burdensome for the agent. The desired agent contract should be one local path plus optional caption and destination. The current implementation has the right architectural pieces—atomic in-turn media upload, proactive delivery, deterministic IDs, rollback, and projection receipts—but the end-to-end behavior is still operationally fragile and sometimes misleading.

The main problem is not file generation. It is lifecycle agreement across three systems:

1. Hermes identifies and classifies a local file.
2. The CozyGateway adapter uploads it and associates media IDs with a message.
3. CozyGateway authorizes and projects the message.
4. CozyChat renders the attachment.
5. A terminal receipt proves the user can see it.

Today, “uploaded,” “done,” “journaled,” “projected,” and “displayed” are not consistently distinguished. The system can therefore look successful while the user receives no media.

**Recommendation:** retain the current atomic architecture, but make delivery IDs, MIME decisions, upload results, projection receipts, and final display state first-class and observable. Never report delivery success from `send_done`, journal acceptance, or upload completion alone.

## User-facing target contract

The agent should only need to emit:

```text
MEDIA:/absolute/path/to/file.mp4
```

or call a structured equivalent:

```json
{
  "path": "/absolute/path/to/file.mp4",
  "caption": "Optional caption",
  "destination": "active_turn | canonical_home | pinned_thread",
  "delivery_key": "stable occurrence key"
}
```

Everything else should be adapter/platform responsibility:

- canonicalize and validate the path;
- inspect file bytes rather than trusting the extension;
- determine an accepted MIME type;
- upload or transcode when policy allows;
- commit text and media atomically;
- retry safely with idempotency;
- return a durable terminal state;
- expose actionable errors without making the agent parse logs.

## Current implementation reviewed

Active adapter:

`/Users/kmcdowell/.hermes/profiles/cleo/plugins/cozygateway/cozygateway/adapter.py`

Important current code areas:

- Lines 276–284: per-turn media staging and absorbed-media cache.
- Lines 324–350: `_stage_response_media()` mirrors Hermes media extraction before the terminal response is sealed.
- Lines 352–355: `_media_family()` uses `mimetypes.guess_type(path)` and reduces it to `image`, `audio`, `video`, or `file`.
- Lines 1174–1230: active-turn terminal send uploads up to 16 media files, attaches media IDs to `send_done`, remembers successful paths, and returns `SendResult`.
- Lines 1245–1296: `send_proactive()` uploads media, rolls back all successful uploads if any upload fails, journals scheduled delivery, and waits briefly for projection.
- Lines 1318–1390: `_proactive_media_send()` handles standalone/resend media through the proactive path.
- Lines 1392–1479: video, document, voice, and image entry points acknowledge already-absorbed media, fold media into an active turn when possible, or use proactive delivery.

This is a better design than simply falling through to generic platform methods. However, several correctness and observability gaps remain.

## Verified runtime evidence

Primary logs:

- `/Users/kmcdowell/.hermes/profiles/cleo/logs/agent.log`
- `/Users/kmcdowell/.hermes/profiles/cleo/logs/errors.log`

Observed failures include:

```text
attach: one reply media upload failed (HTTP Error 415: Unsupported Media Type); committing the remaining reply
send_image_file fallback: native image send unavailable
send_document fallback: native file send unavailable
```

Observed video dispatch includes:

```text
Delivering 1 non-image MEDIA attachment(s)
Sending video attachment (.mp4) to native:cleo:<session-id>
```

The video log proves dispatch began. It does not prove CozyChat displayed the video.

A conservative baseline JPEG retry also reached `native image send unavailable`, ruling out the original PNG encoding and size as the only problem. Documents such as PDF, HTML, Markdown, and ZIP have also reached the unavailable native fallback in prior runs.

## Findings and likely failure modes

### 1. MIME detection is extension-driven and too coarse

Current `_media_family()` uses Python `mimetypes.guess_type(path)` and sends only the top-level family. This can disagree with:

- actual file bytes;
- HTTP upload `Content-Type`;
- CozyGateway allowlists;
- CozyChat renderer support;
- container/codec details inside MP4, WebM, MOV, or audio files.

A `.mp4` can contain unsupported codecs despite being classified as `video`. A file with a valid payload but unusual extension can become `application/octet-stream` and then `file`.

**Fix:** introduce a shared `MediaDescriptor` generated from byte sniffing plus technical probing:

```text
path, realpath, size, sha256, detected_mime, declared_mime,
family, container, video_codec, audio_codec, dimensions,
duration, filename, compatibility_status
```

Use the exact detected MIME for upload. Log mismatches between extension, byte signature, and declared type.

### 2. Active-turn partial failure can be reported as overall success

In the active-turn path, individual upload exceptions are logged and the remaining reply is committed. After that, `send()` returns success if the text/remaining media were committed.

That policy protects text delivery, but it can mislead both agent and user when the requested artifact was the central output.

**Fix:** return structured partial status:

```json
{
  "state": "partial",
  "message_id": "...",
  "uploaded": [...],
  "failed": [
    {
      "path": "...",
      "mime": "...",
      "status": 415,
      "error_code": "unsupported_media_type",
      "response_excerpt": "..."
    }
  ]
}
```

The final user message should visibly say an attachment failed rather than silently committing incomplete content.

### 3. `SendResult(success=True)` is not a displayed receipt

The in-turn path returns success immediately after `send_done`. The proactive path treats `projected` as success. Neither state necessarily proves the client rendered the media.

Define states explicitly:

```text
prepared → uploaded → journaled → projected → displayed
                                 ↘ blocked
          ↘ upload_failed
                     ↘ expired
```

Only `displayed` should support a hard claim that the user received the media. If CozyChat cannot currently emit display acknowledgments, expose `projected_unconfirmed` rather than `success`.

### 4. The two-second proactive projection wait is brittle

`send_proactive()` waits approximately two seconds for projection. A healthy but slower path can be classified as failure/pending, while a later projection may succeed. Retries then risk confusing user-visible outcomes even with deterministic delivery IDs.

**Fix:** make projection asynchronous and durable:

- return `accepted_pending` with IDs immediately;
- keep a durable state-machine row in the spool;
- update it when receipts arrive;
- retry according to bounded policy;
- deliver one terminal notification or expose a queryable status;
- never reinterpret timeout as terminal failure.

### 5. Absorbed-media dedupe is process-local and path-based

`_absorbed_media` is a bounded in-memory `OrderedDict` keyed by real path. A process restart loses it. Replacing file contents at the same path can also collide semantically with prior state.

**Fix:** dedupe by occurrence + content hash + destination, persisted in the spool:

```text
(delivery_occurrence, sha256, canonical_destination)
```

Keep path only as metadata. This preserves idempotency across restart without suppressing a genuinely new file written to the same path.

### 6. Destination semantics need one canonical model

Media can target:

- the active turn/thread;
- a caller-pinned thread;
- the profile’s canonical CozyChat home.

These must not be inferred differently by response delivery, standalone media, `send_message`, or cron. Historical scheduled delivery was quarantined as `unauthorized_target`, followed by “journaled; projection not yet confirmed” and `empty_delivery` fallback.

**Fix:** define one typed destination object and use it everywhere:

```json
{
  "kind": "active_turn | canonical_home | thread",
  "profile": "cleo",
  "thread_id": null
}
```

Validate authorization before upload when possible. Do not upload a large file only to discover that its target is forbidden.

### 7. Error logging lacks enough media detail

HTTP 415 currently surfaces as a generic exception string. For rapid diagnosis, record:

- delivery ID, message ID, media ID;
- canonical path or privacy-safe basename;
- byte size and SHA-256;
- extension and detected MIME;
- HTTP method and endpoint class, without credentials;
- response status and sanitized body;
- destination kind;
- lifecycle state at failure;
- whether rollback succeeded.

Never log bearer tokens, signed upload URLs, or full secrets.

### 8. File readiness should be verified before upload

Generated media may still be flushing, cloud-evicted, symlinked, unreadable, or malformed.

**Fix:** before upload:

- resolve and authorize the real path;
- require a regular readable file;
- capture size twice after a short stability interval for newly generated output;
- validate supported size limits;
- run bounded technical probes for video/audio;
- fail locally with an actionable error before making a network request.

### 9. Compatibility policy should be explicit

Recommended baseline support:

- Image: PNG, baseline/progressive JPEG, WebP if the client supports it.
- Video: MP4 with H.264 video + AAC-LC audio, `yuv420p`, fast-start metadata.
- Audio: M4A/AAC, MP3, WAV where supported.
- Documents: PDF and an explicit allowlist; unsupported ZIP/HTML/Markdown should fail clearly or use an intentional file-download treatment.

Do not silently transcode originals unless policy allows it. If transcoding occurs, preserve the original name as metadata and report what changed.

## Recommended implementation sequence

### P0 — truthful lifecycle

1. Add a typed delivery result with `pending`, `partial`, `displayed`, and terminal failure states.
2. Stop equating `send_done`, upload completion, or journal acceptance with user receipt.
3. Include attachment failures in the user-visible response.
4. Persist lifecycle state and IDs in the spool.

### P1 — MIME and upload correctness

1. Add byte-level MIME detection.
2. Add `ffprobe`-style bounded media inspection or equivalent library probing.
3. Align MIME allowlists across Hermes, CozyGateway, and CozyChat.
4. Return sanitized HTTP status/body details for rejected uploads.
5. Validate destination authorization before expensive upload.

### P1 — unified delivery path

1. Route active-turn, resend, proactive, and scheduled media through one upload/commit service.
2. Keep only destination selection and reply anchoring platform-specific.
3. Use persisted content-hash idempotency.
4. Use the same receipt handling for every path.

### P2 — performance optimization

1. Stream uploads from disk rather than reading entire files into memory.
2. Hash while streaming so validation does not require a separate full read.
3. Add bounded concurrent upload for multi-attachment replies.
4. Apply aggregate and per-file limits before upload.
5. Cache immutable media descriptors by inode/size/mtime, with content-hash verification when required.
6. Add backpressure so large media cannot starve text/tool event transport.

## Required tests

### Unit tests

- Extension and byte signature agree.
- Extension and byte signature disagree.
- Unknown extension with supported bytes.
- Unsupported codec inside a valid MP4 container.
- Zero-byte, unreadable, symlink, missing, and still-growing files.
- Exactly 16 files accepted; 17 rejected deterministically.
- One upload failure in a multi-file active reply returns `partial`.
- Rollback success and rollback failure are separately visible.
- Same path with changed content is not incorrectly deduped.
- Same occurrence/content/destination is idempotent across restart.
- Projection timeout remains pending, not failed.
- Late receipt updates the durable state exactly once.

### Integration tests

Use a fake CozyGateway server capable of returning:

- 200 upload + projected + displayed;
- 403 authorization failure;
- 415 unsupported MIME;
- 413 file too large;
- 429 with retry guidance;
- 500/502 transient failure;
- dropped socket before and after upload;
- delayed projection/display receipts;
- duplicate receipt and replayed occurrence.

Assert media IDs, delivery IDs, message IDs, rollback calls, retry count, and final state.

### Live acceptance tests in CozyChat

Do not stop at simulator or server logs. Confirm the artifact visibly renders in Kyle’s actual CozyChat client:

1. PNG attached to an active text reply.
2. Baseline JPEG attached to an active text reply.
3. H.264/AAC MP4 attached to an active reply.
4. Resend the same video after the original turn closes.
5. Image-only proactive canonical-home delivery.
6. Text-plus-image proactive delivery.
7. Scheduled text-plus-image delivery after `/new`.
8. PDF/document delivery.
9. Unsupported ZIP with a clear terminal error.
10. Multi-attachment reply where one file is rejected.
11. Socket interruption during upload and during projection.
12. Receipt reconciliation proving Hermes, CozyGateway, and CozyChat share the same IDs and terminal state.

For every test, record:

```text
delivery_id, message_id, media_ids, upload state,
projection state, client display state, terminal result
```

## Definition of done

The media feature is production-ready when:

- the agent only supplies a path, caption, destination, and occurrence key;
- supported files render consistently across active, resend, proactive, and scheduled paths;
- retries do not duplicate messages;
- unsupported files fail before or during upload with actionable detail;
- partial failures are visible;
- state survives gateway/agent restart;
- success means the CozyChat client displayed the artifact;
- every layer agrees on IDs and terminal state;
- all live acceptance tests pass on Kyle’s real CozyChat client.

## Bottom line

The agent-side API can and should remain trivial. The burden belongs in the delivery integration, where it can be implemented once, tested deterministically, and observed end to end. The existing adapter already contains a solid foundation; the priority is to make its lifecycle truthful, persistent, MIME-aware, and shared by every delivery mode.
