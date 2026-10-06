import { type Static, Type } from "@sinclair/typebox";

/** Independent, Dashboard-backed MCP integration administration. This surface is advertised only
 * after the gateway has read the configured Hermes launch profile through the authenticated
 * Dashboard API. */
export const INTEGRATIONS_CAPABILITY_ID = "com.cozylabs.integrations";
export const INTEGRATIONS_CAPABILITY_VERSION = 1;

const Text = (maxLength: number) =>
  Type.String({ minLength: 1, maxLength, pattern: "^[^\u0000-\u001f\u007f]+$" });
const OptionalText = (maxLength: number) =>
  Type.Optional(Type.String({ minLength: 1, maxLength, pattern: "^[^\u0000-\u001f\u007f]+$" }));

export const IntegrationNameSchema = Text(120);
export type IntegrationName = Static<typeof IntegrationNameSchema>;

export const IntegrationAuthSchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("header"),
  Type.Literal("oauth"),
]);
export type IntegrationAuth = Static<typeof IntegrationAuthSchema>;

/** Safe projection only. It deliberately omits environment, bearer credentials, and OAuth state. */
export const IntegrationServerSchema = Type.Object({
  name: IntegrationNameSchema,
  url: OptionalText(2048),
  command: OptionalText(1024),
  args: Type.Array(Text(2048), { maxItems: 64 }),
  auth: IntegrationAuthSchema,
  enabled: Type.Boolean(),
}, { additionalProperties: false });
export type IntegrationServer = Static<typeof IntegrationServerSchema>;

const EnvironmentSchema = Type.Record(
  Text(128),
  Type.String({ maxLength: 8192, pattern: "^[^\u0000-\u001f\u007f]*$" }),
  { maxProperties: 64 },
);

/** Paired HTTP only: credential values must never enter durable frames or a response body. */
export const IntegrationCreateRequestSchema = Type.Object({
  name: IntegrationNameSchema,
  url: OptionalText(2048),
  command: OptionalText(1024),
  args: Type.Optional(Type.Array(Text(2048), { maxItems: 64 })),
  auth: IntegrationAuthSchema,
  bearerToken: Type.Optional(Type.String({ minLength: 1, maxLength: 8192, pattern: "^[^\u0000-\u001f\u007f]+$" })),
  environment: Type.Optional(EnvironmentSchema),
}, { additionalProperties: false });
export type IntegrationCreateRequest = Static<typeof IntegrationCreateRequestSchema>;

/** Omitting a field preserves its configured value. A bearer token or declared environment value
 * may be replaced only when the saved Dashboard definition already references that key; responses
 * remain redacted. */
export const IntegrationUpdateRequestSchema = Type.Object({
  url: OptionalText(2048),
  command: OptionalText(1024),
  args: Type.Optional(Type.Array(Text(2048), { maxItems: 64 })),
  auth: Type.Optional(IntegrationAuthSchema),
  bearerToken: Type.Optional(Type.String({ minLength: 1, maxLength: 8192, pattern: "^[^\u0000-\u001f\u007f]+$" })),
  environment: Type.Optional(EnvironmentSchema),
}, { additionalProperties: false });
export type IntegrationUpdateRequest = Static<typeof IntegrationUpdateRequestSchema>;

export const IntegrationCatalogSchema = Type.Object({
  servers: Type.Array(IntegrationServerSchema, { maxItems: 200 }),
}, { additionalProperties: false });
export type IntegrationCatalog = Static<typeof IntegrationCatalogSchema>;

export const IntegrationTestResultSchema = Type.Object({
  ok: Type.Boolean(),
  toolCount: Type.Integer({ minimum: 0, maximum: 10_000 }),
  error: Type.Optional(Text(512)),
}, { additionalProperties: false });
export type IntegrationTestResult = Static<typeof IntegrationTestResultSchema>;

export const IntegrationOAuthFlowSchema = Type.Object({
  flowId: Text(256),
  serverName: IntegrationNameSchema,
  status: Text(120),
  authorizationURL: Type.Optional(Type.String({ minLength: 1, maxLength: 2048, pattern: "^https://[^\u0000-\u001f\u007f]+$" })),
}, { additionalProperties: false });
export type IntegrationOAuthFlow = Static<typeof IntegrationOAuthFlowSchema>;

export const IntegrationEnabledRequestSchema = Type.Object({
  enabled: Type.Boolean(),
}, { additionalProperties: false });
export type IntegrationEnabledRequest = Static<typeof IntegrationEnabledRequestSchema>;

export const IntegrationCatalogEnvironmentSchema = Type.Object({
  name: Text(128),
  prompt: Type.Optional(Text(512)),
  required: Type.Boolean(),
}, { additionalProperties: false });
export type IntegrationCatalogEnvironment = Static<typeof IntegrationCatalogEnvironmentSchema>;

/** A catalog row is inspection data from Hermes' approved MCP manifests. It does not expose any
 * configured credential values. */
export const IntegrationCatalogEntrySchema = Type.Object({
  name: IntegrationNameSchema,
  description: Type.Optional(Text(1024)),
  transport: Type.Union([Type.Literal("http"), Type.Literal("stdio")]),
  auth: IntegrationAuthSchema,
  requiredEnvironment: Type.Array(IntegrationCatalogEnvironmentSchema, { maxItems: 64 }),
  url: OptionalText(2048),
  command: OptionalText(1024),
  args: Type.Array(Text(2048), { maxItems: 64 }),
  needsInstall: Type.Boolean(),
  installed: Type.Boolean(),
  enabled: Type.Boolean(),
}, { additionalProperties: false });
export type IntegrationCatalogEntry = Static<typeof IntegrationCatalogEntrySchema>;

export const IntegrationCatalogResponseSchema = Type.Object({
  entries: Type.Array(IntegrationCatalogEntrySchema, { maxItems: 200 }),
}, { additionalProperties: false });
export type IntegrationCatalogResponse = Static<typeof IntegrationCatalogResponseSchema>;

export const IntegrationCatalogInstallRequestSchema = Type.Object({
  environment: Type.Optional(EnvironmentSchema),
  enabled: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
export type IntegrationCatalogInstallRequest = Static<typeof IntegrationCatalogInstallRequestSchema>;

export const IntegrationCatalogInstallResponseSchema = Type.Object({
  ok: Type.Literal(true),
  name: IntegrationNameSchema,
  background: Type.Boolean(),
}, { additionalProperties: false });
export type IntegrationCatalogInstallResponse = Static<typeof IntegrationCatalogInstallResponseSchema>;
