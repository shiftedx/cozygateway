import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";

/** OpenClaw device-auth challenge signing (docs.openclaw.ai/gateway/protocol). Token-only
 *  operator auth requires the server to opt in via an explicit trust path (`allowInsecureAuth`
 *  or a trusted-proxy allowlist); the general path instead requires the client to answer a
 *  `connect.challenge` nonce by signing it with a per-client device keypair. This module owns
 *  device-identity generation and challenge signing. The token is a root secret: it flows into
 *  the signed payload but neither the token, the payload bytes, nor the signature bytes are ever
 *  logged by this module. */

export interface DeviceIdentity {
  id: string;
  publicKey: string;
  privateKey: string;
}

/** Generates a fresh Ed25519 device identity. Keys are exported as DER (SPKI for the public
 *  key, PKCS8 for the private key) then base64-encoded, so they round-trip through
 *  `createPublicKey`/`createPrivateKey` with `{ format: "der" }` without a PEM wrapper. `id` is
 *  a random UUID independent of the keypair; the wire protocol addresses devices by id. */
export function generateDeviceIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    id: randomUUID(),
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
}

export interface SignChallengeInput {
  identity: DeviceIdentity;
  nonce: string;
  token: string;
  role: string;
  scopes: string[];
  platform: string;
}

export interface SignChallengeResult {
  signature: string;
  signedAt: number;
  nonce: string;
}

/** ASSUMPTION (Task 8 to verify against buildDeviceAuthPayloadV3 on a live gateway):
 *  canonical payload = ["v3", identity.id, "operator", scopes.join(","), token, nonce, platform, "server"].join("\n")
 *
 *  Note: "operator" above is illustrative of the role SLOT, not a hardcoded literal -- the
 *  function below substitutes `input.role`/`input.platform` (and every other field) from the
 *  caller's actual input at call time, exactly like the rest of the array.
 *
 *  This is the ONE function pinning the exact byte construction of the OpenClaw v3 device-auth
 *  payload. The construction is not publicly documented, so it is isolated here: if Task 8's
 *  live study finds the server disagrees, only this function (and by extension this file) needs
 *  to change. Field order, exactly as concatenated with "\n": a fixed "v3" version tag, the
 *  device id, the requested role, the comma-joined scopes, the operator token, the challenge
 *  nonce, the client platform, and a fixed "server" device-family tag (this adapter only ever
 *  runs as a server-side operator client, never a mobile/desktop device). Never logs the
 *  returned string; it embeds the token verbatim. */
export function buildAuthPayloadV3(input: SignChallengeInput): string {
  const deviceFamily = "server";
  return [
    "v3",
    input.identity.id,
    input.role,
    input.scopes.join(","),
    input.token,
    input.nonce,
    input.platform,
    deviceFamily,
  ].join("\n");
}

/** Signs a `connect.challenge` nonce with the device's Ed25519 private key, producing the
 *  `device.signature`/`device.signedAt`/`device.nonce` fields consumed by `buildConnectRequest`.
 *
 *  The nonce MUST be non-empty. A real handshake only ever signs a nonce the server issued in a
 *  `connect.challenge` event; `buildConnectRequest` (protocol.ts) defaults a *missing* nonce to
 *  `""` for the token-only pre-challenge case, and that empty default must never reach a live
 *  sign, so this function refuses it rather than silently signing an empty-nonce payload. */
export function signChallenge(input: SignChallengeInput): SignChallengeResult {
  if (!input.nonce) {
    throw new Error("signChallenge requires a non-empty nonce");
  }

  const payload = buildAuthPayloadV3(input);
  const privateKey = createPrivateKey({
    key: Buffer.from(input.identity.privateKey, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const signature = sign(null, Buffer.from(payload), privateKey);

  return {
    signature: signature.toString("base64"),
    signedAt: Date.now(),
    nonce: input.nonce,
  };
}

/** Reconstructs the public `KeyObject` from a `DeviceIdentity.publicKey` stored as base64 SPKI
 *  DER, so callers (and tests) can `crypto.verify` a `signChallenge` result without holding onto
 *  any in-memory key material from `generateDeviceIdentity`. */
export function importDevicePublicKey(publicKeyBase64: string) {
  return createPublicKey({
    key: Buffer.from(publicKeyBase64, "base64"),
    format: "der",
    type: "spki",
  });
}
