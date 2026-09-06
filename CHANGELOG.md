# Changelog

CozyGateway is pre-1.0. Each minor series below groups the tags that shipped it; patch tags within
a series are fixes to the series' own changes. Per-tag notes live on the
[releases page](https://github.com/shiftedx/cozygateway/releases). Only the newest tag is a full
release; everything older is marked pre-release so installers resolve one "latest".

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
