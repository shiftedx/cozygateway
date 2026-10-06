import { createDecipheriv, hkdfSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { PUSH_HKDF_INFO, derivePushKey, encryptPushPayload } from "../src/push-crypto.ts";

/** Independent decrypt per contract/push-v0.md; intentionally does NOT reuse push-crypto. */
function independentDecrypt(pushKey: string, wire: string): unknown {
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(pushKey, "utf8"),
      Buffer.alloc(0),
      Buffer.from("cozygateway-push-v0", "utf8"),
      32,
    ),
  );
  const raw = Buffer.from(wire, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  const plain = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}

describe("push crypto", () => {
  it("locks the contract/push-v0.md test vector byte for byte", () => {
    expect(PUSH_HKDF_INFO).toBe("cozygateway-push-v0");
    expect(derivePushKey("test-push-key").toString("hex")).toBe(
      "ace1356ac7fe54a993c093cfb02c7c6d6a9c794e8c9076bb6b0281554d263b62",
    );
    const nonce = Buffer.from("000102030405060708090a0b", "hex");
    const wire = encryptPushPayload(
      "test-push-key",
      { threadId: "thread-1", agentName: "Demo Agent", preview: "Hello from the gateway" },
      nonce,
    );
    expect(wire).toBe(
      "AAECAwQFBgcICQoLMrMUvL7D5rFU23RVzVcbk38hMFVss1lpguc9A19Wm_dPzGpMwOApxowgZnc2o8Wepd6ttbU_8eDcAhYjIc5nODOJdRkk5pIMpd03K5pLkuZueeDWqN0CPhDLSJia_AlAH2ZM",
    );
  });

  it("round-trips through an independent decrypt with a random nonce", () => {
    const payload = { threadId: "t9", agentName: "Agent", preview: "hi there" };
    const wire = encryptPushPayload("another key, any string works", payload);
    expect(independentDecrypt("another key, any string works", wire)).toEqual(payload);
  });

  it("produces a fresh nonce per call", () => {
    const payload = { threadId: "t", agentName: "A", preview: "p" };
    expect(encryptPushPayload("k", payload)).not.toBe(encryptPushPayload("k", payload));
  });

  it("fails to decrypt under the wrong key (tag mismatch)", () => {
    const wire = encryptPushPayload("right-key", { threadId: "t", agentName: "A", preview: "p" });
    expect(() => independentDecrypt("wrong-key", wire)).toThrow();
  });
});
