import { type Static, Type } from "@sinclair/typebox";

const ProfileSettingSchema = Type.Object({
  tokenEnv: Type.String({ minLength: 1 }),
  name: Type.Optional(Type.String({ minLength: 1 })),
  avatar: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

/** Device-editable Hermes connection metadata. Fields name secret-bearing environment variables;
 * credential values are deliberately not representable on this wire. */
export const HermesEndpointSettingSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 48, pattern: "^[a-z0-9][a-z0-9_-]*$" }),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  url: Type.String({ minLength: 1 }),
  authMode: Type.Optional(Type.Union([Type.Literal("token"), Type.Literal("password")])),
  tokenEnv: Type.Optional(Type.String({ minLength: 1 })),
  authParam: Type.Optional(Type.Union([Type.Literal("token"), Type.Literal("ticket")])),
  username: Type.Optional(Type.String({ minLength: 1 })),
  passwordEnv: Type.Optional(Type.String({ minLength: 1 })),
  provider: Type.Optional(Type.String({ minLength: 1 })),
  baseUrl: Type.Optional(Type.String({ minLength: 1 })),
  hiddenProfiles: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  profile: Type.Optional(Type.String({ minLength: 1 })),
  seedBlankSlateBots: Type.Optional(Type.Boolean()),
  blankSlateSkillsOn: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  chatSuggestion: Type.Optional(Type.String()),
  profiles: Type.Record(Type.String({ minLength: 1 }), ProfileSettingSchema, { minProperties: 1 }),
}, { additionalProperties: false });
export type HermesEndpointSetting = Static<typeof HermesEndpointSettingSchema>;

export const GatewaySettingsSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  hermesEndpoints: Type.Array(HermesEndpointSettingSchema, { minItems: 1, maxItems: 32 }),
}, { additionalProperties: false });
export type GatewaySettings = Static<typeof GatewaySettingsSchema>;

export const GatewaySettingsUpdateResponseSchema = Type.Composite([
  GatewaySettingsSchema,
  Type.Object({ restartRequired: Type.Boolean() }),
]);
export type GatewaySettingsUpdateResponse = Static<typeof GatewaySettingsUpdateResponseSchema>;

export const GATEWAY_MANAGEMENT_CAPABILITY_ID = "com.cozylabs.gateway-management";
export const GATEWAY_MANAGEMENT_CAPABILITY_VERSION = 1;
