import { readFileSync } from "node:fs";
import { createSecureContext } from "node:tls";

import type { GatewayConfig, TlsConfig } from "./config.ts";

export interface TlsMaterial {
  cert: Buffer;
  key: Buffer;
  certFile: string;
  keyFile: string;
}

/** Thrown when TLS is configured but unusable. Its own type so a host can tell "the operator asked
 *  for TLS and it is broken" apart from any other startup fault. */
export class TlsConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TlsConfigurationError";
  }
}

/** Reads and validates the configured cert/key pair.
 *
 *  Absent config returns `undefined` and the gateway stays on plain HTTP, byte for byte as before:
 *  this is the shape every existing deployment (including the live box) has, and it must remain a
 *  no-op. Present-but-broken config throws instead, before the listener binds, so a typo'd path or
 *  a truncated PEM is a refusal to start rather than a gateway that quietly serves plaintext on the
 *  port the operator believed was encrypted. That asymmetry -- absent stays quiet, present-but-
 *  broken screams -- is the same secure-by-default posture the attach and openclaw token
 *  resolution already take.
 *
 *  Validation is not a file-exists check: the pair is fed to `tls.createSecureContext`, which is
 *  what the listener itself will do, so a garbage PEM, an encrypted key, and a cert that does not
 *  belong to the key are all caught here rather than at first handshake. */
export function resolveTlsMaterial(tls: TlsConfig | undefined): TlsMaterial | undefined {
  if (tls === undefined) return undefined;
  const cert = readPem(tls.certFile, "TLS certificate", "COZY_TLS_CERT_FILE");
  const key = readPem(tls.keyFile, "TLS private key", "COZY_TLS_KEY_FILE");
  try {
    createSecureContext({ cert, key });
  } catch (err) {
    throw new TlsConfigurationError(
      `TLS is configured but the pair is unusable (cert "${tls.certFile}", key "${tls.keyFile}"): ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `Check that both files are unencrypted PEM and that the key belongs to the certificate.`,
    );
  }
  return { cert, key, certFile: tls.certFile, keyFile: tls.keyFile };
}

/** The URL scheme this gateway will answer on. Derived from config alone (no listener needed) so
 *  the `pair` CLI can print a QR payload that matches what the device will actually have to dial. */
export function gatewayScheme(config: GatewayConfig): "http" | "https" {
  return config.tls === undefined ? "http" : "https";
}

function readPem(path: string, what: string, envVar: string): Buffer {
  try {
    const bytes = readFileSync(path);
    if (bytes.length === 0) {
      throw new Error("file is empty");
    }
    return bytes;
  } catch (err) {
    throw new TlsConfigurationError(
      `TLS is configured but the ${what} at "${path}" (${envVar}) could not be read: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
