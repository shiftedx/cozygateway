import type { HermesClient } from "./client.ts";

/** The house defaults every app-created profile receives. Kept as one exported value so the
 *  creation test asserts the complete seed rather than a hand-picked subset. */
export const CREATED_PROFILE_SEED = {
  display: { busy_input_mode: "steer" },
  agent: {
    max_turns: 90,
    gateway_timeout: 1800,
    clarify_timeout: 600,
    gateway_timeout_warning: 900,
    gateway_notify_interval: 600,
  },
} as const;

function profileQuery(name: string | undefined): string {
  return name === undefined ? "" : `?profile=${encodeURIComponent(name)}`;
}

function providersOf(config: unknown): Record<string, unknown> | undefined {
  if (typeof config !== "object" || config === null || Array.isArray(config)) return undefined;
  const providers = (config as Record<string, unknown>)["providers"];
  return typeof providers === "object" && providers !== null && !Array.isArray(providers)
    ? (providers as Record<string, unknown>)
    : undefined;
}

/** Seeds a profile immediately after `profiles.create` succeeds.
 *
 *  Surveyed Hermes' profile-aware config surface (the same one #106 uses for model config):
 *  `GET /api/config?profile=<bridge-profile>` reads the operator profile and
 *  `PUT /api/config?profile=<new-profile>` with `{config: ...}` deep-merges into the new profile.
 *  The JSON-RPC equivalents, `config.get {key:"full"}` and key-level `config.set`, are scoped to
 *  the gateway process rather than an arbitrary profile, so they cannot safely perform this copy.
 *
 *  Only the root `providers` map is copied from the operator config. It is copied verbatim because
 *  both profiles belong to that operator, including any provider-local credential fields they
 *  deliberately stored there. No neighboring root section such as auth, env, MCP, or approvals is
 *  duplicated. */
export async function seedCreatedProfile(
  client: HermesClient,
  newProfile: string,
  bridgeProfile: string | undefined,
): Promise<void> {
  const operatorConfig = await client.dashboardJson(`/api/config${profileQuery(bridgeProfile)}`);
  const providers = providersOf(operatorConfig);
  const config = {
    ...CREATED_PROFILE_SEED,
    ...(providers === undefined ? {} : { providers }),
  };
  await client.dashboardJson(`/api/config${profileQuery(newProfile)}`, {
    method: "PUT",
    body: { config },
  });
}
