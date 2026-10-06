import type {
  ChatBranch,
  ChatBranchList,
  ChatComputer,
  ChatModelSelection,
  ChatProject,
  ChatProjectList,
  ChatSessionConfiguration,
  ChatSessionConfigurationPatch,
  ChatSessionConfigurationSnapshot,
  ChatWorkspaceSelection,
} from "cozygateway-contract";

import type { Storage } from "./storage.ts";

/** The executing runtime owns computer-local paths and credentials. */
export interface ChatConfigurationDriver {
  availability(input: { bot: string; sessionId: string }): Promise<{ available: boolean; unavailableReason?: string }>;
  computers(input: { bot: string; sessionId: string }): Promise<readonly ChatComputer[]>;
  projects(bot: string, computerId: string): Promise<readonly ChatProject[]>;
  branches(bot: string, computerId: string, projectId: string): Promise<readonly ChatBranch[]>;
  /** Prepare one future turn's optional context. A true workspace result is safe to remember as
   * the bot's default only after the executing adapter has actually prepared it. */
  prepareContext(input: {
    bot: string;
    sessionId: string;
    workspace: ChatWorkspaceSelection | null;
    model: ChatModelSelection | null;
  }): Promise<{ workspacePrepared: boolean; effectiveModel?: ChatModelSelection }>;
}

export class ChatConfigurationStaleSession extends Error {
  constructor() { super("the selected chat changed; refresh and try again"); this.name = "ChatConfigurationStaleSession"; }
}
export class ChatConfigurationWorkspaceLocked extends Error {
  constructor() { super("workspace selection is locked after this chat's first accepted turn"); this.name = "ChatConfigurationWorkspaceLocked"; }
}
export class ChatConfigurationTurnActive extends Error {
  constructor() { super("model selection can change only while this chat is idle"); this.name = "ChatConfigurationTurnActive"; }
}
export class ChatConfigurationSessionNotFound extends Error {
  constructor() { super("chat session was not found"); this.name = "ChatConfigurationSessionNotFound"; }
}
export class ChatConfigurationUnavailable extends Error {
  constructor(message = "chat execution configuration is unavailable for this bot") { super(message); this.name = "ChatConfigurationUnavailable"; }
}

export class GatewayChatConfiguration {
  readonly #storage: Storage;
  readonly #driver: ChatConfigurationDriver;
  readonly #now: () => number;

  constructor(opts: { storage: Storage; driver: ChatConfigurationDriver; now?: () => number }) {
    this.#storage = opts.storage;
    this.#driver = opts.driver;
    this.#now = opts.now ?? Date.now;
  }

  async snapshot(bot: string): Promise<ChatSessionConfigurationSnapshot> {
    const selected = this.#storage.nativeBotChat(bot, this.#now());
    return this.#snapshot(bot, selected.sessionId);
  }

  async configure(bot: string, patch: ChatSessionConfigurationPatch): Promise<ChatSessionConfigurationSnapshot> {
    const availability = await this.#driver.availability({ bot, sessionId: patch.sessionId });
    if (!availability.available) throw new ChatConfigurationUnavailable(availability.unavailableReason);
    const result = this.#storage.updateNativeChatConfiguration({ bot, ...patch, now: this.#now() });
    if (result.outcome === "stale_session") throw new ChatConfigurationStaleSession();
    if (result.outcome === "workspace_locked") throw new ChatConfigurationWorkspaceLocked();
    if (result.outcome === "turn_active") throw new ChatConfigurationTurnActive();
    if (result.outcome === "not_found") throw new ChatConfigurationSessionNotFound();
    return this.#snapshot(bot, patch.sessionId);
  }

  async computers(bot: string): Promise<readonly ChatComputer[]> {
    const selected = this.#storage.nativeBotChat(bot, this.#now());
    const availability = await this.#driver.availability({ bot, sessionId: selected.sessionId });
    if (!availability.available) throw new ChatConfigurationUnavailable(availability.unavailableReason);
    return await this.#driver.computers({ bot, sessionId: selected.sessionId });
  }
  async projects(bot: string, computerId: string): Promise<ChatProjectList> {
    return { projects: [...await this.#driver.projects(bot, computerId)] };
  }
  async branches(bot: string, computerId: string, projectId: string): Promise<ChatBranchList> {
    return { branches: [...await this.#driver.branches(bot, computerId, projectId)] };
  }

  /** Called before a future turn is handed to its adapter. This does not mark a turn accepted: the
   * turn admission owner must call `recordAcceptedTurn` only after its own durable acceptance. */
  async prepareContext(bot: string, sessionId: string): Promise<{
    configuration: ChatSessionConfiguration;
    prepared: { workspacePrepared: boolean };
  }> {
    const current = this.#storage.nativeChatConfiguration(bot, sessionId);
    if (current === undefined) throw new ChatConfigurationSessionNotFound();
    const configuration: ChatSessionConfiguration = { sessionId, workspace: current.workspace, model: current.model };
    // Untouched chats retain the older-peer path. An explicit return to defaults still needs a
    // preparation so the harness clears a previous override, including after gateway restart.
    const prepared: { workspacePrepared: boolean; effectiveModel?: ChatModelSelection } = current.workspace === null && current.model === null
      && !current.explicitlyConfigured && !this.#storage.chatExecution(bot, sessionId)
      ? { workspacePrepared: false }
      : await this.#driver.prepareContext({ bot, ...configuration });
    // `prepareContext` awaits a remote executor. Re-read synchronously when it returns so a
    // selection edited while it prepared can never be carried by an accepted turn.
    const after = this.#storage.nativeChatConfiguration(bot, sessionId);
    if (after === undefined) throw new ChatConfigurationSessionNotFound();
    if (this.#storage.nativeBotChat(bot, this.#now()).sessionId !== sessionId)
      throw new ChatConfigurationStaleSession();
    if (!sameSelection(after.workspace, current.workspace) || !sameSelection(after.model, current.model))
      throw new ChatConfigurationStaleSession();
    if (prepared.workspacePrepared && after.workspace !== null)
      this.#storage.setNativeChatWorkspaceDefault(bot, after.workspace, this.#now());
    return { configuration: { ...configuration, ...(prepared.effectiveModel ? { model: prepared.effectiveModel } : {}) }, prepared };
  }

  recordAcceptedTurn(bot: string, sessionId: string): void {
    if (!this.#storage.lockNativeChatWorkspace(bot, sessionId, this.#now()))
      throw new ChatConfigurationSessionNotFound();
  }

  async #snapshot(bot: string, sessionId: string): Promise<ChatSessionConfigurationSnapshot> {
    const current = this.#storage.nativeChatConfiguration(bot, sessionId);
    if (current === undefined) throw new ChatConfigurationSessionNotFound();
    const availability = await this.#driver.availability({ bot, sessionId });
    const computers = availability.available ? [...await this.#driver.computers({ bot, sessionId })] : [];
    return {
      configuration: { sessionId, workspace: current.workspace, model: current.model },
      defaults: { workspace: this.#storage.nativeChatWorkspaceDefault(bot) },
      computers,
      canChangeWorkspace: availability.available && !current.workspaceLocked,
      canChangeModel: availability.available && current.activeTurnId === undefined,
      ...(availability.unavailableReason === undefined ? {} : { unavailableReason: availability.unavailableReason }),
    };
  }
}

function sameSelection(a: object | null, b: object | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
