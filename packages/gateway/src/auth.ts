import { createHash, randomBytes } from "node:crypto";

export const SETUP_CODE_TTL_MS = 10 * 60 * 1000;

/** Unambiguous alphabet (no 0/O/1/I) for codes a human may need to type. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function newSetupCode(): string {
  const bytes = randomBytes(8);
  let code = "";
  for (let i = 0; i < 8; i++) {
    if (i === 4) code += "-";
    code += CODE_ALPHABET[(bytes[i] ?? 0) % CODE_ALPHABET.length];
  }
  return code;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function mintDeviceToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}
