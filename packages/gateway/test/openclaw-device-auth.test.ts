import { verify } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  type DeviceIdentity,
  type SignChallengeInput,
  buildAuthPayloadV3,
  generateDeviceIdentity,
  importDevicePublicKey,
  signChallenge,
} from "../src/adapters/openclaw/device-auth.ts";

function baseInput(identity: DeviceIdentity, nonce: string): SignChallengeInput {
  return {
    identity,
    nonce,
    token: "secret-token",
    role: "operator",
    scopes: ["operator.read", "operator.write"],
    platform: "server",
  };
}

describe("generateDeviceIdentity", () => {
  it("returns a random id and distinct base64-encoded Ed25519 keys across calls", () => {
    const a = generateDeviceIdentity();
    const b = generateDeviceIdentity();

    expect(a.id).not.toBe(b.id);
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.privateKey).not.toBe(b.privateKey);
    expect(a.publicKey).not.toBe(a.privateKey);

    // Every field is valid, non-empty base64.
    for (const value of [a.id, a.publicKey, a.privateKey, b.publicKey, b.privateKey]) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
    expect(Buffer.from(a.publicKey, "base64").length).toBeGreaterThan(0);
    expect(Buffer.from(a.privateKey, "base64").length).toBeGreaterThan(0);
  });
});

describe("signChallenge", () => {
  it("is deterministic for a fixed identity and nonce", () => {
    const identity = generateDeviceIdentity();
    const input = baseInput(identity, "nonce-fixed");

    const first = signChallenge(input);
    const second = signChallenge(input);

    expect(first.signature).toBe(second.signature);
    expect(first.nonce).toBe("nonce-fixed");
    expect(second.nonce).toBe("nonce-fixed");
  });

  it("produces a signature that verifies against the device public key reconstructed from its stored base64 form", () => {
    const identity = generateDeviceIdentity();
    const input = baseInput(identity, "nonce-verify");

    const result = signChallenge(input);

    // Rebuild everything from data that crossed a serialization boundary (base64 strings),
    // never reusing an in-memory KeyObject from generateDeviceIdentity.
    const publicKeyObject = importDevicePublicKey(identity.publicKey);
    const payloadBytes = Buffer.from(buildAuthPayloadV3(input));
    const signatureBytes = Buffer.from(result.signature, "base64");

    expect(verify(null, payloadBytes, publicKeyObject, signatureBytes)).toBe(true);
  });

  it("rejects a signature verified against a different device's public key", () => {
    const identity = generateDeviceIdentity();
    const otherIdentity = generateDeviceIdentity();
    const input = baseInput(identity, "nonce-mismatch");

    const result = signChallenge(input);
    const wrongPublicKey = importDevicePublicKey(otherIdentity.publicKey);
    const payloadBytes = Buffer.from(buildAuthPayloadV3(input));
    const signatureBytes = Buffer.from(result.signature, "base64");

    expect(verify(null, payloadBytes, wrongPublicKey, signatureBytes)).toBe(false);
  });

  it("changes the signature when the nonce changes", () => {
    const identity = generateDeviceIdentity();
    const a = signChallenge(baseInput(identity, "nonce-a"));
    const b = signChallenge(baseInput(identity, "nonce-b"));

    expect(a.signature).not.toBe(b.signature);
  });

  it("throws on an empty nonce", () => {
    const identity = generateDeviceIdentity();
    expect(() => signChallenge(baseInput(identity, ""))).toThrow();
  });

  it("throws on a missing nonce", () => {
    const identity = generateDeviceIdentity();
    const input = baseInput(identity, "placeholder") as unknown as Record<string, unknown>;
    delete input.nonce;
    expect(() => signChallenge(input as unknown as SignChallengeInput)).toThrow();
  });

  it("returns a numeric signedAt timestamp close to now", () => {
    const identity = generateDeviceIdentity();
    const before = Date.now();
    const result = signChallenge(baseInput(identity, "nonce-time"));
    const after = Date.now();

    expect(typeof result.signedAt).toBe("number");
    expect(result.signedAt).toBeGreaterThanOrEqual(before);
    expect(result.signedAt).toBeLessThanOrEqual(after);
  });
});
