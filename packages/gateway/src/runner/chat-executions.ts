import { randomBytes, randomUUID } from "node:crypto";
import type { BotProfilePatch, ChatBranch, ChatComputer, ChatModelSelection, ChatProject } from "cozygateway-contract";
import type { ChatConfigurationDriver } from "../chat-configuration.ts";
import { ChatConfigurationUnavailable } from "../chat-configuration.ts";
import { ConfigNotFound, type AttachConfigSurface } from "../hermes-bridge/bot-config.ts";
import type { ChatExecutionRow, Storage } from "../storage.ts";
import type { RunnerLane } from "./lane.ts";
import type { RunnerChatFrame, RunnerChatWorkspaceResult, RunnerCreateChatExecutionPayload } from "./protocol.ts";

type PrepareInput = Parameters<ChatConfigurationDriver["prepareContext"]>[0];
type WorkspaceResult = NonNullable<RunnerChatWorkspaceResult["result"]>;
type ChatLane = Pick<RunnerLane, "onChatFrame" | "onChatConnection" | "chatCapableRunners" | "sendChatCommand">;
type ChatConfigSurface = Pick<AttachConfigSurface, "botProfile" | "modelConfig" | "providerConnections" | "prepareChatConfiguration">;
interface ExecutionOptions {
  runtimeBot: (bot: string) => boolean;
  harness?: (bot: string) => "cozyagents" | "hermes" | undefined;
  name: (runnerId: string) => string | undefined;
  tokens: Map<string, string>;
  isAttached: (peer: string) => boolean;
  disconnect: (peer: string) => void;
  prepareProvider: (bot: string, executionId: string, model: ChatModelSelection) => Promise<void>;
  now?: () => number;
}

/** A chat assignment is durable, but a computer's availability comes only from its current
 * authenticated connection. Each assignment has its own attach stream and source-bot binding. */
export class RunnerChatExecutionDriver implements ChatConfigurationDriver {
  readonly #storage: Storage;
  readonly #lane: ChatLane;
  readonly #surface: ChatConfigSurface;
  readonly #local: ChatConfigurationDriver;
  readonly #options: ExecutionOptions;
  readonly #requests = new Map<string, { runnerId: string; resolve: (result: WorkspaceResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  readonly #preparations = new Map<string, Promise<{ workspacePrepared: boolean; effectiveModel?: ChatModelSelection }>>();
  readonly #unsubscribe: (() => void)[];
  readonly #sweep: ReturnType<typeof setInterval>;

  constructor(options: ExecutionOptions & {
    storage: Storage; lane: ChatLane; surface: ChatConfigSurface; local: ChatConfigurationDriver;
  }) {
    this.#options = options;
    this.#storage = options.storage;
    this.#lane = options.lane;
    this.#surface = options.surface;
    this.#local = options.local;
    this.#unsubscribe = [
      this.#lane.onChatFrame((runnerId, frame) => this.#receive(runnerId, frame)),
      this.#lane.onChatConnection((runnerId, hello) => {
        if (hello) this.#reconcile(runnerId);
        else for (const [id, pending] of this.#requests) if (pending.runnerId === runnerId) {
          clearTimeout(pending.timer); this.#requests.delete(id);
          pending.reject(new ChatConfigurationUnavailable("This computer disconnected. Reconnect it and try again."));
        }
      }),
    ];
    this.#sweep = setInterval(() => this.#reconcile(), 10_000);
    this.#sweep.unref();
  }

  async availability(input: { bot: string; sessionId: string }) {
    const existing = this.#storage.chatExecution(input.bot, input.sessionId);
    if (existing && this.#lane.chatCapableRunners(this.#harness(input.bot)).includes(existing.runnerId)) return { available: true };
    const local = await this.#local.availability(input);
    if (local.available || !this.#harness(input.bot)) return local;
    return this.#lane.chatCapableRunners(this.#harness(input.bot)).length ? { available: true } : local;
  }

  async computers(input: { bot: string; sessionId: string }): Promise<readonly ChatComputer[]> {
    let local: readonly ChatComputer[] = [];
    if ((await this.#local.availability(input)).available) local = await this.#local.computers(input);
    if (!this.#harness(input.bot)) return local;
    const computers = new Map(local.map((computer) => [computer.id, computer]));
    for (const id of this.#lane.chatCapableRunners(this.#harness(input.bot))) computers.set(id, { id, name: this.#options.name(id) ?? "Computer", isAvailable: true });
    const current = this.#storage.nativeChatConfiguration(input.bot, input.sessionId)?.workspace;
    if (current && !computers.has(current.computerId)) computers.set(current.computerId, {
      id: current.computerId, name: this.#options.name(current.computerId) ?? "Unavailable computer", isAvailable: false,
    });
    return [...computers.values()];
  }

  async projects(bot: string, computerId: string): Promise<readonly ChatProject[]> {
    if (!this.#remote(bot, computerId)) return this.#local.projects(bot, computerId);
    const result = await this.#request(computerId);
    if (!("projects" in result)) throw new ChatConfigurationUnavailable("The computer returned an invalid project list.");
    return result.projects;
  }

  async branches(bot: string, computerId: string, projectId: string): Promise<readonly ChatBranch[]> {
    if (!this.#remote(bot, computerId)) return this.#local.branches(bot, computerId, projectId);
    const result = await this.#request(computerId, projectId);
    if (!("branches" in result)) throw new ChatConfigurationUnavailable("The computer returned an invalid branch list.");
    return result.branches;
  }

  prepareContext(input: PrepareInput): Promise<{ workspacePrepared: boolean; effectiveModel?: ChatModelSelection }> {
    const key = `${input.bot}\0${input.sessionId}`;
    const previous = this.#preparations.get(key) ?? Promise.resolve({ workspacePrepared: false });
    const result = previous.catch(() => ({ workspacePrepared: false })).then(() => this.#prepare(input));
    this.#preparations.set(key, result);
    void result.finally(() => { if (this.#preparations.get(key) === result) this.#preparations.delete(key); }).catch(() => undefined);
    return result;
  }

  async #prepare(input: PrepareInput): Promise<{ workspacePrepared: boolean; effectiveModel?: ChatModelSelection }> {
    let existing = this.#storage.chatExecution(input.bot, input.sessionId);
    if (existing && JSON.stringify(existing.workspace) !== JSON.stringify(input.workspace)) {
      if (this.#storage.nativeChatConfiguration(input.bot, input.sessionId)?.workspaceLocked)
        throw new ChatConfigurationUnavailable("This chat already has a workspace.");
      this.#retire(existing);
      existing = undefined;
    }
    if (!input.workspace || (!existing && !this.#remote(input.bot, input.workspace.computerId)))
      return this.#local.prepareContext(input);
    if (!this.#harness(input.bot)) throw new ChatConfigurationUnavailable("This computer cannot run this agent type.");
    if (!this.#lane.chatCapableRunners(this.#harness(input.bot)).includes(input.workspace.computerId))
      throw new ChatConfigurationUnavailable("The selected computer is offline or needs a runner update.");
    const configured = await this.#surface.modelConfig(input.bot);
    const defaultProfile = !input.model && !configured.model ? await this.#surface.botProfile(input.bot).catch((error: unknown) => {
      if (error instanceof ConfigNotFound) return undefined;
      throw error;
    }) : undefined;
    const selectedModel = configured.model ?? (defaultProfile?.model.provider && defaultProfile.model.default
      ? `${defaultProfile.model.provider}:${defaultProfile.model.default}` : null);
    const separator = selectedModel?.indexOf(":") ?? -1;
    const model = input.model ?? (selectedModel && separator > 0 ? {
      providerId: selectedModel.slice(0, separator), modelId: selectedModel.slice(separator + 1),
      ...(configured.effort ? { effort: configured.effort } : {}),
    } : null);
    if (!model) throw new ChatConfigurationUnavailable("Choose a model for this chat before using another computer.");
    let execution = this.#storage.chatExecution(input.bot, input.sessionId);
    if (!execution) {
      const profile = defaultProfile ?? await this.#surface.botProfile(input.bot).catch((error: unknown) => {
        if (error instanceof ConfigNotFound) return undefined;
        throw error;
      });
      const sourceProfile: BotProfilePatch = profile ? {
        soul: profile.soul,
        disabledSkills: profile.skills.filter((skill) => !skill.enabled).map((skill) => skill.name),
        enabledSkills: profile.skills.filter((skill) => skill.enabled).map((skill) => skill.name),
        ...(profile.toolsetsPinned ? { enabledToolsets: profile.toolsets.filter((toolset) => toolset.enabled).map((toolset) => toolset.name) } : {}),
        enabledMcpServers: profile.mcpServers.filter((server) => server.enabled).map((server) => server.name),
        ...(profile.guardrailLevel ? { guardrailLevel: profile.guardrailLevel } : {}),
      } : {};
      const endpoint = configured.providers?.find((provider) => provider.slug === model.providerId)?.baseUrl
        ?? (model.providerId.startsWith("custom-")
          ? (await this.#surface.providerConnections(input.bot)).connections.find((provider) => provider.id === model.providerId)?.baseUrl : undefined);
      if (model.providerId.startsWith("custom-") && !endpoint) throw new ChatConfigurationUnavailable("This provider is no longer configured. Choose another model.");
      execution = {
        executionId: `chatx_${randomBytes(16).toString("hex")}`,
        bot: input.bot, sessionId: input.sessionId, runnerId: input.workspace.computerId,
        token: randomBytes(32).toString("hex"), operationId: `chat_create_${randomBytes(16).toString("hex")}`,
        workspace: input.workspace, model, sourceProfile, harness: this.#harness(input.bot) ?? "cozyagents",
        launchModel: { id: model.modelId, ...(endpoint ? { endpoint } : { provider: model.providerId }) },
        stage: "starting", createdAt: this.#options.now?.() ?? Date.now(),
      };
      this.#storage.saveChatExecution(execution);
      this.#options.tokens.set(execution.token, execution.executionId);
    }
    this.#launch(execution);
    const deadline = Date.now() + 65_000;
    while (!this.#options.isAttached(execution.executionId)) {
      if (this.#storage.chatExecutionById(execution.executionId)?.stage === "failed")
        throw new ChatConfigurationUnavailable("The computer could not start this chat. Check its runner and try again.");
      if (!this.#lane.chatCapableRunners().includes(execution.runnerId) || Date.now() >= deadline)
        throw new ChatConfigurationUnavailable("The computer is still starting this chat. Try sending again when it reconnects.");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (model?.providerId.startsWith("custom-")) await this.#options.prepareProvider(input.bot, execution.executionId, model);
    await this.#surface.prepareChatConfiguration(execution.executionId, {
      sessionId: input.sessionId, workspace: input.workspace, model,
    });
    this.#storage.setChatExecutionStage(execution.executionId, "ready");
    return { workspacePrepared: true, ...(model ? { effectiveModel: model } : {}) };
  }

  #harness(bot: string): "cozyagents" | "hermes" | undefined {
    return this.#options.harness?.(bot) ?? (this.#options.runtimeBot(bot) ? "cozyagents" : undefined);
  }

  #remote(bot: string, computerId: string): boolean {
    const harness = this.#harness(bot);
    return harness !== undefined && this.#lane.chatCapableRunners(harness).includes(computerId);
  }

  #request(runnerId: string, projectId?: string): Promise<WorkspaceResult> {
    if (this.#requests.size >= 100) return Promise.reject(new ChatConfigurationUnavailable("The computer is busy. Try again."));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#requests.delete(requestId); reject(new ChatConfigurationUnavailable("The computer did not return its workspaces. Try again.")); }, 12_000);
      this.#requests.set(requestId, { runnerId, resolve, reject, timer });
      const sent = this.#lane.sendChatCommand(runnerId, projectId === undefined
        ? { kind: "command", command: "list_chat_projects", payload: { requestId } }
        : { kind: "command", command: "list_chat_branches", payload: { requestId, projectId } });
      if (!sent) { clearTimeout(timer); this.#requests.delete(requestId); reject(new ChatConfigurationUnavailable("The selected computer is offline.")); }
    });
  }

  #receive(runnerId: string, frame: RunnerChatFrame): void {
    if (frame.kind === "chat_workspace_result") {
      const pending = this.#requests.get(frame.requestId);
      if (!pending || pending.runnerId !== runnerId) return;
      this.#requests.delete(frame.requestId); clearTimeout(pending.timer);
      if (frame.result && !frame.error) pending.resolve(frame.result);
      else pending.reject(new ChatConfigurationUnavailable("The computer could not read this workspace."));
      return;
    }
    const row = this.#storage.chatExecutionById(frame.executionId);
    if (!row || row.runnerId !== runnerId || row.bot !== frame.botId || row.sessionId !== frame.sessionId) return;
    const expected = row.stage === "deleted" ? `chat_delete_${row.executionId}` : row.operationId;
    if (frame.operationId !== expected || (row.stage === "deleted" && frame.stage !== "deleted")) return;
    this.#storage.setChatExecutionStage(row.executionId, frame.stage);
  }

  #launch(row: ChatExecutionRow): void {
    const payload: RunnerCreateChatExecutionPayload = {
      operationId: row.operationId, executionId: row.executionId, botId: row.bot, sessionId: row.sessionId,
      attachToken: row.token, workspace: row.workspace, harness: row.harness ?? "cozyagents",
      ...(row.launchModel ? { model: row.launchModel } : {}),
      ...(row.model?.providerId.startsWith("custom-") ? { credentialMode: "transfer_required" as const } : {}),
      ...(row.sourceProfile ? { sourceProfile: row.sourceProfile } : {}),
    };
    this.#lane.sendChatCommand(row.runnerId, { kind: "command", command: "create_chat_execution", payload });
  }

  #retire(row: ChatExecutionRow): void {
    this.#storage.setChatExecutionStage(row.executionId, "deleted");
    this.#options.tokens.delete(row.token);
    this.#options.disconnect(row.executionId);
    this.#lane.sendChatCommand(row.runnerId, { kind: "command", command: "delete_chat_execution", payload: {
      operationId: `chat_delete_${row.executionId}`, executionId: row.executionId,
    } });
  }

  #reconcile(runnerId?: string): void {
    for (const row of this.#storage.chatExecutions()) {
      if (runnerId !== undefined && row.runnerId !== runnerId) continue;
      if (row.stage === "deleted" || !this.#storage.nativeBotHasSession(row.bot, row.sessionId)) this.#retire(row);
      else if (!this.#options.isAttached(row.executionId)) this.#launch(row);
    }
  }

  close(): void {
    clearInterval(this.#sweep);
    for (const unsubscribe of this.#unsubscribe) unsubscribe();
    for (const pending of this.#requests.values()) { clearTimeout(pending.timer); pending.reject(new ChatConfigurationUnavailable("The gateway is restarting.")); }
    this.#requests.clear();
  }
}
