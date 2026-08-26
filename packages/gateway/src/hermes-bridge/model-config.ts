import type { BotModelConfig, BotModelConfigPatch, BotModelProvider } from "cozygateway-contract";

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
  /** Hermes kept this provider visible despite an unusable credential (its explicit_only payload
   *  re-appends the configured current provider on purpose). The entry stays selectable-looking
   *  data on the wire; the client renders it disabled with a re-auth hint. */
  unauthenticated?: true;
}

export const MODEL_DISCOVERY_TIMEOUT_MS = 750;
export const MODEL_DISCOVERY_CACHE_MS = 30_000;
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const discoveryCache = new Map<string, { expiresAt: number; succeeded: boolean; models: string[] }>();

export function clearModelDiscoveryCache(): void {
  discoveryCache.clear();
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
    if (!provider) return [];
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
          ...(row.authenticated === false ? { unauthenticated: true as const } : {}),
        },
      ];
    });
  });
}

function modelsEndpoint(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.pathname = `${url.pathname.replace(/\/$/, "").replace(/\/v1$/, "")}/v1/models`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

async function discoverProviderModels(baseUrl: string, fetcher: FetchLike): Promise<string[] | undefined> {
  const endpoint = modelsEndpoint(baseUrl);
  if (endpoint === undefined) return undefined;
  const now = Date.now();
  const cached = discoveryCache.get(endpoint);
  if (cached !== undefined && cached.expiresAt > now) return cached.succeeded ? cached.models : undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_DISCOVERY_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetcher(endpoint, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`provider answered ${response.status}`);
    const payload = (await response.json()) as unknown;
    const rows = asRecord(payload)?.["data"];
    const models = Array.isArray(rows)
      ? [...new Set(rows.flatMap((row) => {
          const id = asRecord(row)?.["id"];
          return typeof id === "string" && id.trim() ? [id.trim()] : [];
        }))]
      : [];
    discoveryCache.set(endpoint, { expiresAt: now + MODEL_DISCOVERY_CACHE_MS, succeeded: true, models });
    return models;
  } catch {
    // Before the first successful probe, `undefined` asks the caller to retain Hermes' static row.
    // After a server has proven discoverable, a failed refresh makes it unavailable instead of
    // leaving a stale model in the app forever.
    const succeeded = cached?.succeeded === true;
    discoveryCache.set(endpoint, {
      expiresAt: now + Math.min(MODEL_DISCOVERY_CACHE_MS, 5_000),
      succeeded,
      models: [],
    });
    return succeeded ? [] : undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function discoveredChoices(options: HermesModelOptions, fetcher: FetchLike): Promise<ModelChoice[]> {
  const staticChoices = choicesOf(options);
  const providers = Array.isArray(options.providers) ? (options.providers as HermesModelProvider[]) : [];
  const groups = await Promise.all(providers.map(async (row) => {
    const provider = typeof row.slug === "string" ? row.slug.trim() : "";
    const label = typeof row.name === "string" && row.name.trim() ? row.name.trim() : provider;
    const baseUrl = typeof row.api_url === "string" ? row.api_url.trim() : "";
    // An unauthenticated provider's endpoint is not probed: Hermes kept the row for its saved
    // static selection, and a /v1/models walk without a usable credential would only slow the
    // read down. Its static choices survive through the merge below instead.
    if (!provider || !baseUrl || row.authenticated === false) return [] as ModelChoice[];
    const discovered = await discoverProviderModels(baseUrl, fetcher);
    if (discovered === undefined) return staticChoices.filter((choice) => choice.provider === provider);
    return discovered.map((model) => ({
      id: `${provider}:${model}`,
      provider,
      model,
      displayName: `${label}: ${model}`,
      aliases: Array.isArray(row.aliases)
        ? row.aliases.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        : [],
      baseUrl,
    }));
  }));
  const liveProviders = new Set(providers.flatMap((row) =>
    typeof row.slug === "string" && typeof row.api_url === "string" && row.api_url.trim() &&
    row.authenticated !== false
      ? [row.slug.trim()]
      : []));
  const merged = [
    ...staticChoices.filter((choice) => !liveProviders.has(choice.provider)),
    ...groups.flat(),
  ];
  return [...new Map(merged.map((choice) => [choice.id, choice])).values()];
}

/** Capability 36: one summary row per provider Hermes returned, in Hermes' own order. A row
 *  survives at zero catalog entries (no static models, no reachable endpoint) and with a lost
 *  credential: the explicit_only payload only contains providers the user configured, so the app
 *  picker mirrors the harness picker instead of silently dropping one. */
function providersOf(options: HermesModelOptions, choices: ModelChoice[]): BotModelProvider[] {
  const rows = Array.isArray(options.providers) ? (options.providers as HermesModelProvider[]) : [];
  return rows.flatMap((row) => {
    const slug = typeof row.slug === "string" ? row.slug.trim() : "";
    if (!slug) return [];
    const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : slug;
    const baseUrl = typeof row.api_url === "string" ? row.api_url.trim() : "";
    return [
      {
        slug,
        name,
        authenticated: row.authenticated !== false,
        modelCount: choices.filter((choice) => choice.provider === slug).length,
        ...(baseUrl ? { baseUrl } : {}),
      },
    ];
  });
}

async function readHermesModelState(
  client: HermesClient,
  name: string,
  fetcher: FetchLike = fetch,
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
  for (const row of Array.isArray(options.providers) ? (options.providers as HermesModelProvider[]) : []) {
    if (row.authenticated === false && typeof row.slug === "string" && row.slug.trim()) {
      process.stderr.write(`[hermes-bridge] model-config: provider ${row.slug.trim()} unauthenticated, kept visible\n`);
    }
  }
  return { config, options, choices: await discoveredChoices(options, fetcher) };
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
    catalog: state.choices.map(({ id, displayName, unauthenticated }) => ({
      id,
      displayName,
      ...(unauthenticated === true ? { unauthenticated: true as const } : {}),
    })),
    efforts: [...HERMES_REASONING_EFFORTS],
    providers: providersOf(state.options, state.choices),
  };
}

export async function readBotModelConfig(
  client: HermesClient, name: string, fetcher: FetchLike = fetch,
): Promise<BotModelConfig> {
  return responseOf(await readHermesModelState(client, name, fetcher));
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
