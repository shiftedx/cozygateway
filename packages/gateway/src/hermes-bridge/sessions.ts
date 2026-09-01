export interface SessionRow {
  id: string;
  title: string;
  preview: string | null;
  source: string | null;
  startedAt: number;
  lastActiveAt: number;
  messageCount?: number;
}

export type BotSessionKind = "conversation" | "cron" | "routine" | "group";

export const HERMES_INTERACTIVE_SESSION_SOURCES = ["desktop", "tui", "cli"] as const;
export type HermesInteractiveSessionSource = typeof HERMES_INTERACTIVE_SESSION_SOURCES[number];

export function interactiveHermesSessionSource(row: SessionRow): HermesInteractiveSessionSource | undefined {
  const source = row.source?.trim().toLowerCase();
  return HERMES_INTERACTIVE_SESSION_SOURCES.find((candidate) => candidate === source);
}

/** The only Dashboard rows eligible for the separate interactive-resume seam. Everything else is
 * deliberately excluded, including cron/routine/group/machine and gateway-created rows. */
export function isDesktopHermesSession(row: SessionRow): boolean {
  return interactiveHermesSessionSource(row) !== undefined && sessionKind(row) === "conversation";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function sessionTime(item: Record<string, unknown>, fields: readonly string[]): number {
  for (const field of fields) {
    const raw = item[field];
    const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    if (!Number.isFinite(value) || value < 0) continue;
    return Math.round(value < 1_000_000_000_000 ? value * 1000 : value);
  }
  return 0;
}

export function parseSessionList(result: unknown): SessionRow[] {
  const record = asRecord(result);
  const rows = Array.isArray(record?.["sessions"]) ? (record["sessions"] as unknown[]) : [];
  const parsed: SessionRow[] = [];
  for (const row of rows) {
    const item = asRecord(row);
    if (item === undefined) continue;
    const rawId = item["id"];
    if (typeof rawId !== "string" && typeof rawId !== "number") continue;
    const id = String(rawId);
    if (id.length === 0) continue;
    const messageCount = item["message_count"];
    const count = typeof messageCount === "number" ? messageCount : typeof messageCount === "string" ? Number(messageCount) : 0;
    parsed.push({
      id,
      title: typeof item["title"] === "string" ? item["title"] : "",
      preview: typeof item["preview"] === "string" ? item["preview"] : null,
      source: typeof item["source"] === "string" ? item["source"] : null,
      startedAt: sessionTime(item, ["started_at", "created_at", "started", "created"]),
      lastActiveAt: sessionTime(item, ["last_active", "last_active_at", "updated_at", "lastActiveAt", "updated"]),
      messageCount: Number.isFinite(count) && count >= 0 ? Math.round(count) : 0,
    });
  }
  return parsed;
}

export function sessionKind(row: SessionRow): BotSessionKind {
  const source = row.source?.trim().toLowerCase();
  if (source === "cron" || row.id.startsWith("cron_")) return "cron";
  if (row.title.startsWith("Routine: ")) return "routine";
  if (row.title.startsWith("Group: ")) return "group";
  return "conversation";
}

export async function listBotSessions(
  rpc: { request(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<unknown> },
  name: string,
  limit: number,
): Promise<SessionRow[]> {
  return parseSessionList(await rpc.request("session.list", { profile: name, limit }));
}
