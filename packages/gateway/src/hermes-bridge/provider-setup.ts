import type {
  BotModelProviderOAuthSession,
  BotModelProviderSetup,
  BotModelProviderSetupCatalog,
  BotModelProviderSetupField,
  BotModelProviderSetupMethod,
} from "cozygateway-contract";

import type { HermesClient } from "./client.ts";

export class ProviderSetupInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderSetupInvalid";
  }
}

interface HermesProviderRow {
  slug?: unknown;
  name?: unknown;
  models?: unknown;
  authenticated?: unknown;
}

interface HermesModelOptions {
  providers?: unknown;
}

interface HermesEnvField {
  is_set?: unknown;
  description?: unknown;
  url?: unknown;
  is_password?: unknown;
  advanced?: unknown;
  provider?: unknown;
  provider_label?: unknown;
  channel_managed?: unknown;
}

interface HermesOAuthStatus {
  logged_in?: unknown;
}

interface HermesOAuthProvider {
  id?: unknown;
  name?: unknown;
  flow?: unknown;
  cli_command?: unknown;
  docs_url?: unknown;
  status?: unknown;
}

interface HermesOAuthCatalog {
  providers?: unknown;
}

interface HermesOAuthStart {
  session_id?: unknown;
  flow?: unknown;
  auth_url?: unknown;
  verification_url?: unknown;
  user_code?: unknown;
  expires_in?: unknown;
  expires_at?: unknown;
  poll_interval?: unknown;
  status?: unknown;
  error_message?: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function profileQuery(name: string): string {
  return `profile=${encodeURIComponent(name)}`;
}

function fieldLabel(key: string): string {
  const known: Record<string, string> = {
    AWS_PROFILE: "AWS profile",
    AWS_REGION: "AWS region",
    VERTEX_CREDENTIALS_PATH: "Credentials file",
  };
  if (known[key]) return known[key];
  if (key.endsWith("_BASE_URL") || key.endsWith("_URL")) return "Base URL";
  if (key.endsWith("_API_KEY")) return "API key";
  if (key.endsWith("_TOKEN")) return "Access token";
  return key.toLowerCase().split("_").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

function fieldsByProvider(raw: unknown): Map<string, BotModelProviderSetupField[]> {
  const groups = new Map<string, BotModelProviderSetupField[]>();
  const rows = record(raw) ?? {};
  for (const [key, value] of Object.entries(rows)) {
    const row = record(value) as HermesEnvField | undefined;
    const provider = text(row?.provider);
    if (!provider || row?.channel_managed === true) continue;
    const field: BotModelProviderSetupField = {
      key,
      label: fieldLabel(key),
      secret: row?.is_password === true,
      advanced: row?.advanced === true,
      isSet: row?.is_set === true,
      ...(text(row?.url) ? { helpUrl: text(row?.url)! } : {}),
    };
    groups.set(provider, [...(groups.get(provider) ?? []), field]);
  }
  return groups;
}

function oauthByProvider(raw: unknown): Map<string, HermesOAuthProvider> {
  const rows = Array.isArray((raw as HermesOAuthCatalog | undefined)?.providers)
    ? (raw as HermesOAuthCatalog).providers as unknown[]
    : [];
  return new Map(rows.flatMap((value) => {
    const row = record(value) as HermesOAuthProvider | undefined;
    const id = text(row?.id);
    return id ? [[id, row!] as const] : [];
  }));
}

function oauthMethod(row: HermesOAuthProvider): BotModelProviderSetupMethod | undefined {
  const flow = text(row.flow);
  const status = record(row.status) as HermesOAuthStatus | undefined;
  const common = {
    id: "account",
    label: "Account",
    connected: status?.logged_in === true,
    ...(text(row.docs_url) ? { helpUrl: text(row.docs_url)! } : {}),
  };
  if (flow === "pkce" || flow === "device_code") {
    return { ...common, kind: "oauth", flow };
  }
  if (flow === "external" && text(row.cli_command)) {
    return { ...common, kind: "external", command: text(row.cli_command)! };
  }
  return undefined;
}

export async function readProviderSetupCatalog(
  client: HermesClient,
  name: string,
  now: () => number = Date.now,
): Promise<BotModelProviderSetupCatalog> {
  const query = profileQuery(name);
  const [options, env, oauth] = await Promise.all([
    client.dashboardJson<HermesModelOptions>(`/api/model/options?${query}&include_unconfigured=1`),
    client.dashboardJson<unknown>(`/api/env?${query}`),
    client.dashboardJson<HermesOAuthCatalog>(`/api/providers/oauth?${query}`),
  ]);
  const fields = fieldsByProvider(env);
  const accounts = oauthByProvider(oauth);
  const rows = Array.isArray(options.providers) ? options.providers as unknown[] : [];
  const providers: BotModelProviderSetup[] = rows.flatMap((value) => {
    const row = record(value) as HermesProviderRow | undefined;
    const slug = text(row?.slug);
    if (!slug) return [];
    const setupFields = fields.get(slug) ?? [];
    const methods: BotModelProviderSetupMethod[] = [];
    if (setupFields.length > 0) {
      methods.push({
        id: "fields",
        kind: "fields",
        label: setupFields.some((field) => field.secret) ? "API key" : "Configuration",
        connected: setupFields.some((field) => field.isSet),
        fields: setupFields,
      });
    }
    const account = accounts.get(slug);
    const accountMethod = account ? oauthMethod(account) : undefined;
    if (accountMethod) methods.push(accountMethod);
    const models = Array.isArray(row?.models) ? row.models : [];
    return [{
      slug,
      name: text(row?.name) ?? slug,
      authenticated: row?.authenticated === true || methods.some((method) => method.connected),
      modelCount: models.length,
      methods,
    }];
  });
  return { providers, updatedAt: now() };
}

async function setupField(
  client: HermesClient,
  name: string,
  provider: string,
  field: string,
): Promise<BotModelProviderSetupField> {
  const catalog = await readProviderSetupCatalog(client, name);
  const row = catalog.providers.find((candidate) => candidate.slug === provider);
  const match = row?.methods.flatMap((method) => method.fields ?? []).find((candidate) => candidate.key === field);
  if (!row) throw new ProviderSetupInvalid(`unknown model provider: ${provider}`);
  if (!match) throw new ProviderSetupInvalid(`${field} is not a setup field for ${provider}`);
  return match;
}

export async function writeProviderSetupField(
  client: HermesClient,
  name: string,
  provider: string,
  field: string,
  value: string,
): Promise<BotModelProviderSetupCatalog> {
  await setupField(client, name, provider, field);
  await client.dashboardJson(`/api/env?${profileQuery(name)}`, {
    method: "PUT",
    body: { key: field, value },
  });
  return readProviderSetupCatalog(client, name);
}

export async function deleteProviderSetupField(
  client: HermesClient,
  name: string,
  provider: string,
  field: string,
): Promise<BotModelProviderSetupCatalog> {
  await setupField(client, name, provider, field);
  await client.dashboardJson(`/api/env?${profileQuery(name)}`, {
    method: "DELETE",
    body: { key: field },
  });
  return readProviderSetupCatalog(client, name);
}

async function oauthSetupMethod(
  client: HermesClient,
  name: string,
  provider: string,
): Promise<BotModelProviderSetupMethod> {
  // OAuth polling can run every two seconds. Read only Hermes' OAuth catalog here; the full setup
  // catalog also probes model options and env metadata and would turn one poll into four requests.
  const raw = await client.dashboardJson<HermesOAuthCatalog>(
    `/api/providers/oauth?${profileQuery(name)}`,
  );
  const row = oauthByProvider(raw).get(provider);
  const method = row ? oauthMethod(row) : undefined;
  if (!row) throw new ProviderSetupInvalid(`unknown model provider: ${provider}`);
  if (!method || !method.flow) throw new ProviderSetupInvalid(`${provider} has no in-app account setup`);
  return method;
}

function epochMilliseconds(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.round(value < 10_000_000_000 ? value * 1_000 : value);
}

function oauthStatus(value: unknown): BotModelProviderOAuthSession["status"] {
  if (value === undefined || value === "pending") return "pending";
  return value === "approved" || value === "expired" || value === "error" ? value : "error";
}

function normalizeOAuthSession(
  provider: string,
  flow: "pkce" | "device_code",
  raw: HermesOAuthStart,
  sessionId?: string,
  now: () => number = Date.now,
): BotModelProviderOAuthSession {
  const id = text(raw.session_id) ?? sessionId;
  if (!id) throw new ProviderSetupInvalid("Hermes returned an OAuth session without an id");
  const expiresIn = typeof raw.expires_in === "number" && Number.isFinite(raw.expires_in)
    ? Math.max(0, raw.expires_in) * 1_000
    : undefined;
  const pollInterval = typeof raw.poll_interval === "number" && Number.isFinite(raw.poll_interval)
    ? Math.max(250, Math.round(raw.poll_interval * 1_000))
    : undefined;
  const absoluteExpiry = epochMilliseconds(raw.expires_at)
    ?? (expiresIn === undefined ? undefined : now() + expiresIn);
  return {
    provider,
    sessionId: id,
    flow,
    status: oauthStatus(raw.status),
    ...(text(raw.auth_url) || text(raw.verification_url)
      ? { authorizationUrl: text(raw.auth_url) ?? text(raw.verification_url)! }
      : {}),
    ...(text(raw.user_code) ? { userCode: text(raw.user_code)! } : {}),
    ...(absoluteExpiry === undefined ? {} : { expiresAt: absoluteExpiry }),
    ...(pollInterval === undefined ? {} : { pollIntervalMs: pollInterval }),
    ...(text(raw.error_message) ? { error: text(raw.error_message)! } : {}),
  };
}

export async function startProviderOAuth(
  client: HermesClient,
  name: string,
  provider: string,
): Promise<BotModelProviderOAuthSession> {
  const method = await oauthSetupMethod(client, name, provider);
  const raw = await client.dashboardJson<HermesOAuthStart>(
    `/api/providers/oauth/${encodeURIComponent(provider)}/start?${profileQuery(name)}`,
    { method: "POST" },
  );
  return normalizeOAuthSession(provider, method.flow!, raw);
}

export async function pollProviderOAuth(
  client: HermesClient,
  name: string,
  provider: string,
  sessionId: string,
): Promise<BotModelProviderOAuthSession> {
  const method = await oauthSetupMethod(client, name, provider);
  const raw = await client.dashboardJson<HermesOAuthStart>(
    `/api/providers/oauth/${encodeURIComponent(provider)}/poll/${encodeURIComponent(sessionId)}?${profileQuery(name)}`,
  );
  return normalizeOAuthSession(provider, method.flow!, raw, sessionId);
}

export async function submitProviderOAuthCode(
  client: HermesClient,
  name: string,
  provider: string,
  sessionId: string,
  code: string,
): Promise<BotModelProviderOAuthSession> {
  const method = await oauthSetupMethod(client, name, provider);
  if (method.flow !== "pkce") throw new ProviderSetupInvalid(`${provider} does not accept an authorization code`);
  const raw = await client.dashboardJson<HermesOAuthStart>(
    `/api/providers/oauth/${encodeURIComponent(provider)}/submit?${profileQuery(name)}`,
    { method: "POST", body: { session_id: sessionId, code } },
  );
  return normalizeOAuthSession(provider, method.flow, raw, sessionId);
}

export async function cancelProviderOAuth(
  client: HermesClient,
  name: string,
  provider: string,
  sessionId: string,
): Promise<void> {
  await oauthSetupMethod(client, name, provider);
  await client.dashboardJson(
    `/api/providers/oauth/sessions/${encodeURIComponent(sessionId)}?${profileQuery(name)}`,
    { method: "DELETE" },
  );
}
