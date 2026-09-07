# Changelog

CozyGateway is pre-1.0. Each minor series below groups the tags that shipped it; patch tags within
a series are fixes to the series' own changes. Per-tag notes live on the
[releases page](https://github.com/shiftedx/cozygateway/releases). Only the newest tag is a full
release; everything older is marked pre-release so installers resolve one "latest".

## Unreleased

- Adds the paired, read-only Observe dashboard with local fonts, strict same-origin CSP, live
  refresh, sparse measurement states, and light/dark layouts. Its assets are embedded in the
  standalone gateway bundle.

- Capability 74 adds CozyAgents observation snapshots: latest bot internals, per-step throughput,
  lifetime usage, and attributed tool costs. Unknown models show tokens only; the dated Claude
  list-price sheet and local zero rates can be overridden in `observability.prices`. Unknown
  capability names on attach hello are ignored so additive lanes can negotiate safely.

- Add the paired observer read API and bounded live subscriptions (capability 75). Dashboard
  responses report sample counts and content-free updates; observers never receive chat text,
  task goals or roster previews. Existing write-scoped app connections keep their frames.

- Dashboard observation now records the remaining lifecycle events for every gateway-backed bot:
  device pairing and revocation, approvals and repair proposals, runtime stages, runner contact,
  and accepted maintenance operations. Capability 73's receipt amendment separates radio from VPN
  state, adds wired and other radios, and accepts the app's Cloudflare edge round trip and validated
  colo code on both a receipt and websocket auth. This amends row 73 without a new capability version.

- A fast bot reply and the completion of its same Task no longer raise two push banners
  (`com.cozylabs.bots` capability 76, F23). A targeted reply push now carries its optional
  `taskId`, resolved from the newest durable run for that session, and records a synchronous
  durable marker before the relay send yields. The queued completion callback consults that marker
  and skips only the same Task for ten seconds. The marker survives a gateway restart, is not
  written when all registered devices are already live, and cannot suppress a different Task.

- A group room's approval now carries its scoped-approval block, so a room ask can be answered
  with the same scoped decision a 1:1 chat gets (`com.cozylabs.bots` capability 66, F4). The room
  approval handler validated capability 56's `detail` and capability 62's `repair` and silently
  dropped capability 66's `scope`, so a covered ask raised on a room turn reached the app as a
  plain approval: no category, no change sentence, no standing grant to make or revoke. The block
  is now sanitized once on ingest exactly as the 1:1 lane does, dropped on failure while the
  approval is kept, and carried byte for byte on the room's `bot_approval_pending` frame, the
  durable interaction record, the expiry payload, the `GET /bots/approvals` inbox row and the
  rebroadcast a reconnecting app gets. Nothing else moved: a room approval was already the same
  durable row the 1:1 lane writes, so the decision routes, the optional decision body, the grant
  rules, the always-require refusals and the grants view and its `DELETE` already answered for a
  room approval. The consult moved with it: a room ask is checked against the standing grants before
  its card goes out, names the `grantId` that covers it on the frame and the record, and is settled
  through the same `resolve_approval` relay a tapped card sends, reaching the 1:1 lane's own consult
  rather than a second copy of it, so the plain-ask derivation, the single-use rules and the
  always-require exclusion cannot drift between a room and a chat. Additive, so a peer that sends no block and a client
  below 66 are byte identical to their pre-66 selves, and a Hermes-raised room approval keeps
  rendering the plain card.
- The attach plugin can send a scope block with an approval it raises (F4). `send_approval` gained
  an optional `scope` parameter, and the plugin classifies a Hermes tool call into capability 66's
  closed category set from the tool name and the arguments it already reads for the capability-56
  detail sentence, so a Hermes-raised approval, in a room or a 1:1 chat, can now carry the block
  the app needs to offer scoped controls. Omitted when the gateway did not advertise
  `com.cozylabs.bots >= 66` and when the call cannot be classified, so the plain deny-only card
  stays exactly what it was. An action the classifier cannot place emits NO block rather than
  declaring `other`: `other` is the one category a standing category grant can cover, so answering
  it for an unplaced call would unlock exactly the grant row 66 withholds from a plain ask, and
  `terminal:rm` places where `terminal:rmdir` and `bank:wire` do not. The `change` sentence is
  COMPOSED from the action and the resource rather than copied from the harness description, which
  on the answerable surface carries the call's arguments and absolute paths; an action identity
  carrying a URL, a path, whitespace or an assignment is refused outright, since the identity is the
  only thing that reaches a wire string. Every block it does send declares `resourceKind: "action"`,
  the new optional member of `BotApprovalScope`: the resource is the operation, never the object the
  operation would touch, because the object lives in the call's arguments and row 66 forbids one on
  this wire. A category grant covers any payload of that action on that resource, so over such a
  block it would cover every object that tool can reach; `grant: "category"` on one is now
  `409 approval_category_undeclared` at the decision AND at the consult, so a category grant another
  peer made against a real object of the same name cannot answer for one either. `grant: "once"` is
  unaffected and is the whole offer there, bound to the payload hash. Absent reads as `object`, so
  every peer and client that names a real resource is byte identical to its earlier self, and the
  always-require floor is untouched and still refuses first.
- An observer device, so a dashboard can watch a gateway and never act on it (`com.cozylabs.bots`
  capability 72, D1). `cozygateway pair --kind observer` mints a setup code that only an observer
  pair can spend, `POST /observers/pair-code` mints one from CozyChat's device list the way
  `POST /runners/pair-code` already mints a runner code and spends the same bucket and TTL, and
  `POST /pair { kind: "observer" }` consumes one and mints a device token whose scope is `read`,
  and that token is refused `403 scope_read_only` by every write route this gateway serves. The
  refusal lives in ONE middleware that runs before every route handler rather than in a check each
  route remembers to make, so a write route added later is refused by
  construction: the test that proves it walks the router itself, all 99 write routes of a fully
  wired gateway, instead of a hand written list. The check admits `write` and refuses everything
  else, so it fails closed on a scope value a given build has never heard of.
  An observer can pair nothing, including a replacement for itself: `POST /pair` is a write, so a
  request presenting a read-scoped bearer is refused and the setup code it carried is not spent,
  which means a client re-pairing after its token went stale clears the stored token first.
  The app websocket is held to the same rule, refusing every command frame from a read-scoped
  socket with an `error` frame carrying `code: "scope_read_only"` while `sync` still works, so an
  observer can never advertise itself as a phone capability node. An observer appears on
  `GET /devices` with its `kind` and `scope` beside its name, and `DELETE /devices/:id` deletes it
  and closes its socket exactly as it does for any device. A read token is a FULL READ of
  everything a person said to their bots, so a leaked observer token is a leaked transcript
  archive even though it can never act; the credential-bearing reads are already redacted at the
  schema, so it is not a path to a provider key. Every device paired before this change
  reads back as `scope: "write"` and is refused nothing: the migration that added the column
  defaults it, so no shipped credential is silently downgraded to read-only. Additive for every
  client and every peer of every backend, Hermes-backed and CozyAgents-backed alike, with zero
  plugin changes.

- Observation ring: the gateway keeps what it already measures, for a week (dashboard packet D2).
  Every latency, depth and outcome the gateway computes on a turn, a heartbeat or a sweep was
  thrown away the instant it was used, so nothing could be charted, trended or compared, and the
  first question anybody asks about a slow reply ("which hop?") had no answer anywhere in the
  system. Two capped SQLite tables now hold it: `observe_series (series, bot, at, value)` and
  `observe_events (at, kind, bot, ref, detail_json)`, both trimmed to
  `observability.retentionDays` (7 by default) by a periodic pass that starts and stops with the
  process. The same pass ages out the replay ledger behind the lifetime token counters, which is the
  one table here that would otherwise grow by a row per snapshot forever; a snapshot older than the
  window is refused on its age instead, so trimming a claim cannot reopen the double count it was
  preventing. Written from the hooks that already fire: the app websocket heartbeat's ping-to-pong per
  device tagged `tunnel` or `lan` from the request's origin, the attach heartbeat's request-to-ack
  per peer, turn admission to dispatch and terminal to broadcast, first delta, turn duration, delta
  frame count, attach online, queue, dead letter and outbox depths, dead letters, push relay
  outcomes, and a self-probe that asks its own public hostname for `/ready` every 30 seconds and
  compares it with the same request over loopback, recording the difference and raising a
  `tunnel_flap` on a 502 or a timeout. OFF BY DEFAULT: `observability.enabled` is false unless an
  operator sets it, and off means no writer fires, no timing state is kept, and both tables stay
  empty. Three rules run through it. ONE CLOCK: every duration is a difference of two monotonic
  readings taken by this process, never two wall clocks and never two machines. MEASURED, NOT
  DERIVED: a hop the gateway cannot time is absent rather than inferred and stored beside the ones
  it did time, and the only subtraction anywhere is the tunnel leg, where both terms are this
  process's own measurements seconds apart. COUNTS TRAVEL WITH AGGREGATES: the p50 and p95 helpers
  always return the sample count beside them, because a p95 over four samples is not a p95.
  PRIVACY, enforced at the writer rather than at the call sites, AS AN ALLOWLIST WITH NO FREE
  STRING IN IT: every column is a name from a closed enum, a 16 hex keyed identity hash, a number,
  or, inside `detail_json`, a number, a boolean, a hash or a code from that field's own closed set
  under a per-kind schema that refuses an unknown key outright. No identifier reaches a row: a bot,
  device, agent, turn or grant id is hashed with a per-gateway key kept in that gateway's own
  database, so the same subject hashes the same way across restarts, differently on somebody else's
  gateway, and never appears as itself. A shape test cannot tell a person's words from a reason
  code, which is why nothing here tries: a caller that wants a word declares it in an enum, and a
  caller that wants an identifier stores its hash. A refused row is dropped whole and counted rather
  than scrubbed in part. Peer-type-agnostic: every writer reads
  something the gateway already computes for any attached peer, so a Hermes-backed bot gets the
  full ring with no plugin change and no Hermes fork; the only gaps are the two series the design
  marks CozyAgents-snapshot-only, which are left as a documented fold-in seam rather than inferred.

- Capability 73, the perceived latency the gateway cannot measure. The one figure that matters most
  is the one nobody in this system could see: what the person actually waited, from the send being
  tapped to the first delta appearing. The gateway sees an admission and a frame leaving, not a
  thumb and a pixel, and it cannot see a VPN at all. `POST /bots/:name/chat/messages/displayed`
  therefore gains two optional fields, `feltLatencyMs` and `networkPath` (`wifi`, `cellular`,
  `vpn_on`, `vpn_off`), both measured on the phone, both stored nullable on the receipt row that
  call already writes, and at most one recorded per request whatever the batch size. Neither is
  ever added to or subtracted from a gateway-measured hop: two clocks that were never synchronised
  cannot be differenced, so the perceived figure sits beside the measured ones, and the cost of a
  VPN is stated as the difference of two medians for the same device with it on and off, each with
  its own sample count. Additive: no new route, no new frame, nothing a peer of any backend can
  read or write, and a client below 73 sends neither field and is byte identical to its pre-73
  self.

- The owner-loss lease no longer reaps a turn whose peer was lost mid model request
  (`com.cozylabs.bots` capability 69, F2). Capability 69 starts a 120 second lease the instant a
  peer's socket closes, and for a peer that was answering heartbeats right up to that instant,
  silence is the wrong reading: it was working, its model had not returned a token yet, and the
  drop is what a peer blocked inside one long synchronous prefill looks like from the gateway. LV1
  measured a cold 45k token window at about 123 seconds against that 120 second lease, and LV2
  measured 8 seconds for the same window on another endpoint from the same code, so no lease number
  tells a slow model call apart from a dead process. Such a turn now waits one model request out,
  4 minutes, before the lease clock starts, which is time excluded the way a pending approval or
  device request already suspends it. The lease itself is unchanged, the exclusion applies once and
  only to a disconnected peer that was demonstrably alive when it went, and a peer that never comes
  back is still reaped, about 6 minutes after the drop and never past a ceiling an operator
  shortened. That total is shorter than the 10 minute grace an attached quiet peer already gets, so
  no window on this path is longer than one the gateway already grants: the undeclared grace, the
  interrupt grace and the 30 minute silence ceiling are untouched, and a heartbeat never stretches
  the undeclared grace. Derived gateway side from the delivery record and the transport, so it
  needs no new frame, field or peer behavior and covers a Hermes peer and a CozyAgents peer
  identically with no plugin change.

- Portable conformance suite, Hermes-free (F9): the black-box suite in
  `packages/conformance/src/suite.ts` assumed a Hermes endpoint existed, so it failed against a
  Hermes-free reference gateway for reasons that had nothing to do with rooms. Fixes: (1)
  `GatewayInfo.bridges`' value type now accepts either the `BridgeLiveness` object or the literal
  string `"absent"` (`contract/v1.md`'s core definition now says so too, not only the vendor
  extension), matching the gateway's own already-documented Hermes-free `/health` and `/ready`
  shape instead of rejecting it; (2) a runtime bot (`bots` config, capability 45, or one created
  later through `POST /bots`, capability 49) is now registered into the same turn-adapter/router
  map a Hermes profile already uses, so a plain 1:1 `/threads` conversation against a runtime bot
  works instead of every send answering 503 `backend_unavailable`, including one created after
  boot without a gateway restart. One side effect of (2): `GET /agents`'s `presence` for a
  boot-time runtime bot now reads its real attach connection state (`online`/`absent`) instead of
  always reporting `unknown`. A related shutdown fix: the durable-vs-abandon decision on gateway
  close now reads every currently registered attach identity, Hermes profile or runtime bot
  (including one registered after boot), not a boot-time snapshot, so a Hermes-free gateway with
  an in-flight runtime bot turn no longer deadlocks on close; covered by its own test rather than
  only an incidental `afterAll` timeout. New third in-repo runner,
  `packages/conformance/test/reference-gateway-hermes-free.test.ts`, runs the full portable suite
  against a Hermes-free reference gateway; the two existing Hermes-attached runners are unchanged
  and stay green. The phone capability request lifecycle group (capability 68) is not enabled for
  this shape: `com.cozylabs.mobile-node` is a Hermes-Dashboard phone bridge capability a
  Hermes-free gateway correctly never advertises, not a suite gap.

- Choosing which phone a capability request reaches, and one composer draft that follows the person
  (`com.cozylabs.bots` capabilities 70 and 71, F3). Capability 70 adds
  `GET`/`PUT /bots/:name/mobile-requests/preferred-device?sessionId=`, read at admission and nowhere
  else. Which of a person's phones rings is the PERSON'S choice: the preference is written by a
  device-authenticated client, no frame carries a target device, and a `mobile_request` that
  includes `targetDeviceId` anyway has that one request refused with capability 68's own
  `policy_blocked` and `request_policy_rejected`, while the socket and everything queued on it
  survive, because a stale peer must not lose a live conversation over one removed routing hint. The
  target is the conversation's stored choice when it still names a paired device, then the device
  that opened the turn; from that moment capability 68's binding is unchanged, so the target never
  moves and a second device attaching never becomes one. One stated exception: a CozyApp action is
  answered on the device that tapped it and consults no preference, because a tap's answer belongs
  on the screen that took it. A read or write naming a bot this gateway does not hold is
  `404 not_found` rather than a `200` echoing something that was never stored.
  Capability 71 adds `GET`/`PUT /bots/:name/drafts?sessionId=`
  and the `bot_draft_updated` frame: one draft per profile and conversation, per person and never
  per device, last write wins, the empty string is the clear a send writes immediately, and that
  clear crosses devices, so a message sent on one phone can never still be offered on another. A
  draft reaches no bot, peer, runtime or model, and its text is never logged, traced or measured;
  the row does make an unsent draft durable server state, dropped with its conversation's history
  and swept on the gateway's own periodic retention pass thirty days after it was last touched, so
  an idle gateway forgets on the same schedule as a busy one. `updatedAt` moves strictly forward on
  every stored change, so it is the version a client orders two drafts by and a slow write can
  never put a sent message back on another phone. A client may now declare `com.cozylabs.bots` on
  the `auth` frame; one declaring a version below 71 is not sent `bot_draft_updated` at all. Both rows are additive: EVERY peer of every backend is
  byte identical to its pre-70 self, no frame gains a field, and a client that writes neither a
  preference nor a draft behaves exactly as it did before. The attach plugin is unchanged in
  behavior and Hermes needs no agent change.

- Rooms on a gateway with two or more Hermes endpoints (`com.cozylabs.bots` capabilities 46 and 52,
  F8): such a gateway refused every room, including one whose members all lived on a single
  endpoint. A room is now hosted by the one host its membership resolves to. Every member on one
  endpoint means that endpoint's own rooms host it, created and run exactly as on a single-endpoint
  gateway; every member a gateway runtime bot means the gateway's own host, the one added for the
  Hermes-free shape; a membership spanning two endpoints still has no host and is still refused
  `503 backend_unavailable`, "cross-endpoint groups are not supported". A room stays on the host it
  was created on: ownership is resolved once and remembered, and a membership that comes to name a
  bot on another endpoint is refused by name rather than migrated. A single un-namespaced endpoint
  is untouched. No route, frame, schema or version moved, and Hermes needs no plugin change: an
  endpoint hosting a room sees the attach-v1 traffic it already handles today.

- Hermes DM streaming cadence (F16): the installer and both provisioner scripts now seed
  `streaming.edit_interval: 0.05` and `streaming.buffer_threshold: 1` alongside the two `display`
  streaming switches, and repair a profile that carries the switches but not the cadence. Hermes'
  own defaults there are 0.8 seconds and 24 codepoints, which held the head of every reply back
  and is the debounce a phone sees as a stalled bubble. Those two keys are profile-wide with no
  per-platform override, so they are seeded only when cozygateway is the one chat platform the
  profile serves: a profile carrying a Telegram, Discord, Slack, WhatsApp or QQ token, or another
  `kind: platform` plugin, keeps the cadence its operator set and is told so, while the
  per-platform `display` switches are seeded either way. The two cadence keys are also seeded only
  together, since they are one setting read as a disjunction and a threshold of 1 beside a tuned
  edit interval would make that interval unreachable. The shared reader now answers `key=value`
  per line so each key is written with its own value, and it still writes nothing where it cannot
  judge a config file. The attach plugin also declares Hermes' native-streaming extension point
  (`SUPPORTS_NATIVE_STREAMING`, `supports_native_streaming`, `send_stream_frame`), off unless
  `COZYGATEWAY_NATIVE_STREAMING` asks for it and not to be turned on before a live approval and
  clarify soak. The attribute is set on the concrete adapter class from that same switch, because
  Hermes reads it without the probe when delivering an `/approve` or `/deny` confirmation, so with
  the switch off the adapter is what it was before this transport existed on every path: interim frames are the same drafts, a finalize frame
  goes through the existing terminal send, and the wire the app reads is unchanged
  (`bot_chat_delta`). No Hermes source is changed by any of it.

## 0.7.6 (2026-09-06): rooms without a Hermes endpoint, installer fixes

- Rooms on a gateway with no `hermesEndpoints` entry (`com.cozylabs.bots` capabilities 46 and 52,
  #380): a gateway with zero Hermes endpoints now owns its rooms end to end: create, list, detail,
  member turns on the gateway-owned `group:<room>:<member>` thread, room-scoped Tasks, room
  approvals and delete. Bridge selection on a gateway that has a Hermes endpoint is untouched; the
  room host is built only when there are no bridge members. The contract now states exactly which
  gateway shapes host a room: two or more endpoints, or a single `namespace: true` endpoint, still
  refuse every room with 503. New conformance file for the Hermes-free shape.

- Installer and provisioner scripts no longer require host PyYAML to read a profile's streaming
  keys (#381): one reader with two modes shared verbatim by `scripts/agent-install.sh`,
  `scripts/provision-bot.sh` and `scripts/bot-provisioner-watch.sh` (PyYAML when the interpreter has
  it, Hermes' own venv python tried first; otherwise a conservative stdlib probe that reports a key
  present whenever it cannot judge, so an unsure host writes nothing and restarts nothing; a key
  whose value is a nested mapping counts as present). The reader answers in UTF-8 bytes and callers
  strip a carriage return, so a Windows interpreter no longer corrupts key names. `scripts/install.sh`
  bootstrap recognizes Git Bash as the `Windows` service platform with an empty registration path
  and no-op restart and removal, instead of dying on an unsupported platform. The two dev-box
  provisioner scripts still need PyYAML for their pre-existing `plugins.enabled` read.

## 0.7.5 (2026-09-06): durable Tasks and Artifacts, scoped approvals, dashboard records

- An approval can propose an MCP repair (`com.cozylabs.bots` capability 62, #366): `ApprovalEvent`
  on attach-v1 gains optional typed `repair`, validated by the gateway and dropped (never the
  approval) when malformed, then carried on `bot_approval_pending`, the `GET /bots/approvals` inbox
  row, and the rebroadcast a reconnecting app gets. Approve and deny are unchanged. The conformance
  suite gains an optional repair hook that proves all three outcomes against the reference gateway.

- The per-server MCP repair policy is declared before it is emitted (`com.cozylabs.bots` capability
  63): `BotMcpServer` gains optional `repair`, closed to `approve_once` or `auto_refresh`, carried
  on the existing capability-48 `bot_config` `profile.read`. It is read-only metadata the gateway
  relays and never stores, writes, or executes; the profile patch has no shape for it. An absent
  wire field is unprojected or unknown, and the gateway leaves it absent. A known CozyAgents peer
  may project its effective `approve_once` default after negotiating 63, which still requires an
  approval rather than granting repair permission. An unknown value follows the lane's existing
  convention: the `config_result` frame is refused and the read is unavailable.

- Durable gateway Tasks (`com.cozylabs.bots` capability 64, #369): a Task is a gateway-owned record
  with ten states, the 45 enumerated ADR 0004 reasons, append-only transitions and accepted intents,
  and full-replace `bot_task_updated` frames. The existing attach turn identity becomes the Run
  identity, so a producer names its Run without a new frame. Tasks survive a gateway restart, a
  paused Task stays paused through recovery, and a resumed Task is fenced by live ownership and its
  declared references rather than reclaimed by whoever attaches next.

- Durable Artifacts and independent delivery (`com.cozylabs.bots` capability 65): a declared Task
  output becomes a gateway-owned record with a stable identity, provenance to its Bot, producing
  peer, session, Task and Run, and byte evidence. Commitment recomputes the SHA-256 and byte count
  over the bytes the existing attach media route already stored, so metadata alone commits nothing
  and a mismatch, absent bytes or an exceeded `artifactStoreBytes` ceiling is recorded visibly.
  Originals are retained until an explicit deletion, which leaves a truthful tombstone while the
  bytes stop being reachable. Delivery is a separate object with its own identity and retries, so a
  failed delivery leaves a completed Task completed. Capability 65 is also the canonical Artifact
  commitment producer capability 64 declared and left absent.

- Artifacts are joined to their Task by the gateway, from the Run the producer named
  (`com.cozylabs.bots` row 65, additive). A Task id is minted gateway-side and no attach-v1 frame
  ever carried it to a peer, so a producer could not state one and its Artifact never reached the
  Task's reference set. It no longer has to: capability 64 already made the existing attach turn
  identity the Run identity, so a declaration names its session and its Run and the gateway
  resolves the owning Task itself, at declaration and again at commitment when the Run only became
  mappable later. A join is recorded only when the Run belongs to the authenticated peer, its Task
  belongs to the same Bot the record is filed under, and the session is the Run's own, so a
  wrong-bot Run cannot join another bot's Task. A Run this gateway cannot map leaves `taskId` off
  the record while keeping the stated `runId`, which reads as absent Task provenance rather than a
  guess, and a `taskId` a peer sends is dropped in favor of the gateway's own join. A joined
  record keeps its Task `verifying` until it commits and appears in the Task view's artifacts.
  Waiting on one is bounded: a required Artifact that reaches a terminal state without committing
  releases the Task into `blocked` with a truthful reason, `artifact_commit_failed` for a refused
  commitment and `verification_failed` for a record deleted before it ever committed, and a
  required Artifact that is still only declared when its Run's execution has ended settles the Task
  `failed` with `verification_failed` after the provisional 120 second lease. A Task is never
  sealed `completed` on a missing artifact, and a record deleted after it committed does not reopen
  its Task. A commit that upgrades a record the gateway derived for the same bytes now carries the
  Task's requirement across the identity swap, so a successful commitment cannot strand the Task on
  an identity that no longer resolves.

- An Artifact `mark` a producer never stated stays unstated (`com.cozylabs.bots` row 65,
  additive). `mark` is now optional on a declaration and on a record: its three values are the
  three things a producer can say, and absence is "did not say", never a default of `draft`. A
  client renders no mark. Peers and clients below 65 are byte identical, and a peer that still
  sends a mark is stored exactly as before.

- Typed scoped approvals (`com.cozylabs.bots` capability 66): an approval may carry one validated
  block naming the action, its category, the target system and resource, the exact material change,
  the side effects, why a decision is required, the sha256 hash of the exact payload, the
  expiration, whether a retry is idempotent, and the scope the peer asked for. A decision may leave
  a standing grant, and only where the person explicitly asks for one: a plain approve is one
  decision on one ask and leaves no policy behind. A grant is bound to profile, user, conversation,
  task, target, payload hash and expiration: `once` covers at most one later ask with that payload
  on that task, only while the retry is idempotent, and dies with the ask or ten minutes from the
  decision, whichever is sooner; `category` covers any payload of that action on that resource
  until it expires or is revoked. A
  grant is a policy record a later invocation is consulted against, never a replay: a changed
  material field changes the hash and forces a fresh decision, and an expired grant is dead
  whatever its scope says. Money movement, secret access or disclosure, destructive actions, locks
  and alarms, public publishing and broad account changes require a decision on every invocation
  and can be covered by no grant. `GET /bots/:name/approvals/grants` is the revocation view and
  `DELETE /bots/:name/approvals/grants/:grantId` ends one immediately; the view is the same bounded
  window the gateway consults, so no grant can answer for a person without being visible to them.
  The gateway relays and validates: a covered ask still raises its card, names the grant on the
  frame, the reconnect rebroadcast and the inbox row, and settles through the same
  `resolve_approval` a tapped card sends, and a person can still deny that one ask or revoke the
  grant. A plain approval from a peer that sends no block is bound too, from its rule name and its
  capability-56 sentence, so a person can cover a later identical one with a single-use grant; a
  plain ask carrying neither is never covered, and a category grant never covers one at all, because
  a plain ask declares no category for the always-require exclusion to read. Such a peer needs no change and its approvals render and settle exactly as
  before. `category` is the peer's own assertion: classifying an action into the always-require list
  belongs to the harness that raises it. An approval with no block and a decision with no body are
  byte identical to their pre-66 selves.

- Typed phone capability request lifecycle and Task completion push (`com.cozylabs.bots` capability
  68, #374): every phone capability request carries one typed state and ends in exactly one typed
  terminal state, bound to the profile, the conversation, the turn and the one paired device it was
  issued for. `policy_blocked` and `foreground_required` are outcomes of their own rather than a
  generic failure, and `GET /bots/:name/mobile-requests?sessionId=` is the reconciliation read. A
  backgrounded phone learns a Task finished: the `task_completed` payload carries the identities the
  deep link needs and no user content, sent once per Task on the transition that writes capability
  64's completion notification record, and never to a device that already has the frame over a live
  socket. A phone at `com.cozylabs.mobile-node` 6 may report one non-terminal stage of a request it
  holds, which advances the lifecycle and stops the reconnect resend, so one consent cannot become
  two prompts. A phone below 6 sends none and behaves exactly as before.

- A reply is never lost to a turn nobody owns (`com.cozylabs.bots` capability 69, HF2, #377). The
  gateway side is the floor, so it protects users of a peer that never sends a new field. Attach-v1
  `hello` gains optional `activeTurns` (turn ids only) and `failed` gains the closed optional
  `reason: "unknown_turn"`. On hello the gateway reconciles this profile's nonterminal native turns,
  and only the turns the peer already acknowledged: a command still in the durable outbox is one the
  peer has never seen, so its absence says nothing, and a message queued for a sleeping bot is
  delivered normally. A turn the peer declared active keeps the long silence ceiling; one it did not
  name, when it declared at all, is sealed immediately for owner loss instead of after twenty
  minutes, and the app learns through the existing `bot_chat_state` transition with no new frame,
  field or status value. A disconnected peer's turn runs on ADR 0004's provisional 120 second
  owner-loss lease; a peer that re-attached but could not declare gets a 10 minute grace, because
  reaping an attached peer inside one long model call would end live work. A steer left unanswered
  on a turn that turns out to be terminal, reaped, or answered `unknown_turn` is promoted to a new
  durable turn carrying the same text, media and chat context, with the following steers
  re-dispatched in order; pending steers are durable across a restart, every undelivered text leaves
  a visible marked failed-delivery row, and each steer is accounted for exactly once. An orphaned
  commit carrying user-facing text or media on a turn id this gateway never issued is projected as
  an ordinary reply bound to no turn and settles the open steers on that conversation, because the
  peer demonstrably heard the person. `activeTurns` is sanitized the way capability 56's `detail`
  is: a malformed declaration degrades to "cannot declare" and is never truncated and never a reason
  to close the socket. Additive: a peer that sends neither field, and every client, are byte
  identical to their pre-69 selves.

- CozyApps dashboard records (`com.cozylabs.cozyapps` capability 2, cross-referenced as
  `com.cozylabs.bots` row 67): three durable record kinds beside the v1 library. A saved editable
  input value is typed to product field types only, carries its own revision, and is written by the
  user route and by no bot: a stale write answers `409 conflict` with the current value, and
  replaying an idempotency key returns the prior result without a second write. An action receipt
  presents the four public names `queued`, `running`, `completed` and `failed`, derived from the
  unchanged internal states rather than a parallel table, and can be bound to the app revision and
  the value revisions the tap was made against. Its source-attributed data snapshot, naming source,
  as-of, value and freshness, is written by the bot over attach and by nothing else: HTTP
  acceptance and model output are never a completed action. A small versioned envelope carries a
  bounded typed document of sections of closed component kinds with semantic references and labels,
  and no colour, font, coordinate, HTML, script, URL scheme, permission or executable tool is
  representable in it; the gateway validates structure and bounds and never interprets the
  document. The bot-side half is gated on a new attach-v1 `cozyapps_dashboard` capability beside
  the flat `cozyapps` literal, so a peer that stays at cozyapps 1, which is every Hermes plugin
  today, keeps v1 behavior byte for byte and still gets derived `queued` and `running` receipts and
  user-written saved values. Bot deletion purges the new records with the app.

- Artifacts for peers that never declare one (`com.cozylabs.bots` capability 65, additive): an
  attachment a peer delivers without declaring an Artifact now gets exactly one gateway-derived
  record over the same stored bytes, so a Hermes bot's files are discoverable, downloadable,
  deletable and retained with no change to the peer. A record carries a closed `origin`
  (`declared` or `derived`, optional on the wire and read as `declared` when absent); a derived one
  names its `sourceMessageId` and omits `sha256`, `mark`, `taskId` and `runId`, because nothing was
  declared. A capable peer declaring the same media upgrades the existing record in place instead
  of duplicating it, and the operator's retained-bytes ceiling now counts each stored object once.
  Operators: retention changes for attachments that used to expire. A delivered attachment's bytes
  are now kept until the Artifact is explicitly deleted, where before a producer's staging deadline
  reclaimed them, so a chatty bot's files accumulate instead of self-pruning. The store is bounded
  by `artifactStoreBytes` in the gateway config, which now defaults to 2 GiB instead of no ceiling;
  over the ceiling the record is written `commit_failed` with `failureReason: "capacity"` and binds
  no bytes, so the refusal is visible and the attachment keeps the retention it already had.

- Hermes attach plugin: one session key, and a typed failure instead of silence (HF1, #376). The
  plugin stamped its loader-owned profile on the synthetic inbound source, so the adapter seam
  derived a profile-namespaced session key while the runner seam and the recorded desktop binding
  stayed on the shared lane, and every turn on a thread with a resumed desktop-session binding was
  dropped at the adapter check. The source is no longer stamped, a binding is recorded with the
  adapter seam Hermes itself uses at dispatch, and the pre-dispatch check now runs Hermes' own two
  strict checks on the frame about to be dispatched, so a `/new`, a compaction retip or an eviction
  is reported at once rather than stranding the turn; only a proven mismatch refuses. A turn this
  process can no longer bind is refused with a typed failed terminal, and a steer or interrupt for a
  turn id it does not hold is answered `unknown_turn` on that turn id instead of being injected as a
  fresh inbound whose events the gateway declines as orphaned. An interrupt for a turn this process
  ran and already sealed lost a harmless race and stays quiet. The plugin declares `activeTurns` on
  every hello, including an empty array, and attaches the closed `unknown_turn` reason only when the
  gateway advertised `com.cozylabs.bots` at 69 or later.

- Bots created from the phone stream their reply as they write it (ST1, #378). Hermes only asks the
  runner for stream deltas when the profile says so (`StreamingConfig.enabled` is false by default
  and the turn resolves `display.platforms.<platform>.streaming`), and a profile the gateway created
  named neither key, so every phone-created bot went quiet for the length of a turn and then
  delivered one finished message. The create-time seed now writes `display.streaming: true` and
  `display.platforms.cozygateway.streaming: true` beside the plugin binding, and profiles created
  before it did are repaired in place: an installer rerun, and the bot provisioner sweep, write
  whichever of the two keys is absent through Hermes' own `config set` and restart that profile's
  gateway exactly once. Only an absent key is written, so a bot an operator set to `false` stays
  quiet; `docs/agent-install.md` says how to turn the default off. No Hermes change and no wire
  change: the attach plugin already answers `supports_draft_streaming` for every chat type, so the
  `draft` frames it now has to send are the ones the app already renders.

- Windows installation offers Hermes, CozyAgents, or both on one gateway, preserves the other
  harness when adding one later, and keeps saved model settings and pairing during repair.

- Gateway tasks and background children use hidden launchers. Windows upgrade recovery recognizes
  older supervisors and restores task ownership before replacing its launcher files.

- Hermes readiness is checked separately from native runtime bots so a combined installation can
  finish without miscounting its profiles.

### Deployment notes

- Existing Hermes profiles get HF1 and the streaming default only when the bot provisioner is
  restaged (`bash scripts/install-bot-provisioner.sh`). The restage restarts each profile's gateway
  exactly once; the app already tolerates that.
- `artifactStoreBytes` now defaults to 2 GiB where it previously had no ceiling. Over the ceiling a
  record is written `commit_failed` with `failureReason: "capacity"` and binds no bytes, so the
  refusal is visible.
- A delivered attachment's bytes are now retained until its Artifact is explicitly deleted, where a
  producer's staging deadline used to reclaim them. A chatty bot's files accumulate instead of
  self-pruning; watch the store against the new ceiling.

### Known limits

- A gateway with no Hermes endpoint cannot own rooms: rooms still require one, so a CozyAgents-only
  gateway is a regression against capability 46 with 52 and is tracked as a follow-on.
- Live qualification against the shared `.121` endpoint is UNKNOWN. Everything live in this release
  was qualified against a local mtplx server and scratch gateways.
- Hosted CI is unavailable, so build, typecheck, test and installer qualification for this release
  were all run locally under Node 24.

## 0.7 (2026-09-04 to 2026-09-05): runners, durability, and the phone-created bot fix

- **v0.7.4** Bots created from CozyChat on a native install become ready on their own (#353);
  interrupted installs recover and updates preserve existing state (#347, #348); Windows Node
  identity and Hermes startup (#352); runner hello acknowledgement (#346); public readiness
  hardening (#340).
- **v0.7.3** Transactional install, update, and repair with persisted maintenance status (#335).
  v0.7.1 and v0.7.2 shipped no merged PRs of their own.
- **v0.7.0** Paired runners and the CozyAgents harness (capabilities 52 to 58): runner pairing and
  roster, a create picks a computer, routine run-now, runner rename, approval detail sentences,
  per-bot guardrail level and operator ceiling; the all-in-one installer with a harness choice
  (#326 to #334).

## 0.6 (2026-09-01 to 2026-09-02): runtime bots

- **v0.6.5** Runtime bots in rooms, auditable ids, config lane, runner lane, history lane, room
  turn cards (capabilities 46 to 51) (#314 to #323).
- **v0.6.4** Config-declared runtime bots with no Hermes profile (capability 45) (#311); the
  locked-down maintenance sidecar (#313).
- **v0.6.0 to v0.6.3** The latest Hermes session is canonical (#306); CozyApps production
  reliability and strict-client detail responses (#308, #310); explicit pairing issuance on
  upgrades (#309).

## 0.5 (2026-08-31 to 2026-09-01): Hermes operator parity

- Operator parity with the Hermes dashboard (#283), a self-repairing and unobtrusive gateway
  (#298), global skill controls (#299), agent and interactive session sync (#301), plugin staging
  order (#302), and resume cursors that survive restarts (#303, #304). v0.5.4 and v0.5.5 fix
  installer restart stability and cold Linux Dashboard startup (#293, #296); v0.5.1 to v0.5.3
  shipped no merged PRs of their own.

## 0.4 (2026-08-29 to 2026-08-30): Windows auth and session sync

- Windows installer aligned with Hermes session-token auth and its venv launcher (#269, #273);
  the effective Dashboard profile is proven (#276); Hermes desktop sessions resume and sync in both
  directions (#277, #279); validated Markdown attachments (#278).

## 0.3 (2026-08-27 to 2026-08-29): federation and phone-node hardening

- **v0.3.0** Federated Hermes gateways with managed topology (#239); gateway-owned mobile
  attachments expire (#238).
- **v0.3.1** Truthful phone-node failures and leases, native media delivery to and from fresh
  agents, authoritative bot readiness during provisioning, Windows Node bootstrap (#243 to #260).
- **v0.3.7 to v0.3.9** Installer test and Hermes authentication fixes on the way to a working
  Windows install (#263, #266, #268); v0.3.2 to v0.3.6 shipped no merged PRs of their own.

## 0.2 (2026-08-22 to 2026-08-27): Hermes-only gateway and the attach data plane

- **v0.2.0** The Hermes-only gateway with a one-line installer (#139); the durable attach-v1
  data plane (#128 to #134); assistant media, session restore, agent inbox, per-bot model and
  reasoning (capabilities 15 to 18); Live Activity delivery (#137, #138).
- **v0.2.1 to v0.2.8** Connectivity recovery, orphaned tool state, bot file attachments, Node 24
  bootstrap, routines restored, the origin-bound phone node, and Hermes turns that stay audible
  across tool boundaries (#140 to #153).
- **v0.2.9** Durable delivery receipts and media lifecycle, blank-slate bot seeding, automatic bot
  provisioning on the dev box, live subagent and thinking previews, secure bot deletion, and the
  phone hand-over of photos, files, and decisions (#159 to #221).
- **v0.2.10 to v0.2.12** Every platform installs what it needs (#224), CI fixes (#231), secure
  public pairing by default (#235).

## 0.1 (2026-08-20): first bundle

- **v0.1.0** The contract-v1 gateway core with the Hermes bridge (roster, canonical chat, create
  and delete, profile editing, routines, group chats, streaming, images, approvals), first-class
  TLS, the relay with APNs, health and readiness probes, the single-file bundle, and the one-line
  service install (#12 to #74). **v0.1.1** `--pair-only` re-enters the recorded install (#78).
