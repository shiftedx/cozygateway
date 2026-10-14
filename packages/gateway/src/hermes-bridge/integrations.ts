import type {
  IntegrationCreateRequest,
  IntegrationCatalogEntry,
  IntegrationCatalogInstallRequest,
  IntegrationCatalogInstallResponse,
  IntegrationCatalogResponse,
  IntegrationOAuthFlow,
  IntegrationServer,
  IntegrationTestResult,
  IntegrationUpdateRequest,
} from "cozygateway-contract";
import type { HermesClient } from "./client.ts";
import { BotNotFound } from "./crud.ts";
import { parseProfilesList } from "./roster.ts";

const MAX_SERVERS = 200;
const FLOW_TTL_MS = 15 * 60_000;

export class IntegrationInvalid extends Error {}
export class IntegrationNotFound extends Error {
  constructor(name: string) { super("no configured integration named " + JSON.stringify(name)); }
}
export class IntegrationFlowNotFound extends Error {
  constructor() { super("no matching integration authorization flow exists"); }
}

type RecordValue = Record<string, unknown>;
type FlowBinding = {
  deviceId: string;
  profile: string;
  serverName: string;
  expiresAt: number;
};

function record(value: unknown): RecordValue | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as RecordValue
    : undefined;
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string"
    && value.length > 0
    && value.length <= max
    && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : undefined;
}

function arrayOfText(value: unknown, maxItems: number, maxLength: number): string[] | undefined {
  if (!Array.isArray(value) || value.length > maxItems) return undefined;
  const result = value.map((entry) => text(entry, maxLength));
  return result.every((entry): entry is string => entry !== undefined) ? result : undefined;
}

/** The runtime interpolates profile-local ${NAME} placeholders recursively. Copy the referenced
 * values through authenticated Dashboard calls, never through a paired-device response. */
function environmentReferences(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) found.add(match[1]!);
  } else if (Array.isArray(value)) {
    for (const entry of value) environmentReferences(entry, found);
  } else {
    const object = record(value);
    if (object !== undefined) for (const entry of Object.values(object)) environmentReferences(entry, found);
  }
  return found;
}

function managedBearerKey(name: string): string {
  const suffix = name.toUpperCase().replace(/[^A-Z0-9_]/g, "_").replace(/^_+|_+$/g, "");
  return "MCP_" + suffix + "_API_KEY";
}

function profilePath(profile: string): string {
  return "/api/config?profile=" + encodeURIComponent(profile);
}

function serversPath(profile: string): string {
  return "/api/mcp/servers?profile=" + encodeURIComponent(profile);
}

function serverPath(name: string, suffix = ""): string {
  return "/api/mcp/servers/" + encodeURIComponent(name) + suffix;
}

function sameEndpoint(
  saved: IntegrationServer,
  requested: { url?: string; command?: string; args?: readonly string[] },
): boolean {
  return (requested.url === undefined || saved.url === requested.url)
    && (requested.command === undefined || saved.command === requested.command)
    && (requested.args === undefined || JSON.stringify(saved.args) === JSON.stringify(requested.args));
}

function safeOAuthStatus(value: unknown): string {
  const raw = text(value, 120);
  return raw !== undefined && /^(authorization_required|pending|complete|failed|cancelled)$/i.test(raw)
    ? raw
    : "pending";
}

function safeAuthorizationURL(value: unknown): string | undefined {
  const raw = text(value, 2048);
  if (raw === undefined) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.username === "" && url.password === "" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Dashboard MCP adapter for one configured launch profile. Route-level paired-device
 * authorization remains at the ordinary Gateway route boundary. */
export class HermesDashboardIntegrations {
  readonly #client: HermesClient;
  readonly #sourceProfile: string;
  readonly #now: () => number;
  readonly #flows = new Map<string, FlowBinding>();
  /** Dashboard's edit endpoint replaces a profile's complete MCP map. Keep those read-modify-write
   * sequences ordered per profile so simultaneous phone requests cannot discard each other's rows. */
  readonly #profileMutations = new Map<string, Promise<unknown>>();

  constructor(opts: { client: HermesClient; sourceProfile: string; now?: () => number }) {
    this.#client = opts.client;
    this.#sourceProfile = opts.sourceProfile;
    this.#now = opts.now ?? Date.now;
  }

  sourceProfile(): string { return this.#sourceProfile; }

  /** Startup evidence gate: no valid Dashboard list means no advertised capability or routes. */
  async probe(): Promise<boolean> {
    try {
      await this.list();
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<IntegrationServer[]> {
    return this.#listProfile(this.#sourceProfile);
  }

  async catalog(): Promise<IntegrationCatalogResponse> {
    const result = record(await this.#client.dashboardJson(
      "/api/mcp/catalog?profile=" + encodeURIComponent(this.#sourceProfile),
    ));
    if (!Array.isArray(result?.["entries"]) || result["entries"].length > MAX_SERVERS)
      throw new IntegrationInvalid("Dashboard returned an invalid integration catalog");
    return { entries: result["entries"].map((entry) => this.#catalogEntry(entry)) };
  }

  async installCatalog(
    name: string,
    input: IntegrationCatalogInstallRequest,
  ): Promise<IntegrationCatalogInstallResponse> {
    const result = record(await this.#client.dashboardJson("/api/mcp/catalog/install", {
      method: "POST",
      body: {
        name,
        env: input.environment ?? {},
        // A source profile is configuration, not a bot grant. The bot-specific route is the only
        // path that turns a configured integration on for a chat profile.
        enable: input.enabled ?? false,
        profile: this.#sourceProfile,
      },
    }));
    if (result?.["ok"] !== true || result["name"] !== name || typeof result["background"] !== "boolean")
      throw new IntegrationInvalid("Dashboard returned an invalid catalog installation result");
    // Bootstrap installs are deliberately only an acknowledgement. Clients must re-read catalog
    // (its `installed` bit is authoritative) before treating a background action as complete.
    if (!result["background"]) await this.#server(this.#sourceProfile, name);
    return { ok: true, name, background: result["background"] };
  }

  async create(input: IntegrationCreateRequest): Promise<IntegrationServer> {
    this.#requireEndpoint(input);
    return this.#mutateProfile(this.#sourceProfile, async () => {
      await this.#client.dashboardJson("/api/mcp/servers", {
        method: "POST",
        body: {
          name: input.name,
          ...(input.url === undefined ? {} : { url: input.url }),
          ...(input.command === undefined ? {} : { command: input.command }),
          args: input.args ?? [],
          auth: input.auth,
          ...(input.bearerToken === undefined ? {} : { bearer_token: input.bearerToken }),
          env: input.environment ?? {},
          profile: this.#sourceProfile,
        },
      });
      await this.#setEnabled(this.#sourceProfile, input.name, false);
      return this.#readback(this.#sourceProfile, input.name, {
        url: input.url,
        command: input.command,
        args: input.args ?? [],
      });
    });
  }

  async update(name: string, input: IntegrationUpdateRequest): Promise<IntegrationServer> {
    this.#requireEndpoint(input, true);
    // The official edit route replaces the whole MCP map. Read it immediately before writing one
    // entry so Dashboard-owned credentials and unrelated servers survive. Credential updates use
    // Dashboard's profile-local env API, but only for references already declared by this server.
    return this.#mutateProfile(this.#sourceProfile, async () => {
      const config = await this.#config(this.#sourceProfile);
      const servers = { ...(record(config["mcp_servers"]) ?? {}) };
      const existing = record(servers[name]);
      if (existing === undefined) throw new IntegrationNotFound(name);
      if (input.auth !== undefined && input.auth !== (existing["auth"] ?? "none"))
        throw new IntegrationInvalid("changing integration authentication requires adding a new integration");
      const references = environmentReferences(existing);
      const requestedEnvironment = input.environment ?? {};
      for (const key of Object.keys(requestedEnvironment)) if (!references.has(key))
        throw new IntegrationInvalid("environment may update only variables referenced by this integration");
      if (input.bearerToken !== undefined) {
        const key = managedBearerKey(name);
        if (!references.has(key))
          throw new IntegrationInvalid("this integration does not use a managed bearer credential");
        await this.#putEnvironment(this.#sourceProfile, key, input.bearerToken);
      }
      for (const [key, value] of Object.entries(requestedEnvironment))
        await this.#putEnvironment(this.#sourceProfile, key, value);
      const replacement: RecordValue = { ...existing };
      if (input.url !== undefined) {
        delete replacement["command"];
        delete replacement["args"];
        replacement["url"] = input.url;
      }
      if (input.command !== undefined) {
        delete replacement["url"];
        replacement["command"] = input.command;
      }
      if (input.args !== undefined) replacement["args"] = input.args;
      servers[name] = replacement;
      await this.#client.dashboardJson("/api/mcp/servers", {
        method: "PUT",
        body: { profile: this.#sourceProfile, servers },
      });
      return this.#readback(this.#sourceProfile, name, {
        url: input.url,
        command: input.command,
        args: input.args,
      });
    });
  }

  async remove(name: string): Promise<void> {
    await this.#mutateProfile(this.#sourceProfile, async () => {
      await this.#client.dashboardJson(serverPath(name) + "?profile=" + encodeURIComponent(this.#sourceProfile), {
        method: "DELETE",
      });
      if ((await this.#listProfile(this.#sourceProfile)).some((server) => server.name === name))
        throw new IntegrationInvalid("integration removal did not persist");
    });
  }

  async test(name: string): Promise<IntegrationTestResult> {
    return this.testForProfile(this.#sourceProfile, name);
  }

  async testForProfile(profile: string, name: string): Promise<IntegrationTestResult> {
    const result = record(await this.#client.dashboardJson(
      serverPath(name, "/test") + "?profile=" + encodeURIComponent(profile),
      { method: "POST" },
    ));
    if (result === undefined || typeof result["ok"] !== "boolean")
      throw new IntegrationInvalid("Dashboard returned an invalid integration test result");
    const tools = Array.isArray(result["tools"]) ? result["tools"] : [];
    if (tools.length > 10_000) throw new IntegrationInvalid("Dashboard returned too many integration tools");
    // Upstream error detail can contain credentials, command output, or host paths.
    return result["ok"]
      ? { ok: true, toolCount: tools.length }
      : { ok: false, toolCount: tools.length, error: "Hermes could not connect to this integration." };
  }

  async startOAuth(name: string, deviceId: string): Promise<IntegrationOAuthFlow> {
    return this.startOAuthForProfile(this.#sourceProfile, name, deviceId);
  }

  async startOAuthForProfile(profile: string, name: string, deviceId: string): Promise<IntegrationOAuthFlow> {
    await this.#server(profile, name);
    const result = record(await this.#client.dashboardJson(
      serverPath(name, "/auth") + "?profile=" + encodeURIComponent(profile),
      { method: "POST" },
    ));
    const flowId = text(result?.["flow_id"], 256);
    if (flowId === undefined || result?.["server_name"] !== name)
      throw new IntegrationInvalid("Dashboard returned an invalid integration authorization flow");
    this.#flows.set(flowId, {
      deviceId,
      profile,
      serverName: name,
      expiresAt: this.#now() + FLOW_TTL_MS,
    });
    const authorizationURL = safeAuthorizationURL(result["authorization_url"]);
    return {
      flowId,
      serverName: name,
      status: safeOAuthStatus(result["status"]),
      ...(authorizationURL === undefined ? {} : { authorizationURL }),
    };
  }

  async oauthStatus(name: string, flowId: string, deviceId: string, profile = this.#sourceProfile): Promise<IntegrationOAuthFlow> {
    const binding = this.#boundFlow(profile, name, flowId, deviceId);
    const result = record(await this.#client.dashboardJson(
      "/api/mcp/oauth/flows/" + encodeURIComponent(flowId),
    ));
    if (result?.["flow_id"] !== flowId || result["server_name"] !== binding.serverName)
      throw new IntegrationInvalid("Dashboard returned a mismatched integration authorization flow");
    const authorizationURL = safeAuthorizationURL(result["authorization_url"]);
    return {
      flowId,
      serverName: binding.serverName,
      status: safeOAuthStatus(result["status"]),
      ...(authorizationURL === undefined ? {} : { authorizationURL }),
    };
  }

  async cancelOAuth(name: string, flowId: string, deviceId: string, profile = this.#sourceProfile): Promise<void> {
    this.#boundFlow(profile, name, flowId, deviceId);
    await this.#client.dashboardJson("/api/mcp/oauth/flows/" + encodeURIComponent(flowId), {
      method: "DELETE",
    });
    this.#flows.delete(flowId);
  }

  async listForBot(name: string): Promise<IntegrationServer[]> {
    return this.#listProfile(name);
  }

  /** Membership only: routes need a real Hermes profile before addressing its Dashboard home, but
   * must not load the full bot editor payload just to list, test, or authorize an integration. */
  async assertProfileExists(name: string): Promise<void> {
    const { profiles } = parseProfilesList(
      await this.#client.request("profiles.list", { include_sessions: false }),
    );
    if (!profiles.some((profile) => profile.name === name)) throw new BotNotFound(name);
  }

  async setEnabledForBot(bot: string, name: string, enabled: boolean): Promise<IntegrationServer> {
    return this.#mutateProfile(bot, async () => {
      const targetServers = await this.#listProfile(bot);
      if (!targetServers.some((server) => server.name === name)) {
        if (!enabled) throw new IntegrationNotFound(name);
        const sourceConfig = await this.#config(this.#sourceProfile);
        const sourceDefinition = record(record(sourceConfig["mcp_servers"])?.[name]);
        if (sourceDefinition === undefined) throw new IntegrationNotFound(name);
        const targetConfig = await this.#config(bot);
        const targetDefinitions = {
          ...(record(targetConfig["mcp_servers"]) ?? {}),
          [name]: sourceDefinition,
        };
        await this.#copyReferencedEnvironment(sourceDefinition, this.#sourceProfile, bot);
        // Official whole-map Dashboard write. It copies only the configured source definition, leaves
        // the target's unrelated config intact, then the dedicated endpoint writes target enabled state.
        await this.#client.dashboardJson("/api/mcp/servers", {
          method: "PUT",
          body: { profile: bot, servers: targetDefinitions },
        });
      }
      await this.#setEnabled(bot, name, enabled);
      const saved = await this.#server(bot, name);
      if (saved.enabled !== enabled)
        throw new IntegrationInvalid("integration enabled state did not persist");
      return saved;
    });
  }

  async #config(profile: string): Promise<RecordValue> {
    const value = record(await this.#client.dashboardJson(profilePath(profile)));
    if (value === undefined) throw new IntegrationInvalid("Dashboard returned an invalid profile configuration");
    return value;
  }

  async #copyReferencedEnvironment(definition: RecordValue, sourceProfile: string, targetProfile: string): Promise<void> {
    const keys = [...environmentReferences(definition)];
    if (keys.length > 16) throw new IntegrationInvalid("integration references too many environment variables");
    for (const key of keys) {
      if (await this.#environmentIsSet(targetProfile, key)) continue;
      const revealed = record(await this.#client.dashboardJson("/api/env/reveal", {
        method: "POST",
        body: { key, profile: sourceProfile },
      }));
      const value = typeof revealed?.["value"] === "string" ? revealed["value"] : undefined;
      if (value === undefined) throw new IntegrationInvalid("Dashboard could not read an integration credential");
      await this.#putEnvironment(targetProfile, key, value);
    }
  }

  async #putEnvironment(profile: string, key: string, value: string): Promise<void> {
    await this.#client.dashboardJson("/api/env", {
      method: "PUT",
      body: { key, value, profile },
    });
  }

  async #setEnabled(profile: string, name: string, enabled: boolean): Promise<void> {
    await this.#client.dashboardJson(serverPath(name, "/enabled"), {
      method: "PUT",
      body: { profile, enabled },
    });
  }

  #mutateProfile<T>(profile: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#profileMutations.get(profile) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.#profileMutations.set(profile, next);
    const cleanup = () => {
      if (this.#profileMutations.get(profile) === next) this.#profileMutations.delete(profile);
    };
    // `finally` mirrors a rejection into its returned promise. Register both branches directly so
    // a rejected write remains observable to its caller without creating an unhandled sibling.
    void next.then(cleanup, cleanup);
    return next;
  }

  async #environmentIsSet(profile: string, key: string): Promise<boolean> {
    const values = record(await this.#client.dashboardJson("/api/env?profile=" + encodeURIComponent(profile)));
    const entry = record(values?.[key]);
    return entry?.["is_set"] === true;
  }

  async #listProfile(profile: string): Promise<IntegrationServer[]> {
    const value = record(await this.#client.dashboardJson(serversPath(profile)));
    if (!Array.isArray(value?.["servers"]) || value["servers"].length > MAX_SERVERS)
      throw new IntegrationInvalid("Dashboard returned an invalid integration list");
    return value["servers"].map((entry) => this.#serverFromDashboard(entry));
  }

  #serverFromDashboard(value: unknown): IntegrationServer {
    const entry = record(value);
    const name = text(entry?.["name"], 120);
    const args = arrayOfText(entry?.["args"] ?? [], 64, 2048);
    const auth = entry?.["auth"] === "header" || entry?.["auth"] === "oauth" || entry?.["auth"] === "none"
      ? entry["auth"]
      : "none";
    if (name === undefined || args === undefined || typeof entry?.["enabled"] !== "boolean")
      throw new IntegrationInvalid("Dashboard returned an invalid integration server");
    // Dashboard's server summary deliberately emits null for an absent transport field.
    const url = entry["url"] === undefined || entry["url"] === null ? undefined : text(entry["url"], 2048);
    const command = entry["command"] === undefined || entry["command"] === null ? undefined : text(entry["command"], 1024);
    if (
      (entry["url"] !== undefined && entry["url"] !== null && url === undefined)
      || (entry["command"] !== undefined && entry["command"] !== null && command === undefined)
    )
      throw new IntegrationInvalid("Dashboard returned an invalid integration server");
    return {
      name,
      ...(url === undefined ? {} : { url }),
      ...(command === undefined ? {} : { command }),
      args,
      auth,
      enabled: entry["enabled"],
    };
  }

  #catalogEntry(value: unknown): IntegrationCatalogEntry {
    const entry = record(value);
    const name = text(entry?.["name"], 120);
    const transport = entry?.["transport"] === "http" || entry?.["transport"] === "stdio"
      ? entry["transport"]
      : undefined;
    const auth = entry?.["auth_type"] === "header" || entry?.["auth_type"] === "oauth" || entry?.["auth_type"] === "none"
      ? entry["auth_type"]
      : "none";
    const args = arrayOfText(entry?.["args"] ?? [], 64, 2048);
    const environment = Array.isArray(entry?.["required_env"])
      ? entry["required_env"].map((item) => {
        const env = record(item);
        const envName = text(env?.["name"], 128);
        if (envName === undefined || typeof env?.["required"] !== "boolean")
          throw new IntegrationInvalid("Dashboard returned an invalid catalog environment");
        const prompt = env["prompt"] === undefined ? undefined : text(env["prompt"], 512);
        if (env["prompt"] !== undefined && prompt === undefined)
          throw new IntegrationInvalid("Dashboard returned an invalid catalog environment");
        return { name: envName, required: env["required"], ...(prompt === undefined ? {} : { prompt }) };
      })
      : undefined;
    const description = entry?.["description"] === undefined ? undefined : text(entry["description"], 1024);
    const url = entry?.["url"] === undefined || entry?.["url"] === null ? undefined : text(entry["url"], 2048);
    const command = entry?.["command"] === undefined || entry?.["command"] === null ? undefined : text(entry["command"], 1024);
    if (
      name === undefined || transport === undefined || args === undefined || environment === undefined
      || environment.length > 64 || typeof entry?.["needs_install"] !== "boolean"
      || typeof entry?.["installed"] !== "boolean" || typeof entry?.["enabled"] !== "boolean"
      || (entry?.["description"] !== undefined && description === undefined)
      || (entry?.["url"] !== undefined && entry?.["url"] !== null && url === undefined)
      || (entry?.["command"] !== undefined && entry?.["command"] !== null && command === undefined)
    ) throw new IntegrationInvalid("Dashboard returned an invalid integration catalog entry");
    return {
      name,
      ...(description === undefined ? {} : { description }),
      transport,
      auth,
      requiredEnvironment: environment,
      ...(url === undefined ? {} : { url }),
      ...(command === undefined ? {} : { command }),
      args,
      needsInstall: entry["needs_install"],
      installed: entry["installed"],
      enabled: entry["enabled"],
    };
  }

  async #server(profile: string, name: string): Promise<IntegrationServer> {
    const server = (await this.#listProfile(profile)).find((entry) => entry.name === name);
    if (server === undefined) throw new IntegrationNotFound(name);
    return server;
  }

  async #readback(
    profile: string,
    name: string,
    requested: { url?: string; command?: string; args?: readonly string[] },
  ): Promise<IntegrationServer> {
    const saved = await this.#server(profile, name);
    if (!sameEndpoint(saved, requested))
      throw new IntegrationInvalid("integration write did not persist");
    return saved;
  }

  #requireEndpoint(
    input: { url?: string; command?: string; args?: readonly string[] },
    allowEmpty = false,
  ): void {
    if (input.url !== undefined && input.command !== undefined)
      throw new IntegrationInvalid("provide either url or command, not both");
    if (!allowEmpty && input.url === undefined && input.command === undefined)
      throw new IntegrationInvalid("an integration requires a url or command");
    if (input.url !== undefined && input.args !== undefined && input.args.length > 0)
      throw new IntegrationInvalid("remote integrations cannot include command arguments");
  }

  #boundFlow(profile: string, name: string, flowId: string, deviceId: string): FlowBinding {
    const binding = this.#flows.get(flowId);
    if (binding !== undefined && binding.expiresAt < this.#now()) {
      this.#flows.delete(flowId);
      throw new IntegrationFlowNotFound();
    }
    if (
      binding === undefined
      || binding.deviceId !== deviceId
      || binding.profile !== profile
      || binding.serverName !== name
    ) {
      throw new IntegrationFlowNotFound();
    }
    return binding;
  }
}
