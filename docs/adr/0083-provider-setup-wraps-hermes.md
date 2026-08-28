---
status: accepted
---

# ADR 0083: Provider setup wraps Hermes instead of reimplementing it

CozyGateway exposes model-provider setup by normalizing Hermes' unified `hermes model` provider
universe and forwarding writes into Hermes' own credential lifecycle and OAuth sessions. CozyChat
renders that contract but owns no provider list, auth rules, or credential storage. This keeps new
Hermes providers visible without an app release and avoids two configuration systems drifting.

## Considered options

- **Shell out to `hermes auth add --api-key ...`** — rejected because a credential in a process
  argument can leak through process inspection and command logging, and interactive output is not
  a stable wire protocol.
- **Maintain provider forms in CozyChat** — rejected because Hermes already has the canonical
  catalog and providers can be added by plugins.
- **Wrap Hermes' control-plane substrate (chosen)** — provider fields use Hermes' credential
  lifecycle; PKCE and device-code flows remain Hermes-owned; CLI-only methods are presented as an
  explicit command handoff rather than reported as completed.

## Consequences

Capability 41 gates every setup affordance and route. Credential values travel once in the paired
device request body and once in the authenticated Hermes request body; they are not put in URLs,
process arguments, logs, responses, observable store state, or WebSocket frames. Reads expose only
whether a field is set. CozyGateway re-resolves a provider and field from Hermes before every
write, so a client cannot turn this surface into an arbitrary environment-variable editor.
