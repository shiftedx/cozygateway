# Task 5 report: single-scan phone verification

## Status

Complete. Implemented the additive, low-authority phone reachability protocol and preserved the
existing pairing, app WebSocket, and attach-v1 surfaces.

## Scope delivered

- Added a 256-bit, 43-character base64url phone capability with SHA-256-only SQLite persistence,
  a server-generated matching phrase, ten-minute wall-clock and monotonic expiry, and one live
  challenge/session.
- Added a self-contained same-origin page whose only phone action is opening the scan URL. It
  immediately removes the capability path from history, then performs health -> one fixed-schema
  WebSocket echo -> one confirmation POST and displays the POST's authoritative phrase.
- Kept GET, HEAD, OPTIONS, previews, and prefetch inert. The page contains no setup code, device
  token, identity, phrase, persistent credential, button, or third-party resource.
- Applied no-store, no-referrer, nosniff, frame denial, and hash-pinned script/style CSP controls to
  phone HTTP responses. Capability failures use one redacted 404 shape.
- Enforced exact canonical Host on every leg and exact same-origin Origin on WSS/POST, including
  duplicate-header rejection and URL default-port normalization.
- Added a dedicated noServer WebSocket handler before `/ws`, bounded to one text frame/256 bytes,
  four sockets, a five-second proof deadline, and sixty-second lifetime. SQLite advances to
  `ws_probed` only after the echo is queued; only POST advances to `phone_confirmed`.
- Bounded confirmation bodies (declared and chunked), fixed their closed JSON schema, limited each
  challenge to five attempts/minute plus a process-wide ceiling, and returned the stored phrase.
- Wired exactly one verifier into `startGateway`, including the sole production
  `beginGatewayBoot()` call, lifecycle cleanup, advertised/public origin handling, and IPv6-safe
  listener origins. Startup and phone confirmation mint no setup code.
- Documented the onboarding exception without changing `/pair` authority and added an optional
  black-box conformance hook so gateways without operator onboarding remain compatible.

## TDD evidence

Initial RED command:

```text
pnpm --filter cozygateway exec vitest run test/phone-verification-http.test.ts test/phone-verification-ws.test.ts test/phone-verification-abuse.test.ts
```

It failed for the expected missing module and missing `beginPhoneVerification` API (three failed
files/four failed tests). Subsequent focused RED runs exposed the missing WS echo transition and
body/session semantics before the corresponding production changes.

Final focused GREEN:

```text
Test Files  6 passed (6)
Tests       54 passed (54)
```

Coverage includes page sequencing/failure short-circuiting, inert methods, CSP/cache/referrer
controls, no pairing material, real-`ws` authority rejection and echo, 256-byte frame enforcement,
four-socket ceiling, replay, declared/chunked body limits, five-attempt admission, startup wiring,
and regression coverage for `/pair` and `/ws`.

## Final verification

```text
pnpm --filter cozygateway exec vitest run test/phone-verification-http.test.ts test/phone-verification-ws.test.ts test/phone-verification-abuse.test.ts test/server.test.ts test/pairing.test.ts test/ws-hub.test.ts
Test Files  6 passed (6), Tests 54 passed (54)

pnpm --filter cozygateway-contract exec vitest run
Test Files 11 passed (11), Tests 123 passed (123)

pnpm --filter cozygateway-conformance exec vitest run
Test Files 2 passed (2), Tests 65 passed, 16 skipped

pnpm --filter cozygateway typecheck
exit 0

pnpm --filter cozygateway-conformance typecheck
exit 0

git diff --check
exit 0 (repository line-ending warnings only)
```

## Self-review

Re-read the authoritative state/protocol sections and checked every capability-bearing path for
reflection or logging. The verifier emits no trace/log field containing the raw capability, catches
storage failures behind the same redacted response/connection close, closes all verification
sockets during Gateway shutdown, and leaves exact `/ws` and `/attach/v1` dispatch authoritative.

## Concern / handoff

The portable conformance check is intentionally gated by the optional operator hook; the existing
reference conformance fixture imports the built package and therefore does not exercise new source
APIs until its normal build step refreshes `dist`. The Gateway's dedicated real-`ws` tests exercise
the full phone protocol directly. Task 6 can call `beginPhoneVerification(mode)` and receives both
`sessionId` and `challengeId` for desktop finalization; the QR payload remains only
`verificationUrl`.

## Review-finding repair (2026-08-28)

All six findings in `task-5-review-findings.md` were addressed test-first.

### Repair RED

```text
pnpm --filter cozygateway exec vitest run test/onboarding-storage.test.ts test/phone-verification-http.test.ts test/phone-verification-abuse.test.ts
Test Files 3 failed (3); Tests 6 failed, 21 passed
```

The expected failures proved: no atomic replacement API, raw-capability map keys, no default-port
normalizer, no emitted-script export/shared workflow, and no second server acknowledgement after
the echo. The two existing real-page tests timed out waiting for that acknowledgement.

### Repair GREEN and behavioral coverage

- Canonical origins now normalize literal HTTP 80 / HTTPS 443, including the listener-derived
  startup origin.
- In-memory lookup is keyed only by SHA-256. The raw capability and verification URL exist only in
  the initial return value and are not retained in verifier records.
- The server echoes with `ws.send(frame, callback)`, advances SQLite only in the successful
  callback, then emits a separate acknowledgement. The emitted page waits for that acknowledgement
  before its single POST.
- Storage now atomically consumes the expired challenge, abandons its session, and inserts the
  same-mode replacement session/challenge under one `BEGIN IMMEDIATE` transaction.
- The shipped inline script embeds and calls the same `runPhoneProof` workflow exercised by the
  browser-like execution test.
- Real HTTP/WSS tests cover missing/duplicate/trailing-dot authority, normalized default ports,
  the 5,000 ms first-frame and 60,000 ms total-lifetime defaults with accelerated behavioral
  clocks, exact 256-byte acceptance, 257-byte rejection, a second client frame, expiry and atomic
  replacement, successful-confirm replay, wrong authority, five attempts attributed per
  challenge, and the sixty-attempt process-global ceiling across live Gateway instances.

Fresh focused verification:

```text
pnpm --filter cozygateway exec vitest run test/phone-verification-http.test.ts test/phone-verification-ws.test.ts test/phone-verification-abuse.test.ts test/server.test.ts test/pairing.test.ts test/ws-hub.test.ts test/onboarding-storage.test.ts
Test Files 7 passed (7); Tests 79 passed (79)

pnpm --filter cozygateway-contract exec vitest run
Test Files 11 passed (11); Tests 123 passed (123)

pnpm --filter cozygateway-conformance exec vitest run
Test Files 2 passed (2); Tests 65 passed, 16 skipped

pnpm --filter cozygateway typecheck
pnpm --filter cozygateway-conformance typecheck
both exit 0

git diff --check
exit 0 (repository line-ending warnings only)
```

### Repair self-review

Re-checked each finding against production code and the design's authoritative state/phone
protocol. Plain GET/HEAD/OPTIONS remain inert; the emitted page has no tap/button or setup code;
Host/Origin checks remain exact; capability failures remain redacted; `/ws`, `/attach/v1`,
`/pair`, and `/auth` dispatch were not changed. The only Task 2 storage extension is the narrowly
scoped atomic expired-verification replacement, with direct transaction regression coverage.

One wording correction to the original report: SQLite now advances after the echo send callback
succeeds, not merely after the echo is queued.

## Second review-finding repair (2026-08-28)

The second review made the documented one-echo wire contract authoritative. The prior repair's
extra acknowledgement and padded probe extension were removed.

### Second repair RED

```text
pnpm --filter cozygateway exec vitest run test/onboarding-storage.test.ts test/phone-verification-http.test.ts test/phone-verification-ws.test.ts test/phone-verification-abuse.test.ts --testTimeout=10000
Test Files 4 failed (4); Tests 5 failed, 34 passed; 3 follow-on errors from the unwanted second frame
```

The failures directly demonstrated that the emitted script still named/waited for the extra ACK,
the server emitted that second frame, a noncanonical padded 256-byte frame was echoed, the storage
replacement ignored its desired CAS identity and required wall expiry, and verifier replacement
failed when only the monotonic deadline expired.

### Second repair GREEN

- WSS now emits exactly one frame: the byte-for-byte canonical echo. SQLite advances to
  `ws_probed` only inside that echo's successful `ws.send(frame, callback)` callback. The browser
  starts its single POST when it receives the echo; no acknowledgement type exists in production.
- The only accepted client frame is exactly `{"type":"cozy_onboarding_probe"}`. Padded/extra-key
  256-byte frames, 257-byte frames, binary frames, and second frames terminate the socket.
- `replaceLocallyExpiredVerification` is a single `BEGIN IMMEDIATE` CAS/replacement transaction
  bound to the prior session ID, challenge ID, capability hash, active/live state, mode, canonical
  origin, posture fingerprint, verification epoch, and boot generation. This lets the verifier's
  authoritative monotonic deadline replace a challenge even if wall time stalls or rolls backward,
  without weakening any other transition.
- Handler-level tests activate verifiers with literal `http://...:80` and `https://...:443`, then
  serve their generated page using browser-normalized Host authority.

### Fresh second-repair final evidence

```text
pnpm --filter cozygateway exec vitest run test/phone-verification-http.test.ts test/phone-verification-ws.test.ts test/phone-verification-abuse.test.ts test/server.test.ts test/pairing.test.ts test/ws-hub.test.ts test/onboarding-storage.test.ts
Test Files 7 passed (7); Tests 82 passed (82)

pnpm --filter cozygateway-contract exec vitest run
Test Files 11 passed (11); Tests 123 passed (123)

pnpm --filter cozygateway-conformance exec vitest run
Test Files 2 passed (2); Tests 65 passed, 16 skipped

pnpm --filter cozygateway typecheck
pnpm --filter cozygateway-conformance typecheck
both exit 0

git diff --check
exit 0 (repository line-ending warnings only)
```

The first full Gateway gate attempt encountered a Vitest worker `ERR_IPC_CHANNEL_CLOSED` without a
test assertion failure. Re-running the identical command completed with the 82/82 result above;
no product or test change was made in response to the transient worker failure.

### Second repair self-review

Searched production for the removed ACK and padded-schema extension: neither remains. Re-read the
send path to confirm storage is called only from the echo callback, and the page's emitted workflow
resolves its probe on that sole echo before POST. The local-expiry CAS matches every prior authority
coordinate before consuming/abandoning and inserting the same-mode replacement atomically. Plain
fetch methods, capability redaction/hash-only retention, resource limits, process-wide admission,
and `/ws`, `/attach/v1`, `/pair`, and `/auth` routing remain unchanged.
