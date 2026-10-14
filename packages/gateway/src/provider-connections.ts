import type { ModelProviderConnectionCatalog, ModelProviderConnectionInput } from "cozygateway-contract";
import { OneTimeProviderHandoffs } from "./provider-handoffs.ts";

export interface ProviderConnectionControl {
  list(bot: string): Promise<ModelProviderConnectionCatalog>;
  save(bot: string, handoffId: string): Promise<ModelProviderConnectionCatalog>;
  test(bot: string, id: string): Promise<ModelProviderConnectionCatalog>;
  remove(bot: string, id: string): Promise<ModelProviderConnectionCatalog>;
}

export class ProviderConnectionsUnavailable extends Error {
  constructor() { super("provider connections are unavailable for this harness scope"); }
}

/** Navigation scopes resolve to the actual harness peer; only that peer stores and tests endpoints. */
export class GatewayProviderConnections {
  readonly handoffs: OneTimeProviderHandoffs;
  readonly #control: ProviderConnectionControl;
  readonly #resolveScope: (harnessId: string, scopeId: string) => string | undefined;
  readonly #knownBot: (bot: string) => boolean;
  readonly #ownsExecution: (bot: string, executionId: string) => boolean;

  constructor(options: {
    control: ProviderConnectionControl;
    resolveScope: (harnessId: string, scopeId: string) => string | undefined;
    knownBot: (bot: string) => boolean;
    handoffs?: OneTimeProviderHandoffs;
    ownsExecution?: (bot: string, executionId: string) => boolean;
  }) {
    this.#control = options.control;
    this.#resolveScope = options.resolveScope;
    this.#knownBot = options.knownBot;
    this.#ownsExecution = options.ownsExecution ?? (() => false);
    this.handoffs = options.handoffs ?? new OneTimeProviderHandoffs();
  }

  scope(harnessId: string, scopeId: string): string {
    const bot = this.#resolveScope(harnessId, scopeId);
    if (!bot || !this.#knownBot(bot)) throw new ProviderConnectionsUnavailable();
    return bot;
  }

  bot(name: string): string {
    if (!this.#knownBot(name)) throw new ProviderConnectionsUnavailable();
    return name;
  }

  stageTransfer(source: string, executionId: string, input: ModelProviderConnectionInput): string {
    if (!input.id || !this.#ownsExecution(source, executionId)) throw new ProviderConnectionsUnavailable();
    return this.handoffs.create(executionId, input);
  }

  list(bot: string): Promise<ModelProviderConnectionCatalog> { return this.#control.list(this.bot(bot)); }

  async save(bot: string, input: ModelProviderConnectionInput): Promise<ModelProviderConnectionCatalog> {
    // Verify the peer is online and supports this exact surface before accepting credential input.
    await this.list(bot);
    const handoffId = this.handoffs.create(bot, input);
    try { return await this.#control.save(bot, handoffId); }
    finally { this.handoffs.revoke(handoffId); }
  }

  test(bot: string, id: string): Promise<ModelProviderConnectionCatalog> { return this.#control.test(this.bot(bot), id); }
  remove(bot: string, id: string): Promise<ModelProviderConnectionCatalog> { return this.#control.remove(this.bot(bot), id); }
}
