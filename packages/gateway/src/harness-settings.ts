import type {
  GatewayHarness,
  GatewayHarnessCatalog,
  ModelProviderOAuthSession,
  ModelProviderSetupCatalog,
  BotModelConfig,
} from "cozygateway-contract";

import type { HermesBridgeConfig, ResolvedHermesEndpoint } from "./config.ts";
import type { HermesClient } from "./hermes-bridge/client.ts";
import {
  cancelProviderOAuth,
  deleteProviderSetupField,
  pollProviderOAuth,
  readProviderSetupCatalog,
  startProviderOAuth,
  submitProviderOAuthCode,
  writeProviderSetupField,
} from "./hermes-bridge/provider-setup.ts";

const HERMES_VENDOR = {
  id: "hermes-agent",
  name: "Hermes Agent",
  logoAsset: "hermes-agent",
  logoSourceUrl: "https://github.com/NousResearch/hermes-agent/blob/main/website/static/img/favicon.svg",
} as const;

export class HarnessSettingsInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessSettingsInvalid";
  }
}

export interface HarnessModelSettingsAdapter {
  descriptor(): GatewayHarness;
  modelProviders(scopeId: string): Promise<ModelProviderSetupCatalog>;
  configureField(scopeId: string, provider: string, field: string, value: string): Promise<ModelProviderSetupCatalog>;
  clearField(scopeId: string, provider: string, field: string): Promise<ModelProviderSetupCatalog>;
  startOAuth(scopeId: string, provider: string): Promise<ModelProviderOAuthSession>;
  pollOAuth(scopeId: string, provider: string, sessionId: string): Promise<ModelProviderOAuthSession>;
  submitOAuthCode(scopeId: string, provider: string, sessionId: string, code: string): Promise<ModelProviderOAuthSession>;
  cancelOAuth(scopeId: string, provider: string, sessionId: string): Promise<void>;
}

export class HermesHarnessModelSettingsAdapter implements HarnessModelSettingsAdapter {
  readonly #client: HermesClient;
  readonly #harness: GatewayHarness;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(endpoint: ResolvedHermesEndpoint, client: HermesClient) {
    this.#client = client;
    this.#harness = {
      id: endpoint.id ?? "default",
      ...(endpoint.label === undefined ? {} : { label: endpoint.label }),
      vendor: HERMES_VENDOR,
      scopes: visibleScopes(endpoint.config),
    };
  }

  descriptor(): GatewayHarness { return this.#harness; }

  modelProviders(scopeId: string): Promise<ModelProviderSetupCatalog> {
    return readProviderSetupCatalog(this.#client, this.#scope(scopeId));
  }

  configureField(scopeId: string, provider: string, field: string, value: string): Promise<ModelProviderSetupCatalog> {
    return this.#serialize(() => writeProviderSetupField(this.#client, this.#scope(scopeId), provider, field, value));
  }

  clearField(scopeId: string, provider: string, field: string): Promise<ModelProviderSetupCatalog> {
    return this.#serialize(() => deleteProviderSetupField(this.#client, this.#scope(scopeId), provider, field));
  }

  startOAuth(scopeId: string, provider: string): Promise<ModelProviderOAuthSession> {
    return this.#serialize(() => startProviderOAuth(this.#client, this.#scope(scopeId), provider));
  }

  pollOAuth(scopeId: string, provider: string, sessionId: string): Promise<ModelProviderOAuthSession> {
    return pollProviderOAuth(this.#client, this.#scope(scopeId), provider, sessionId);
  }

  submitOAuthCode(scopeId: string, provider: string, sessionId: string, code: string): Promise<ModelProviderOAuthSession> {
    return this.#serialize(() => submitProviderOAuthCode(this.#client, this.#scope(scopeId), provider, sessionId, code));
  }

  cancelOAuth(scopeId: string, provider: string, sessionId: string): Promise<void> {
    return this.#serialize(() => cancelProviderOAuth(this.#client, this.#scope(scopeId), provider, sessionId));
  }

  #scope(scopeId: string): string {
    if (!this.#harness.scopes.some((scope) => scope.id === scopeId))
      throw new HarnessSettingsInvalid(`unknown configuration scope: ${scopeId}`);
    return scopeId;
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#writeTail.then(operation, operation);
    this.#writeTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export class GatewayHarnessSettings {
  readonly #adapters: ReadonlyMap<string, HarnessModelSettingsAdapter>;
  readonly #now: () => number;

  constructor(adapters: readonly HarnessModelSettingsAdapter[], now: () => number = Date.now) {
    this.#adapters = new Map(adapters.map((adapter) => [adapter.descriptor().id, adapter]));
    if (this.#adapters.size !== adapters.length) throw new Error("duplicate gateway harness id");
    this.#now = now;
  }

  catalog(): GatewayHarnessCatalog {
    return { harnesses: [...this.#adapters.values()].map((adapter) => adapter.descriptor()), updatedAt: this.#now() };
  }

  adapter(harnessId: string): HarnessModelSettingsAdapter {
    const adapter = this.#adapters.get(harnessId);
    if (!adapter) throw new HarnessSettingsInvalid(`unknown agent harness: ${harnessId}`);
    return adapter;
  }
}

/** CozyAgents keeps the Pi catalog and credentials on each runtime. This adapter only projects
 * that catalog into the same Settings navigation used by other harnesses. */
export class CozyAgentsHarnessModelSettingsAdapter implements HarnessModelSettingsAdapter {
  readonly scopes: () => GatewayHarness["scopes"];
  readonly read: (bot: string) => Promise<BotModelConfig>;
  constructor(
    scopes: () => GatewayHarness["scopes"],
    read: (bot: string) => Promise<BotModelConfig>,
  ) { this.scopes = scopes; this.read = read; }

  descriptor(): GatewayHarness {
    return {
      id: "cozyagents", vendor: { id: "cozyagents", name: "CozyAgents", logoAsset: "cozyagents" }, scopes: this.scopes(),
    };
  }

  async modelProviders(scopeId: string): Promise<ModelProviderSetupCatalog> {
    if (!this.scopes().some((scope) => scope.id === scopeId)) throw new HarnessSettingsInvalid("unknown CozyAgents scope");
    const config = await this.read(scopeId);
    const ids = new Set([
      ...(config.providers ?? []).map((provider) => provider.slug),
      ...config.catalog.flatMap((model) => model.id.includes(":") ? [model.id.split(":", 1)[0]!] : []),
    ]);
    return {
      providers: [...ids].filter((id) => !id.startsWith("custom-")).map((id) => {
        const provider = config.providers?.find((entry) => entry.slug === id);
        const models = config.catalog.filter((entry) => entry.id.startsWith(`${id}:`));
        return {
          slug: id, name: provider?.name ?? id,
          authenticated: provider?.authenticated ?? models.some((entry) => !entry.unauthenticated),
          models: models.map((entry) => entry.id.slice(id.length + 1)),
          modelCount: models.length, methods: [],
        };
      }),
      updatedAt: Date.now(),
    };
  }

  async configureField(): Promise<ModelProviderSetupCatalog> { throw new HarnessSettingsInvalid("this provider is configured by its runtime"); }
  async clearField(): Promise<ModelProviderSetupCatalog> { throw new HarnessSettingsInvalid("this provider is configured by its runtime"); }
  async startOAuth(): Promise<ModelProviderOAuthSession> { throw new HarnessSettingsInvalid("OAuth is unavailable on this runtime"); }
  async pollOAuth(): Promise<ModelProviderOAuthSession> { throw new HarnessSettingsInvalid("OAuth is unavailable on this runtime"); }
  async submitOAuthCode(): Promise<ModelProviderOAuthSession> { throw new HarnessSettingsInvalid("OAuth is unavailable on this runtime"); }
  async cancelOAuth(): Promise<void> { throw new HarnessSettingsInvalid("OAuth is unavailable on this runtime"); }
}

function visibleScopes(config: HermesBridgeConfig): GatewayHarness["scopes"] {
  const hidden = new Set((config.hiddenProfiles ?? []).map((value) => value.trim().toLowerCase()));
  return Object.entries(config.profiles).flatMap(([rawId, profile]) => {
    const id = rawId.trim().toLowerCase();
    return hidden.has(id) ? [] : [{ id, name: profile.name ?? id }];
  });
}
