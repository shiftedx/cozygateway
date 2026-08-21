import { createHash, randomBytes } from "node:crypto";

export function newHouseholdId(): string {
  return "hh_" + randomBytes(6).toString("hex");
}

export function newCredential(): string {
  return "fdc_" + randomBytes(24).toString("hex");
}

export function credentialHash(credential: string): string {
  return createHash("sha256").update(credential).digest("hex");
}
