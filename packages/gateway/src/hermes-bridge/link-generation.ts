/** The HERMES LINK GENERATION: a string that changes when the hermes on the other end of the link
 *  is no longer the same running hermes it was (issue #66).
 *
 *  It exists to bound one durable value. `bot_chat_pins.runtime_id` is the RUNTIME session id of a
 *  chat nobody has written in, and a runtime session lives only inside the hermes process that
 *  created it: restart hermes and every unwritten session it held is gone, while the id on disk
 *  survives and still looks usable. Submitting against it is the bad outcome, not an error: hermes
 *  can accept the prompt into a session nothing will ever answer for, so the app renders the user's
 *  bubble, the gateway answers 202, and the reply never comes.
 *
 *  Two rules shape how the generation is derived, and both are about what it must NOT do:
 *
 *   1. A GATEWAY restart against a hermes that never went down must leave it UNCHANGED. That is the
 *      win PR #61 bought (the first message a user ever types into a fresh chat still lands after a
 *      gateway restart), and a generation minted per process would quietly undo it. Hence the value
 *      is persisted and re-read on start rather than invented.
 *   2. It must never claim more than it can see. A hermes restart that happens while the GATEWAY is
 *      also down is invisible from here, and no amount of derivation changes that. The send path's
 *      re-mint is what covers that case; this is what covers the far commoner one, a hermes that
 *      restarts (or crashes and comes back) under a gateway that stayed up the whole time. */

/** Keys a `gateway.ready` payload might carry that identify the hermes PROCESS rather than its
 *  configuration. Read tolerantly and in order: hermes is free to send none of them, which is why
 *  the observed-reconnect counter below is the fallback rather than the exception. */
const IDENTITY_KEYS = [
  "boot_id",
  "bootId",
  "instance_id",
  "instanceId",
  "server_id",
  "serverId",
  "process_id",
  "started_at",
  "startedAt",
  "start_time",
  "startTime",
  "pid",
] as const;

/** The hermes process identity a `gateway.ready` payload carries, when it carries one.
 *
 *  Only fields that name the RUNNING INSTANCE count. A version string or a skin name is deliberately
 *  not on the list: those are equal across a restart, so treating them as identity would report a
 *  fresh hermes as the same one, which is the exact failure this module exists to prevent. */
export function readyIdentity(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  for (const key of IDENTITY_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return `${key}:${value}`;
    if (typeof value === "number" && Number.isFinite(value)) return `${key}:${value}`;
  }
  return undefined;
}

const LOCAL_PREFIX = "link-";

/** The first generation a database has ever held. */
export function firstLocalGeneration(): string {
  return `${LOCAL_PREFIX}0`;
}

/** The generation that follows `previous` when the link was observed to drop and come back and
 *  hermes told us nothing about itself. Guaranteed different from `previous`, including when
 *  `previous` came from a hermes that used to report an identity and has stopped. */
export function nextLocalGeneration(previous: string | undefined): string {
  if (previous !== undefined && previous.startsWith(LOCAL_PREFIX)) {
    const counter = Number.parseInt(previous.slice(LOCAL_PREFIX.length), 10);
    if (Number.isFinite(counter) && counter >= 0) return `${LOCAL_PREFIX}${counter + 1}`;
  }
  return `${LOCAL_PREFIX}1`;
}
