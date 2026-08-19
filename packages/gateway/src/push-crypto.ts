import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";

import type { ApprovalArgSummary, ApprovalOutcome } from "cozygateway-contract";

/** HKDF info string, fixed by contract/push-v0.md. */
export const PUSH_HKDF_INFO = "cozygateway-push-v0";

/** An agent reply committed while the device had no live socket. `kind` is the discriminator
 *  (issue #19): the approval payloads below carry `approval_pending` / `approval_resolved`, so the
 *  ordinary message push says so explicitly rather than being "the one without a kind". A receiver
 *  must still treat an ABSENT `kind` as `"message"`, because every gateway shipped before this
 *  field is emitting exactly that payload; contract/push-v0.md says so normatively. */
export interface MessagePushPayload {
  kind?: "message";
  threadId: string;
  agentName: string;
  preview: string;
}

/** A tool call is waiting on a decision (contract/push-v0.md, category `approval.pending`).
 *
 *  `argSummary` is argument key NAMES mapped to JSON type TAGS, never a value, and redacting it is
 *  the GATEWAY's obligation before it encrypts: the relay cannot inspect a ciphertext it has no key
 *  for. It is OPTIONAL and the bots bridge omits it entirely, because the hermes approval surface
 *  carries no structured arguments to summarize (issue #19 bridge-lane ruling 1). */
export interface ApprovalPendingPushPayload {
  kind: "approval_pending";
  /** The core lane sends a thread id. The bots bridge has no threads, so it sends the namespaced
   *  `bot:<name>`, the same shape the group escalation already uses for `group:<name>`: a client
   *  that does not know the namespace cannot mistake it for one of its threads. */
  threadId: string;
  agentId: string;
  turnId: string;
  toolCallId: string;
  name: string;
  argSummary?: ApprovalArgSummary;
}

/** That approval reached a terminal state (category `approval.resolved`, same collapse id, so it
 *  replaces the pending banner in place). */
export interface ApprovalResolvedPushPayload {
  kind: "approval_resolved";
  threadId: string;
  agentId: string;
  turnId: string;
  toolCallId: string;
  outcome: ApprovalOutcome;
}

export type ApprovalPushPayload = ApprovalPendingPushPayload | ApprovalResolvedPushPayload;

/** The in-ciphertext notification payload: one envelope, three plaintexts. */
export type PushPayload = MessagePushPayload | ApprovalPushPayload;

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
