import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";

/** OpenClaw device-auth challenge signing (docs.openclaw.ai/gateway/protocol). Token-only
 *  operator auth requires the server to opt in via an explicit trust path (`allowInsecureAuth`
 *  or a trusted-proxy allowlist); the general path instead requires the client to answer a
 *  `connect.challenge` nonce by signing it with a per-client device keypair. This module owns
 *  device-identity generation and challenge signing. The token is a root secret: it flows into
 *  the signed payload but neither the token, the payload bytes, nor the signature bytes are ever
 *  logged by this module.
 *
 *  The exact byte construction here was pinned by the Task 8 live wire study
 *  (docs/specs/2026-07-08-openclaw-wire-study.md) against a real OpenClaw gateway
 *  (openclaw@2026.6.11) and cross-checked against its shipped `buildDeviceAuthPayloadV3` /
 *  `deriveDeviceIdFromPublicKey` builders; see the frozen parity vector in the device-auth test. */

/** Standard 12-byte SPKI DER prefix for an Ed25519 public key, followed by the raw 32-byte key.
 *  The OpenClaw wire carries `device.publicKey` as base64url of the raw key only, so we strip this
 *  prefix on the way out and re-prepend it to reconstruct a `KeyObject` on the way in. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

/** Trim then lowercase, matching OpenClaw's `normalizeDeviceMetadataForAuth`: the server applies
 *  the same normalization to `client.platform`/`client.deviceFamily` before rebuilding the payload
 *  to verify, so the signed bytes must use the normalized form or the signature will not verify. */
function normalizeMetadata(value: string): string {
  return value.trim().replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32));
}

export interface DeviceIdentity {
  /** `sha256(rawEd25519PublicKeyBytes)` as lowercase hex; the server derives and cross-checks
   *  this from `publicKey`, so it is NOT free-form. */
  id: string;
  /** base64url of the raw 32-byte Ed25519 public key (the OpenClaw wire form). */
  publicKey: string;
  /** base64 of the PKCS8 DER private key; kept only to sign challenges, never sent. */
  privateKey: string;
}

/** Generates a fresh Ed25519 device identity in the OpenClaw wire form: `publicKey` is base64url
 *  of the raw 32-byte key (SPKI DER minus the fixed 12-byte prefix) and `id` is the sha256 of
 *  those raw bytes as hex, exactly as the gateway derives it from the presented key. The private
 *  key is stored as base64 PKCS8 DER for signing and never crosses the wire. */
export function generateDeviceIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const raw = spki.subarray(spki.length - 32);
  return {
    id: createHash("sha256").update(raw).digest("hex"),
    publicKey: base64UrlEncode(Buffer.from(raw)),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
}

export interface SignChallengeInput {
  identity: DeviceIdentity;
  nonce: string;
  token: string;
  role: string;
  scopes: string[];
  /** The connect frame's `client.id` (e.g. "gateway-client"); the signature covers it. */
  clientId: string;
  /** The connect frame's `client.mode` (e.g. "backend"); the signature covers it. */
  clientMode: string;
  /** The connect frame's `client.platform`; normalized (trim + lowercase) before signing. */
  platform: string;
  /** The connect frame's `client.deviceFamily`; normalized (trim + lowercase) before signing. */
  deviceFamily: string;
}

export interface SignChallengeResult {
  signature: string;
  signedAt: number;
  nonce: string;
}

/** The ONE function pinning the exact byte construction of the OpenClaw v3 device-auth payload
 *  (`buildDeviceAuthPayloadV3`): a `|`-joined string of, in order, the fixed tag `v3`, the device
 *  id, the client id, the client mode, the requested role, the comma-joined scopes, the signed-at
 *  epoch millis (as a decimal string), the operator token, the challenge nonce, and the
 *  normalized platform and device-family. Verified live in Task 8; a frozen cross-implementation
 *  parity vector guards it in the device-auth test. Never logged; it embeds the token verbatim. */
export function buildAuthPayloadV3(input: SignChallengeInput, signedAtMs: number): string {
  return [
    "v3",
    input.identity.id,
    input.clientId,
    input.clientMode,
    input.role,
    input.scopes.join(","),
    String(signedAtMs),
    input.token,
    input.nonce,
    normalizeMetadata(input.platform),
    normalizeMetadata(input.deviceFamily),
  ].join("|");
}

/** Signs a `connect.challenge` nonce with the device's Ed25519 private key, producing the
 *  `device.signature`/`device.signedAt`/`device.nonce` fields consumed by `buildConnectRequest`.
 *  The `signedAt` returned is the SAME epoch-millis value signed into the payload; the gateway
 *  rejects it if it drifts more than 120s from server time. The signature is base64url, matching
 *  the wire's `device.signature` encoding.
 *
 *  The nonce MUST be non-empty. A real handshake only ever signs a nonce the server issued in a
 *  `connect.challenge` event; `buildConnectRequest` (protocol.ts) defaults a *missing* nonce to
 *  `""` for the token-only pre-challenge case, and that empty default must never reach a live
 *  sign, so this function refuses it rather than silently signing an empty-nonce payload. */
export function signChallenge(input: SignChallengeInput, now: () => number = Date.now): SignChallengeResult {
  if (!input.nonce) {
    throw new Error("signChallenge requires a non-empty nonce");
  }

  const signedAtMs = now();
  const payload = buildAuthPayloadV3(input, signedAtMs);
  const privateKey = createPrivateKey({
    key: Buffer.from(input.identity.privateKey, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const signature = sign(null, Buffer.from(payload), privateKey);

  return {
    signature: base64UrlEncode(signature),
    signedAt: signedAtMs,
    nonce: input.nonce,
  };
}

/** Reconstructs the public `KeyObject` from a `DeviceIdentity.publicKey` stored as base64url of
 *  the raw Ed25519 key, by re-prepending the fixed SPKI DER prefix. Callers (and tests) use it to
 *  `crypto.verify` a `signChallenge` result without holding any in-memory key material. */
export function importDevicePublicKey(publicKeyBase64Url: string) {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, base64UrlDecode(publicKeyBase64Url)]),
    format: "der",
    type: "spki",
  });
}

/** Decodes a base64url `device.signature` back to raw bytes for `crypto.verify`. */
export function decodeSignature(signatureBase64Url: string): Buffer {
  return base64UrlDecode(signatureBase64Url);
}
