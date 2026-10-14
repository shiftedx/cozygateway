import type {
  BotRelayAgent,
  BotRelayDeliverRequest,
  BotRelayDeliverResponse,
  BotRelayDrainResponse,
  BotRelayReplyRequest,
} from "cozygateway-contract";
import { HermesRpcError } from "./client.ts";
import { asRecord, asString, type HermesRpc } from "./rpc.ts";

/** Capability 87: the cross-connection relay doors, forwarded to this gateway's own Hermes.
 *
 *  Upstream Hermes Desktop relays `message_agent` DMs between the backends it holds sockets to
 *  (`apps/desktop/src/plugins/hermes-bots/relay.ts`). A phone never holds this gateway's Hermes
 *  socket, so the gateway exposes the four JSON-RPC doors (`tui_gateway/methods_bot_relay.py`) as
 *  routes and nothing more: the courier logic (which envelope goes where, lanes, retries) stays on
 *  the phone, exactly where upstream keeps it. Rows and envelopes are Hermes's own shapes, verbatim. */

/** Upstream `RELAY_DELIVER_TIMEOUT_MS`: the target's lock wait (120 s) plus two 600 s turn
 *  attempts, plus 180 s of settlement. A relayed turn blocks this long by design (#93911). */
export const RELAY_DELIVER_TIMEOUT_MS = (120 + 600 * 2 + 180) * 1000;

/** Upstream `tools/bot_relay.py _HANDLE_RE`: profile, handle and connection id share it. */
const RELAY_HANDLE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** `_normalize_roster_row`, applied here row by row: a row Hermes would drop is dropped, and the
 *  free-text fields are cut to Hermes's own limits (label 80, title 120, description 160, the
 *  description on one line). One bad row never costs the whole push. */
export function normalizeRelayAgents(rows: readonly unknown[]): BotRelayAgent[] {
  const out: BotRelayAgent[] = [];
  for (const raw of rows) {
    const row = asRecord(raw);
    if (row === undefined) continue;
    const profile = (asString(row["profile"]) ?? "").trim();
    const handle = (asString(row["handle"]) ?? "").trim().replace(/^@+/, "") || (profile === "default" ? "hermes" : profile);
    const connectionId = (asString(row["connection_id"]) ?? "").trim();
    if (![profile, handle, connectionId].every((value) => RELAY_HANDLE_RE.test(value))) continue;
    const agent: BotRelayAgent = {
      profile,
      handle,
      connection_id: connectionId,
      connection_label: (asString(row["connection_label"]) ?? "").trim().slice(0, 80),
      title: (asString(row["title"]) ?? "").trim().slice(0, 120),
      description: (asString(row["description"]) ?? "").split(/\s+/).filter(Boolean).join(" ").slice(0, 160),
    };
    if (typeof row["online"] === "boolean") agent.online = row["online"];
    out.push(agent);
  }
  return out;
}

/** The id this gateway goes by on the relay: its configured name, slugged, plus the first six
 *  characters of its Hermes install id. Server-side facts only, so every phone derives the same id,
 *  and a renamed or removed connection on one phone can never shift another's. */
export function relayConnectionId(gatewayName: string, installId: string | undefined): string {
  const slug = gatewayName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 48) || "gateway";
  const suffix = (installId ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6);
  return suffix.length === 0 ? slug : `${slug}-${suffix}`;
}

/** Hermes's stable per-install id (`GET /api/status install_id`), or undefined on an older Hermes. */
export async function relayInstallId(client: { dashboardJson<T = unknown>(path: string): Promise<T> }): Promise<string | undefined> {
  try {
    return asString(asRecord(await client.dashboardJson("/api/status"))?.["install_id"]);
  } catch {
    return undefined;
  }
}

export async function relayRosterSync(rpc: HermesRpc, agents: BotRelayAgent[]): Promise<{ count: number }> {
  const result = asRecord(await rpc.request("bot_relay.roster.sync", { agents }));
  return { count: typeof result?.["count"] === "number" ? result["count"] : 0 };
}

export async function relayDrain(rpc: HermesRpc): Promise<BotRelayDrainResponse> {
  const result = asRecord(await rpc.request("bot_relay.outbox.drain", {}));
  const envelopes = Array.isArray(result?.["envelopes"]) ? (result["envelopes"] as unknown[]) : [];
  return { envelopes: envelopes.flatMap((row) => (asRecord(row) === undefined ? [] : [row as Record<string, unknown>])) };
}

/** One relayed turn. A Hermes refusal is an OUTCOME carrying the target's typed `data.reason`;
 *  only a transport failure (Hermes unreachable) throws. */
export async function relayDeliver(rpc: HermesRpc, req: BotRelayDeliverRequest): Promise<BotRelayDeliverResponse> {
  try {
    const result = asRecord(
      await rpc.request(
        "bot_relay.deliver",
        {
          profile: req.profile,
          message: req.message,
          from_profile: req.fromProfile ?? "",
          from_handle: req.fromHandle ?? "",
          from_connection: req.fromConnection ?? "",
        },
        { timeoutMs: RELAY_DELIVER_TIMEOUT_MS },
      ),
    );
    return { reply: asString(result?.["reply"]) ?? "" };
  } catch (err) {
    if (!(err instanceof HermesRpcError)) throw err;
    const reason = asString(asRecord(err.data)?.["reason"]);
    return reason === undefined || reason.length === 0 ? { error: err.message } : { error: err.message, reason };
  }
}

export async function relayReply(rpc: HermesRpc, req: BotRelayReplyRequest): Promise<{ ok: true }> {
  const params: Record<string, unknown> = { id: req.id };
  if (typeof req.reply === "string") params["reply"] = req.reply;
  if (typeof req.error === "string") params["error"] = req.error;
  if (typeof req.reason === "string") params["reason"] = req.reason;
  await rpc.request("bot_relay.reply", params);
  return { ok: true };
}
