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
