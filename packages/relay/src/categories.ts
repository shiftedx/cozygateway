/**
 * Push categories (cozygateway issue #19, section 2).
 *
 * A category is the ONE piece of routing metadata the relay is allowed to see in the clear.
 * It tells a transport how to shape the envelope (which actionable notification category the
 * app should attach buttons to, and that this push coalesces), and nothing about the content:
 * every field describing the notification itself rides inside the opaque ciphertext the relay
 * cannot read. See the relay README, "Push categories".
 */

export const PUSH_CATEGORY_IDS = ["message", "approval.pending", "approval.resolved"] as const;
export type PushCategoryId = (typeof PUSH_CATEGORY_IDS)[number];

export interface PushCategorySpec {
  /** The category id, echoed into the APNs payload as `aps.category`. */
  readonly id: PushCategoryId;
  /** APNs `apns-push-type`. */
  readonly pushType: "alert";
  /** When true, `/notify` refuses this category without a collapse id. */
  readonly requiresCollapseId: boolean;
  /** Fallback alert the relay can build without reading anything: no content, ever. On iOS
   *  the Notification Service Extension decrypts the payload and rewrites this in place. */
  readonly alert: { readonly title: string; readonly body: string };
}

/**
 * `approval.resolved` is deliberately an ALERT push on the same collapse id rather than a
 * silent background push. A background (`content-available`) push is best-effort: iOS may
 * throttle or drop it, and a dropped one leaves a stale "approve this?" banner sitting on the
 * lock screen for an approval that is already decided -- the exact failure this category
 * exists to prevent. An alert on the same `apns-collapse-id` is guaranteed to REPLACE the
 * pending banner in place, so the worst case is a correct-but-unnoticed "resolved" banner
 * rather than a lying "pending" one. Silent removal on top of that (`removeDeliveredNotifica-
 * tions`) is the app's job when it is running to see the replacement.
 */
export const PUSH_CATEGORIES: Readonly<Record<PushCategoryId, PushCategorySpec>> = {
  message: {
    id: "message",
    pushType: "alert",
    requiresCollapseId: true,
    alert: { title: "CozyChat", body: "New message" },
  },
  "approval.pending": {
    id: "approval.pending",
    pushType: "alert",
    requiresCollapseId: true,
    alert: { title: "CozyChat", body: "Approval requested" },
  },
  "approval.resolved": {
    id: "approval.resolved",
    pushType: "alert",
    requiresCollapseId: true,
    alert: { title: "CozyChat", body: "Approval resolved" },
  },
};

export function isPushCategoryId(value: string): value is PushCategoryId {
  return (PUSH_CATEGORY_IDS as readonly string[]).includes(value);
}

/** APNs caps `apns-collapse-id` at 64 bytes. Over-long ids are REFUSED rather than truncated:
 *  two approvals whose ids share a 64-byte prefix would silently collapse into one
 *  notification, and a wrongly-collapsed approval is a wrongly-answered approval. */
export const COLLAPSE_ID_MAX_LENGTH = 64;

/** Opaque-id charset: letters, digits, and `_ - . :`. The collapse id is the only
 *  caller-controlled cleartext STRING on `/notify` besides the ciphertext, so it is bounded
 *  to something that can only be an identifier. A caller that (buggily) tried to pass a raw
 *  tool argument -- a shell command, a path, a JSON blob, quoted text -- fails this check and
 *  the whole notify is refused before anything leaves the relay. */
export const COLLAPSE_ID_PATTERN = `^[A-Za-z0-9_.:-]{1,${COLLAPSE_ID_MAX_LENGTH}}$`;

const COLLAPSE_ID_RE = new RegExp(COLLAPSE_ID_PATTERN);

export function isValidCollapseId(value: string): boolean {
  return COLLAPSE_ID_RE.test(value);
}
