---
status: accepted
---

# ADR 0084: Model-provider settings belong to gateway harnesses

Model-provider credentials, authentication flows, and available-model inventory are administered
under a selected agent harness connected to a CozyGateway. They are not bot settings. CozyChat
navigates from a gateway to its harness inventory, then to a harness configuration scope (a Hermes
profile today), and only then to Models & providers.

## Context

One CozyGateway can front multiple agentic harnesses, and a harness can apply provider settings at
a scope other than an app bot. Hermes Agent currently scopes its provider configuration by profile.
Putting provider administration in Bot Edit hides both identities and makes a future second harness
look like another special case.

## Decision

- `com.cozylabs.harness-settings` is the independent capability for this surface.
- CozyGateway owns the harness inventory and stable harness ids.
- Each harness adapter owns its vendor identity, configuration scopes, provider discovery,
  credential fields, authentication flows, and available-model inventory.
- The app displays the selected harness using the vendor's official SVG. Unknown vendors use a
  generic fallback; the app does not maintain a provider registry.
- Hermes Agent uses the official SVG published by Nous Research and exposes each visible Hermes
  profile as an explicit configuration scope.
- Credential values are write-only and never appear in a response, observable store, log, URL, or
  process argument.

## Consequences

The canonical app path is **Settings → Gateways → Gateway → Agent harnesses → Harness →
Configuration profile → Models & providers**. Bot Edit may select a configured model but cannot
administer provider credentials. Capability 41's `/bots/:name/model-providers` routes remain for
transitional compatibility and are not an ownership precedent for another harness.
