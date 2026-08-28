# Harness settings extension v1

Capability id: `com.cozylabs.harness-settings`  
Version: `1`

This device-authenticated extension exposes the agent harnesses connected to one CozyGateway and
delegates model-provider administration to the selected harness adapter. It is independent of
`com.cozylabs.gateway-management`: a gateway can expose harness settings without allowing its
source topology file to be edited.

## Domain model

- A **gateway harness** is one configured backend connection with a stable gateway-local id and a
  vendor identity.
- A **harness configuration scope** is the harness-native boundary at which provider settings
  apply. Hermes Agent exposes visible profiles as scopes.
- A **model provider** is discovered live from the selected harness. CozyGateway and CozyChat do
  not own a provider registry.

Each provider row carries the ordered model ids currently available from that provider as well as
its model count and setup methods. This makes the harness scope—not Bot Edit—the administrative
home for both provider connectivity and available-model inventory. A bot may still select one of
those configured models for its own runtime configuration.

`HarnessVendor.logoAsset` is a stable client mapping key, not image bytes. For `hermes-agent`,
`logoSourceUrl` identifies Nous Research's official SVG. A client uses a generic fallback for an
unknown vendor id or asset key.

## Routes

Every route requires paired-device authentication. `:harnessId` and `:scopeId` must have appeared
in the current `GatewayHarnessCatalog`.

| Route | Request | Success response |
| --- | --- | --- |
| `GET /gateway/harnesses` | — | `GatewayHarnessCatalog` |
| `GET /gateway/harnesses/:harnessId/scopes/:scopeId/model-providers` | — | `ModelProviderSetupCatalog` |
| `PUT /gateway/harnesses/:harnessId/scopes/:scopeId/model-providers/:provider/fields/:field` | `ModelProviderFieldUpdate` | `ModelProviderSetupCatalog` |
| `DELETE /gateway/harnesses/:harnessId/scopes/:scopeId/model-providers/:provider/fields/:field` | — | `ModelProviderSetupCatalog` |
| `POST /gateway/harnesses/:harnessId/scopes/:scopeId/model-providers/:provider/oauth` | — | `ModelProviderOAuthSession` |
| `GET /gateway/harnesses/:harnessId/scopes/:scopeId/model-providers/:provider/oauth/:sessionId` | — | `ModelProviderOAuthSession` |
| `POST /gateway/harnesses/:harnessId/scopes/:scopeId/model-providers/:provider/oauth/:sessionId/code` | `ModelProviderOAuthCode` | `ModelProviderOAuthSession` |
| `DELETE /gateway/harnesses/:harnessId/scopes/:scopeId/model-providers/:provider/oauth/:sessionId` | — | `204 No Content` |

Reads expose only whether a field is set. Every write re-resolves the provider and field against the
harness before forwarding it. Writes within one harness connection are serialized so two devices
cannot interleave read/modify/refresh lifecycles.
