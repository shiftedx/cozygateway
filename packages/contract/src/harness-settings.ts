import { type Static, Type } from "@sinclair/typebox";

export const HarnessVendorSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  logoAsset: Type.String({ minLength: 1 }),
  logoSourceUrl: Type.Optional(Type.String({ minLength: 1 })),
});
export type HarnessVendor = Static<typeof HarnessVendorSchema>;

export const HarnessConfigurationScopeSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
});
export type HarnessConfigurationScope = Static<typeof HarnessConfigurationScopeSchema>;

export const GatewayHarnessSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  label: Type.Optional(Type.String({ minLength: 1 })),
  vendor: HarnessVendorSchema,
  scopes: Type.Array(HarnessConfigurationScopeSchema),
});
export type GatewayHarness = Static<typeof GatewayHarnessSchema>;

export const GatewayHarnessCatalogSchema = Type.Object({
  harnesses: Type.Array(GatewayHarnessSchema),
  updatedAt: Type.Integer(),
});
export type GatewayHarnessCatalog = Static<typeof GatewayHarnessCatalogSchema>;

export const HARNESS_SETTINGS_CAPABILITY_ID = "com.cozylabs.harness-settings";
export const HARNESS_SETTINGS_CAPABILITY_VERSION = 1;
