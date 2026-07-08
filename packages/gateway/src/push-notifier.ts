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
}

/** Posts encrypted notification payloads to each registered device's relay.
 *  Fire-and-forget by contract: notify() never throws, never rejects, and never blocks
 *  the turn that triggered it (design spec, section 4). */
export class RelayNotifier implements Notifier {
  readonly #storage: Storage;
  readonly #fetch: typeof fetch;
  readonly #log: (message: string) => void;

  constructor(deps: RelayNotifierDeps) {
    this.#storage = deps.storage;
    this.#fetch = deps.fetchImpl ?? fetch;
    this.#log = deps.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  }

  notify(event: { threadId: string; agentName: string; preview: string }): void {
    let registrations: PushRegistrationRow[];
    try {
      registrations = this.#storage.pushRegistrations();
    } catch (err) {
      this.#log(`push: reading registrations failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (registrations.length === 0) return;
    const payload: PushPayload = {
      threadId: event.threadId,
      agentName: event.agentName,
      preview: truncateAtCodePointBoundary(event.preview, PREVIEW_MAX_CHARS),
    };
    for (const registration of registrations) {
      void this.#send(registration, payload).catch((err: unknown) => {
        this.#log(
          `push: notify failed for device ${registration.deviceId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }

  async #send(registration: PushRegistrationRow, payload: PushPayload): Promise<void> {
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
