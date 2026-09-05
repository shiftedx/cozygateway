import { Type, type Static } from "@sinclair/typebox";

export const PROVIDER_CONNECTIONS_CAPABILITY_ID = "com.cozylabs.provider-connections";
export const PROVIDER_CONNECTIONS_CAPABILITY_VERSION = 1;
const Text = (maximum: number) => Type.String({ minLength: 1, maxLength: maximum, pattern: "^[^\\u0000-\\u001f\\u007f]+$" });
export const ModelProviderConnectionIdSchema = Type.String({ pattern: "^custom-[a-f0-9-]{36}$", maxLength: 43 });
export const ModelProviderConnectionSchema = Type.Object({
  id: ModelProviderConnectionIdSchema,
  name: Text(120),
  baseUrl: Text(2048),
  hasApiKey: Type.Boolean(),
  models: Type.Array(Text(200), { maxItems: 1000, uniqueItems: true }),
  manualModels: Type.Array(Text(200), { maxItems: 1000, uniqueItems: true }),
  status: Type.Union([Type.Literal("unchecked"), Type.Literal("connected"), Type.Literal("unreachable")]),
  lastCheckedAt: Type.Optional(Type.Integer({ minimum: 0 })),
}, { additionalProperties: false });
export type ModelProviderConnection = Static<typeof ModelProviderConnectionSchema>;

export const ModelProviderConnectionCatalogSchema = Type.Object({
  connections: Type.Array(ModelProviderConnectionSchema, { maxItems: 100 }),
}, { additionalProperties: false });
export type ModelProviderConnectionCatalog = Static<typeof ModelProviderConnectionCatalogSchema>;

/** Paired HTTP request only. This schema must never be embedded in attach/runner durable frames. */
export const ModelProviderConnectionInputSchema = Type.Object({
  id: Type.Optional(ModelProviderConnectionIdSchema),
  name: Text(120),
  baseUrl: Text(2048),
  apiKey: Type.Optional(Type.Union([Text(8192), Type.Null()])),
  manualModels: Type.Optional(Type.Array(Text(200), { maxItems: 1000, uniqueItems: true })),
}, { additionalProperties: false });
export type ModelProviderConnectionInput = Static<typeof ModelProviderConnectionInputSchema>;
