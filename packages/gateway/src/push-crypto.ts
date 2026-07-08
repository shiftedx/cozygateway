import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";

/** HKDF info string, fixed by contract/push-v0.md. */
export const PUSH_HKDF_INFO = "cozygateway-push-v0";

export interface PushPayload {
  threadId: string;
  agentName: string;
  preview: string;
}

/** Contract v1 froze pushKey as ANY minLength-1 string, so the AES key is derived rather
 *  than decoded: HKDF-SHA256(ikm = utf8(pushKey), salt = empty, info = PUSH_HKDF_INFO, 32). */
export function derivePushKey(pushKey: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(pushKey, "utf8"), Buffer.alloc(0), Buffer.from(PUSH_HKDF_INFO, "utf8"), 32),
  );
}

/** base64url(nonce(12) || ciphertext || tag(16)) per contract/push-v0.md. The nonce
 *  parameter exists for the contract test vector; production callers omit it. */
export function encryptPushPayload(pushKey: string, payload: PushPayload, nonce: Buffer = randomBytes(12)): string {
  const key = derivePushKey(pushKey);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString("base64url");
}
