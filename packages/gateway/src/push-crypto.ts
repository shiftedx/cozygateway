import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";

import type { ApprovalArgSummary, ApprovalOutcome, ServerFrame } from "cozygateway-contract";

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
  /** Capability 76. Optional for old clients; lets a reply banner open the settled Task without
   * a second completion banner for the same turn. */
  taskId?: string;
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

/** Capability 64's Task reached `completed` while this device had no live socket (category
 *  `task.completed`, collapse id = the task id). It carries the identities the deep link needs and
 *  nothing else: no goal, no reply, no artifact name, nothing the Task worked on. The client opens
 *  `GET /tasks/:taskId` for the rest, which it is already authenticated for.
 *
 *  It is sent exactly once per Task, gated on capability 64's own completion notification record
 *  being newly written, so a client that already announced the completion locally off the
 *  `bot_task_updated` frame is never told a second time. */
export interface TaskCompletionPushPayload {
  kind: "task_completed";
  taskId: string;
  /** `bot:<name>`, or `group:<room>` for a room Task: the same namespacing the approval payloads
   *  use, so a client that does not know the namespace cannot mistake it for one of its threads. */
  threadId: string;
  agentId: string;
}

/** Privacy-minimal signal telling an idle phone to reconnect for a retained status request. */
export interface MobileNodeWakePushPayload {
  kind: "mobile_node_wake";
}

/** The in-ciphertext notification payload. */
export type PushPayload = MessagePushPayload | ApprovalPushPayload | MobileNodeWakePushPayload
  | TaskCompletionPushPayload;

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

/** Room approvals share the encrypted push lane with chat approvals. Other room frames are silent. */
export function roomApprovalPush(frame: ServerFrame): ApprovalPushPayload | undefined {
  if ((frame.type !== "bot_approval_pending" && frame.type !== "bot_approval_resolved") || frame.room === undefined) return undefined;
  const identity = { threadId: `group:${frame.room}`, agentId: frame.bot, turnId: frame.turnId, toolCallId: frame.toolCallId };
  return frame.type === "bot_approval_pending"
    ? { kind: "approval_pending", ...identity, name: frame.name }
    : { kind: "approval_resolved", ...identity, outcome: frame.outcome };
}
