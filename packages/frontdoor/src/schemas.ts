import { Type, type Static } from "@sinclair/typebox";

export const ProvisionResponse = Type.Object({
  householdId: Type.String(),
  credential: Type.String(),
  hostname: Type.String(),
  protocol: Type.Literal("frontdoor-v0"),
});
export type ProvisionResponseT = Static<typeof ProvisionResponse>;

export function errorBody(code: string, message: string) {
  return { error: { code, message } };
}
