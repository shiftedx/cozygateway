# F18b gateway report

Base: `9514fa5b4bdc4d78a2725614c580a84dd1db3e11`. Branch: `codex/f18b-delivery-approval`.

## Delivered

Only a pending approval named exactly `send_file` gets relay routing metadata `interruptionLevel: "time-sensitive"`. This matches the existing CozyAgents delivery-approval classifier. The relay accepts only that closed value, only with the pending approval category, and maps it to `aps["interruption-level"]`. It is a payload key, not an APNs HTTP header. Non-delivery approvals, resolved approvals, messages, task completions, mobile wakes and Live Activities retain their interruption behavior. Webhooks carry the same optional routing hint.

Room approval frames now enter the same encrypted push lane as chat approvals, for both bridge-hosted and gateway-hosted rooms. Pending and resolved pushes use the room namespace. Expiry resolutions emitted by the native plane preserve that namespace too. No harness distinction or plugin modification is involved.

Inspection corrected the brief's outdated wire-gap premise: capability 47 already persists and publishes a room message's writing turn and cause, including restart recovery. A pending approval has no writing reply yet, so capability 77 adds optional `cause: {kind: "user" | "member", seq: integer}` to its room frame and room pending-interaction pointer, copied from the existing durable turn. No new column is needed. Legacy absent provenance remains absent. The app joins the pointer to the existing approval by member, id and turn; the pointer does not invent a card name or session.

## Evidence

280 focused tests passed in 11 files (3.19 seconds): gateway push notifier, room interactions, native group turns, F18b room push/legacy storage, capability-version regression files, contract approval schemas, relay routes and APNs transport. `pnpm build`, `pnpm typecheck`, and `git diff --check` passed with Node 24. No full suite or benchmark campaign ran.

New urgency tests failed against the old relay. The new gateway urgency and pending-cause assertions also failed against the original gateway product files, then passed with the implementation. Existing live/recovery room provenance tests confirm the writing-turn identity already round trips. A new legacy fixture confirms omitted turn and cause stay omitted.

The local integration POC passes a real room approval payload through gateway encryption, relay HTTP validation, and a local APNs HTTP/2 server. It observes `time-sensitive` for delivery and absence for an ordinary approval, with no plaintext tool name or room name in APNs output. This is transport proof, not Apple delivery or Focus proof.

## Rollout and explicit limits

No gateway, relay, app or runner release/deployment was performed. No real user received a push. The app entitlement and provenance implementation are owned by the parent/app worker.

An older strict relay's explicit HTTP 400 `invalid_request` / `malformed notify body` response triggers one retry with the same ciphertext, category and collapse id, omitting only urgency. The gateway logs the downgrade. No network, server or unrelated validation failure is retried. Upgrade the relay to enable elevated delivery. The app needs the Time Sensitive Notifications entitlement in its signed provisioning profile. Real-device Focus presentation, user notification settings, and signed entitlement verification remain outstanding. CozyAgents `DELIVERY_APPROVAL_TTL_MS` is unchanged at 180 seconds; its existing shorter interaction-bound clamp is untouched.

Apple documents the key in the [remote notification payload](https://developer.apple.com/documentation/usernotifications/generating-a-remote-notification). Apple also states that [time-sensitive notifications can break through Focus](https://developer.apple.com/documentation/usernotifications/unnotificationinterruptionlevel/timesensitive), but users can disable this behavior. Therefore the payload and entitlement alone do not justify lowering the approval window.

## Backward compatibility review follow-up

The old-relay fallback regression failed before the retry was added. It now proves exactly two
requests on the supported schema rejection, with identical ciphertext and routing identity, and
ordinary delivery accepted on the second request. A repeatedly rejecting relay receives at most
two attempts. Network, HTTP 500, and unrelated HTTP 400 failures each receive one attempt. The
existing new-relay integration still proves that urgency is retained when supported.

91 focused tests passed after this follow-up across push notifier, room interactions, and APNs
transport. Typecheck passed. The room expiry harness uses the same split dispatch wiring as the
server and asserts exactly one pending and one resolved push, preserving the room namespace.
