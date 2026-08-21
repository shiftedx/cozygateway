import type { BotModelConfig, BotModelConfigPatch } from "cozygateway-contract";

import type { HermesClient } from "./client.ts";

/** Hermes' accepted profile/invocation vocabulary. Surveyed from
 * `hermes_constants.VALID_REASONING_EFFORTS` plus the `none` branch in
 * `parse_reasoning_effort`. */
export const HERMES_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export class ModelConfigInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelConfigInvalid";
  }
}

interface HermesModelProvider {
  slug?: unknown;
  name?: unknown;
  aliases?: unknown;
  models?: unknown;
  authenticated?: unknown;
  api_url?: unknown;
}

interface HermesModelOptions {
  model?: unknown;
  provider?: unknown;
  providers?: unknown;
}

interface HermesWebConfig {
  agent?: unknown;
  model?: unknown;
}

interface ModelChoice {
  id: string;
  provider: string;
  model: string;
  displayName: string;
  aliases: string[];
  baseUrl?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function profileQuery(name: string): string {
  return `profile=${encodeURIComponent(name)}`;
}

function choicesOf(options: HermesModelOptions): ModelChoice[] {
  const providers = Array.isArray(options.providers) ? (options.providers as HermesModelProvider[]) : [];
  return providers.flatMap((row) => {
    const provider = typeof row.slug === "string" ? row.slug.trim() : "";
    const label = typeof row.name === "string" && row.name.trim() ? row.name.trim() : provider;
    const aliases = Array.isArray(row.aliases)
      ? row.aliases.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : [];
    const models = Array.isArray(row.models) ? row.models : [];
    if (!provider || row.authenticated === false) return [];
    return models.flatMap((entry) => {
      if (typeof entry !== "string" || !entry.trim()) return [];
      const model = entry.trim();
      return [
        {
          id: `${provider}:${model}`,
          provider,
          model,
          displayName: `${label}: ${model}`,
          aliases,
          ...(typeof row.api_url === "string" && row.api_url.trim() ? { baseUrl: row.api_url.trim() } : {}),
        },
      ];
    });
  });
}

async function readHermesModelState(
  client: HermesClient,
  name: string,
): Promise<{ config: HermesWebConfig; options: HermesModelOptions; choices: ModelChoice[] }> {
  const query = profileQuery(name);
  // Hermes dashboard REST is the profile-aware edit-screen authority. Its JSON-RPC equivalents
  // are `model.options` and `config.get {key:"full"}`, but those handlers are not profile-scoped
  // in the surveyed checkout. The persisted keys beneath these REST routes are
  // `model.provider`, `model.default`, and `agent.reasoning_effort`.
  const [config, options] = await Promise.all([
    client.dashboardJson<HermesWebConfig>(`/api/config?${query}`),
    client.dashboardJson<HermesModelOptions>(`/api/model/options?${query}&explicit_only=1`),
  ]);
  return { config, options, choices: choicesOf(options) };
}

function responseOf(state: {
  config: HermesWebConfig;
  options: HermesModelOptions;
  choices: ModelChoice[];
}): BotModelConfig {
  const provider = typeof state.options.provider === "string" ? state.options.provider.trim() : "";
  const model = typeof state.options.model === "string" ? state.options.model.trim() : "";
  const configuredModel = typeof state.config.model === "string" ? state.config.model.trim() : "";
  const selected = state.choices.find(
    (choice) => choice.model === model && (choice.provider === provider || choice.aliases.includes(provider)),
  );
  const agent = asRecord(state.config.agent);
  const rawEffort = agent?.["reasoning_effort"];
  const effort = typeof rawEffort === "string" && rawEffort.trim() ? rawEffort.trim().toLowerCase() : null;
  return {
    model: configuredModel && provider && model ? (selected?.id ?? `${provider}:${model}`) : null,
    effort,
    catalog: state.choices.map(({ id, displayName }) => ({ id, displayName })),
    efforts: [...HERMES_REASONING_EFFORTS],
  };
}

export async function readBotModelConfig(client: HermesClient, name: string): Promise<BotModelConfig> {
  return responseOf(await readHermesModelState(client, name));
}

export async function writeBotModelConfig(
  client: HermesClient,
  name: string,
  patch: BotModelConfigPatch,
): Promise<BotModelConfig> {
  const state = await readHermesModelState(client, name);
  const choice = patch.model == null ? undefined : state.choices.find((entry) => entry.id === patch.model);
  if (patch.model !== undefined && patch.model !== null && choice === undefined) {
    throw new ModelConfigInvalid(`unknown model: ${patch.model}`);
  }
  if (
    patch.effort !== undefined &&
    patch.effort !== null &&
    !HERMES_REASONING_EFFORTS.includes(patch.effort as (typeof HERMES_REASONING_EFFORTS)[number])
  ) {
    throw new ModelConfigInvalid(`unknown effort: ${patch.effort}`);
  }

  const query = profileQuery(name);
  const configPatch: Record<string, unknown> = {};
  if (patch.effort !== undefined) {
    configPatch["agent"] = { reasoning_effort: patch.effort ?? "" };
  }
  if (patch.model === null) configPatch["model"] = "";
  if (Object.keys(configPatch).length > 0) {
    await client.dashboardJson(`/api/config?${query}`, { method: "PUT", body: { config: configPatch } });
  }
  if (choice !== undefined) {
    // Hermes' profile-aware dashboard write is `POST /api/model/set` with
    // `{scope:"main", provider, model}`. It persists `model.provider` and `model.default`.
    await client.dashboardJson(`/api/model/set?${query}`, {
      method: "POST",
      body: {
        scope: "main",
        provider: choice.provider,
        model: choice.model,
        confirm_expensive_model: true,
        ...(choice.baseUrl === undefined ? {} : { base_url: choice.baseUrl }),
      },
    });
  }

  // Read after write so the response is Hermes' reported profile pin, never an echo or a gateway shadow.
  return readBotModelConfig(client, name);
}
