import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SelfSignedPair {
  dir: string;
  certFile: string;
  keyFile: string;
  /** The PEM cert text, so a test can trust exactly this certificate instead of disabling
   *  verification wholesale. That distinction matters here: the point of the HTTPS boot test is
   *  that the gateway serves the pair it was GIVEN, which a `rejectUnauthorized: false` client
   *  could not tell apart from any other certificate. */
  certPem: string;
}

/** Generates a throwaway self-signed cert/key pair on disk for the TLS tests. Uses the system
 *  `openssl` (present on macOS and on the CI image) because Node ships no certificate generator;
 *  a checked-in fixture pair would be an expired-by-tomorrow liability instead. */
export function generateSelfSigned(): SelfSignedPair {
  const dir = mkdtempSync(join(tmpdir(), "cozygateway-tls-"));
  const certFile = join(dir, "cert.pem");
  const keyFile = join(dir, "key.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "pipe" },
  );
  return { dir, certFile, keyFile, certPem: readFileSync(certFile, "utf8") };
}

/** Writes a file of nonsense where a PEM is expected, for the loud-failure tests. */
export function writeGarbage(dir: string, name: string): string {
  const path = join(dir, name);
  writeFileSync(path, "this is not a pem\n");
  return path;
}
