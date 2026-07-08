import type { Storage, PushRegistrationRow } from "./storage.ts";
import type { Notifier } from "./turns.ts";
import { encryptPushPayload, type PushPayload } from "./push-crypto.ts";

export const PREVIEW_MAX_CHARS = 200;
const NOTIFY_TIMEOUT_MS = 10_000;

/** Slices `text` to at most `maxUnits` UTF-16 code units, but never mid-surrogate-pair. A
 *  plain `.slice(0, maxUnits)` can land the cut between a surrogate pair's high and low half,
 *  producing a lone high surrogate that serializes as U+FFFD (replacement character) instead
 *  of the astral character it started. If the unit at the cut boundary is a high surrogate,
 *  its low half was about to be dropped anyway, so drop the high half too and land one unit
 *  earlier, on a real code-point boundary. */
function truncateAtCodePointBoundary(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text;
  let end = maxUnits;
  const boundaryUnit = text.charCodeAt(end - 1);
  if (boundaryUnit >= 0xd800 && boundaryUnit <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

export interface RelayNotifierDeps {
  storage: Storage;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
  /** Live per-device presence check (see `WsHub.isDeviceConnected`). Optional: when omitted,
   *  `#send` skips the late recheck and relies solely on the `connectedDeviceIds` snapshot
   *  `notify()` was called with. Wired in at server assembly to narrow the race where a
   *  device's socket becomes live between the commit-time snapshot and the fire-and-forget
   *  send actually going out (issue #11). */
  isDeviceConnected?: (deviceId: string) => boolean;
}

/** Posts encrypted notification payloads to each registered device's relay.
 *  Fire-and-forget by contract: notify() never throws, never rejects, and never blocks
 *  the turn that triggered it (design spec, section 4). */
export class RelayNotifier implements Notifier {
  readonly #storage: Storage;
  readonly #fetch: typeof fetch;
  readonly #log: (message: string) => void;
  readonly #isDeviceConnected: ((deviceId: string) => boolean) | undefined;

  constructor(deps: RelayNotifierDeps) {
    this.#storage = deps.storage;
    this.#fetch = deps.fetchImpl ?? fetch;
    this.#log = deps.log ?? ((message: string) => process.stderr.write(`${message}\n`));
    this.#isDeviceConnected = deps.isDeviceConnected;
  }

  notify(
    event: { threadId: string; agentName: string; preview: string },
    connectedDeviceIds: ReadonlySet<string>,
  ): void {
    let registrations: PushRegistrationRow[];
    try {
      registrations = this.#storage.pushRegistrations();
    } catch (err) {
      this.#log(`push: reading registrations failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    // Per-device targeting (issue #11): a device with a live socket at commit time gets its
    // update over the WS instead, so it is excluded here rather than pushed to redundantly.
    const targets = registrations.filter((registration) => !connectedDeviceIds.has(registration.deviceId));
    if (targets.length === 0) return;
    const payload: PushPayload = {
      threadId: event.threadId,
      agentName: event.agentName,
      preview: truncateAtCodePointBoundary(event.preview, PREVIEW_MAX_CHARS),
    };
    for (const registration of targets) {
      void this.#send(registration, payload).catch((err: unknown) => {
        this.#log(
          `push: notify failed for device ${registration.deviceId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }

  async #send(registration: PushRegistrationRow, payload: PushPayload): Promise<void> {
    // Yield one macrotask before the presence recheck. Without this yield the recheck would
    // run in the same synchronous span as notify()'s commit-time snapshot and could never
    // observe anything newer. setImmediate callbacks run after pending I/O callbacks, so a WS
    // auth frame already sitting in the socket's event queue at commit time gets processed
    // first and the recheck below sees the device as connected. Only this fire-and-forget
    // send path defers; the commit-time notify decision in the turn runner stays fully
    // synchronous, and one macrotask of extra push latency is invisible at human scale.
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Late recheck, narrowing (not closing) the race window: the device may have connected
    // since notify()'s commit-time snapshot was taken. Skip the send without touching the
    // registration row, which is prunable only on a relay 404, not on this kind of skip.
    if (this.#isDeviceConnected?.(registration.deviceId) === true) return;
    const ciphertext = encryptPushPayload(registration.pushKey, payload);
    const url = `${registration.relayUrl.replace(/\/+$/, "")}/notify`;
    const res = await this.#fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pushId: registration.pushId, ciphertext }),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
    if (res.status === 404) {
      // The relay no longer knows this id; the registration is dead weight (push-v0). Prune it.
      this.#storage.deletePushRegistration(registration.deviceId);
      return;
    }
    if (!res.ok) throw new Error(`relay returned HTTP ${res.status}`);
  }
}
