import { createHash, timingSafeEqual } from "node:crypto";

/** One constant-time bearer resolver shared by attach-v1 WebSocket and HTTP media. Token maps stay
 * small (one row per configured agent/profile); scan every row so none of the public attach
 * surfaces accidentally falls back to Map.get's ordinary string comparison. */
export function resolveAttachBearer(
  tokens: ReadonlyMap<string, string>,
  authorization: string | string[] | undefined,
): string | undefined {
  const header = Array.isArray(authorization) ? authorization[0] ?? "" : authorization ?? "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (supplied === "") return undefined;
  const suppliedDigest = createHash("sha256").update(supplied).digest();
  let resolved: string | undefined;
  for (const [candidate, agentId] of tokens) {
    const candidateDigest = createHash("sha256").update(candidate).digest();
    const equal = timingSafeEqual(candidateDigest, suppliedDigest);
    if (equal) resolved = agentId;
  }
  return resolved;
}
