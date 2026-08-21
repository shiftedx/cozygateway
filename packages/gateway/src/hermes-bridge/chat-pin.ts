export interface LocalChatPin {
  sessionId: string;
  updatedAt: number;
  manual?: boolean;
  unwritten?: boolean;
}

/** The server/local pin precedence shared by every surface that names the active chat.
 *
 * A manual restore and a newly-minted unwritten chat are the two local choices a stale server pin
 * cannot overrule: server writeback is best-effort, so the local row is the only durable witness
 * until Hermes reflects it. Undefined remains distinct from an explicit server clear (`null`). */
export function effectiveChatPin(
  serverPin: string | null | undefined,
  local: LocalChatPin | undefined,
): string | null | undefined {
  const resolved = serverPin !== undefined ? serverPin : local?.sessionId;
  if (
    typeof resolved === "string" &&
    local !== undefined &&
    local.sessionId !== resolved &&
    (local.manual === true || local.unwritten === true)
  ) {
    return local.sessionId;
  }
  return resolved;
}

/** Applies the canonical chat route's follow-latest rule to a pin that is present in a newest-first
 * session list. Kept here so roster preview selection and chat opening cannot drift apart again. */
export function followLatestChatPin<T extends { id: string; startedAt: number }>(
  pin: string,
  rows: readonly T[],
  opts: {
    isConversational: (row: T) => boolean;
    isRetired?: (sessionId: string) => boolean;
    manualSince?: number;
  },
): string {
  const pinIndex = rows.findIndex((row) => row.id === pin);
  if (pinIndex < 0) return pin;
  const isRetired = opts.isRetired ?? (() => false);
  const newer = rows
    .slice(0, pinIndex)
    .find(
      (row) =>
        !isRetired(row.id) &&
        opts.isConversational(row) &&
        (opts.manualSince === undefined ||
          (row.startedAt !== 0 && row.startedAt > opts.manualSince)),
    );
  return newer?.id ?? pin;
}
