# Changelog

CozyGateway is pre-1.0. Each minor series below groups the tags that shipped it; patch tags within
a series are fixes to the series' own changes. Per-tag notes live on the
[releases page](https://github.com/shiftedx/cozygateway/releases). Only the newest tag is a full
release; everything older is marked pre-release so installers resolve one "latest".

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
