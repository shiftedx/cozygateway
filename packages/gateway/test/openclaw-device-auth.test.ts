import { createHash, verify } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  type DeviceIdentity,
  type SignChallengeInput,
  buildAuthPayloadV3,
  decodeSignature,
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
    clientId: "gateway-client",
    clientMode: "backend",
    platform: "server",
    deviceFamily: "server",
  };
}

const FIXED_NOW = () => 1783000000000;

describe("generateDeviceIdentity", () => {
  it("returns distinct wire-form Ed25519 identities across calls", () => {
    const a = generateDeviceIdentity();
    const b = generateDeviceIdentity();

    expect(a.id).not.toBe(b.id);
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.privateKey).not.toBe(b.privateKey);
    expect(a.publicKey).not.toBe(a.privateKey);

    for (const value of [a.id, a.publicKey, a.privateKey, b.publicKey, b.privateKey]) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it("derives id as sha256(rawPublicKeyBytes) hex and publicKey as base64url of the raw key", () => {
    const identity = generateDeviceIdentity();
    // publicKey is base64url of the raw 32-byte key.
    const raw = Buffer.from(identity.publicKey.replaceAll("-", "+").replaceAll("_", "/"), "base64");
    expect(raw.length).toBe(32);
    // id is the sha256 of exactly those raw bytes, as the gateway derives it.
    expect(identity.id).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(identity.id).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("buildAuthPayloadV3 parity", () => {
  // Frozen cross-implementation vector generated from OpenClaw's OWN buildDeviceAuthPayloadV3 +
  // deriveDeviceIdFromPublicKey (seed = 32 bytes of 0x07); verifyDeviceSignature returned true.
  // See docs/specs/2026-07-08-openclaw-wire-study.md.
  const seed = Buffer.alloc(32, 7);
  const privateKeyDerB64 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]).toString(
    "base64",
  );
  const identity: DeviceIdentity = {
    id: "fe812c12f3ab4ce6ac5db69ac352f906cb1b11ef43fb33e252ef7ff552263889",
    publicKey: "6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw",
    privateKey: privateKeyDerB64,
  };
  const input: SignChallengeInput = {
    identity,
    nonce: "fixed-nonce-abc123",
    token: "example-operator-token",
    role: "operator",
    scopes: ["operator.read", "operator.write"],
    clientId: "gateway-client",
    clientMode: "backend",
    platform: "server",
    deviceFamily: "server",
  };

  it("matches the byte-exact payload OpenClaw's builder produces", () => {
    expect(buildAuthPayloadV3(input, 1783000000000)).toBe(
      "v3|fe812c12f3ab4ce6ac5db69ac352f906cb1b11ef43fb33e252ef7ff552263889|gateway-client|backend|operator|operator.read,operator.write|1783000000000|example-operator-token|fixed-nonce-abc123|server|server",
    );
  });

  it("signs a base64url signature that verifies against the frozen public key", () => {
    const result = signChallenge(input, () => 1783000000000);
    const pub = importDevicePublicKey(identity.publicKey);
    expect(verify(null, Buffer.from(buildAuthPayloadV3(input, 1783000000000)), pub, decodeSignature(result.signature))).toBe(
      true,
    );
  });

  it("normalizes platform and deviceFamily (trim + lowercase) into the payload", () => {
    const payload = buildAuthPayloadV3({ ...input, platform: " Server ", deviceFamily: "SERVER" }, 1783000000000);
    expect(payload.endsWith("|server|server")).toBe(true);
  });
});

describe("signChallenge", () => {
  it("is deterministic for a fixed identity, nonce, and clock", () => {
    const identity = generateDeviceIdentity();
    const input = baseInput(identity, "nonce-fixed");

    const first = signChallenge(input, FIXED_NOW);
    const second = signChallenge(input, FIXED_NOW);

    expect(first.signature).toBe(second.signature);
    expect(first.signedAt).toBe(1783000000000);
    expect(first.nonce).toBe("nonce-fixed");
  });

  it("produces a base64url signature that verifies against the reconstructed public key", () => {
    const identity = generateDeviceIdentity();
    const input = baseInput(identity, "nonce-verify");

    const result = signChallenge(input, FIXED_NOW);

    const publicKeyObject = importDevicePublicKey(identity.publicKey);
    const payloadBytes = Buffer.from(buildAuthPayloadV3(input, result.signedAt));
    expect(verify(null, payloadBytes, publicKeyObject, decodeSignature(result.signature))).toBe(true);
  });

  it("rejects a signature verified against a different device's public key", () => {
    const identity = generateDeviceIdentity();
    const otherIdentity = generateDeviceIdentity();
    const input = baseInput(identity, "nonce-mismatch");

    const result = signChallenge(input, FIXED_NOW);
    const wrongPublicKey = importDevicePublicKey(otherIdentity.publicKey);
    const payloadBytes = Buffer.from(buildAuthPayloadV3(input, result.signedAt));

    expect(verify(null, payloadBytes, wrongPublicKey, decodeSignature(result.signature))).toBe(false);
  });

  it("changes the signature when the nonce changes", () => {
    const identity = generateDeviceIdentity();
    const a = signChallenge(baseInput(identity, "nonce-a"), FIXED_NOW);
    const b = signChallenge(baseInput(identity, "nonce-b"), FIXED_NOW);

    expect(a.signature).not.toBe(b.signature);
  });

  it("changes the signature when the signed-at clock changes (signedAt is signed)", () => {
    const identity = generateDeviceIdentity();
    const a = signChallenge(baseInput(identity, "nonce-clock"), () => 1783000000000);
    const b = signChallenge(baseInput(identity, "nonce-clock"), () => 1783000000001);

    expect(a.signature).not.toBe(b.signature);
    expect(a.signedAt).not.toBe(b.signedAt);
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

  it("returns a numeric signedAt close to now by default", () => {
    const identity = generateDeviceIdentity();
    const before = Date.now();
    const result = signChallenge(baseInput(identity, "nonce-time"));
    const after = Date.now();

    expect(typeof result.signedAt).toBe("number");
    expect(result.signedAt).toBeGreaterThanOrEqual(before);
    expect(result.signedAt).toBeLessThanOrEqual(after);
  });
});
