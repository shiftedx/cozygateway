import { type Static, Type } from "@sinclair/typebox";

/** A harness-owned provider field. Credential values never cross back over this wire. */
export const ModelProviderSetupFieldSchema = Type.Object({
  key: Type.String({ minLength: 1 }),
  label: Type.String({ minLength: 1 }),
  secret: Type.Boolean(),
  advanced: Type.Boolean(),
  isSet: Type.Boolean(),
  /** Present only when the harness explicitly returned a non-secret editable value. */
  value: Type.Optional(Type.String({ maxLength: 65_536 })),
  helpUrl: Type.Optional(Type.String()),
});
export type ModelProviderSetupField = Static<typeof ModelProviderSetupFieldSchema>;

export const ModelProviderSetupMethodSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  kind: Type.Union([Type.Literal("fields"), Type.Literal("oauth"), Type.Literal("external")]),
  label: Type.String({ minLength: 1 }),
  connected: Type.Boolean(),
  fields: Type.Optional(Type.Array(ModelProviderSetupFieldSchema)),
  flow: Type.Optional(Type.Union([Type.Literal("pkce"), Type.Literal("device_code")])),
  command: Type.Optional(Type.String({ minLength: 1 })),
  helpUrl: Type.Optional(Type.String()),
});
export type ModelProviderSetupMethod = Static<typeof ModelProviderSetupMethodSchema>;

export const ModelProviderSetupSchema = Type.Object({
  slug: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  authenticated: Type.Boolean(),
  /** Harness model ids currently available from this provider, in harness order. */
  models: Type.Array(Type.String({ minLength: 1 })),
  modelCount: Type.Integer({ minimum: 0 }),
  methods: Type.Array(ModelProviderSetupMethodSchema),
});
export type ModelProviderSetup = Static<typeof ModelProviderSetupSchema>;

export const ModelProviderSetupCatalogSchema = Type.Object({
  providers: Type.Array(ModelProviderSetupSchema),
  updatedAt: Type.Integer(),
});
export type ModelProviderSetupCatalog = Static<typeof ModelProviderSetupCatalogSchema>;

export const ModelProviderFieldUpdateSchema = Type.Object({
  value: Type.String({ minLength: 1, maxLength: 65_536 }),
});
export type ModelProviderFieldUpdate = Static<typeof ModelProviderFieldUpdateSchema>;

export const ModelProviderOAuthSessionSchema = Type.Object({
  provider: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  flow: Type.Union([Type.Literal("pkce"), Type.Literal("device_code")]),
  status: Type.Union([
    Type.Literal("pending"), Type.Literal("approved"), Type.Literal("expired"), Type.Literal("error"),
  ]),
  authorizationUrl: Type.Optional(Type.String({ minLength: 1 })),
  userCode: Type.Optional(Type.String({ minLength: 1 })),
  expiresAt: Type.Optional(Type.Integer()),
  pollIntervalMs: Type.Optional(Type.Integer({ minimum: 250 })),
  error: Type.Optional(Type.String()),
});
export type ModelProviderOAuthSession = Static<typeof ModelProviderOAuthSessionSchema>;

export const ModelProviderOAuthCodeSchema = Type.Object({
  code: Type.String({ minLength: 1, maxLength: 8_192 }),
});
export type ModelProviderOAuthCode = Static<typeof ModelProviderOAuthCodeSchema>;
