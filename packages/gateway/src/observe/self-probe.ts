import { monotonicNow, type ObservationRing } from "./ring.ts";

export const TUNNEL_PROBE_INTERVAL_MS = 30_000;
export const TUNNEL_PROBE_TIMEOUT_MS = 10_000;

/** Section 10 and 11, the tunnel leg. The gateway asks its own public hostname for `/ready` and
 *  asks itself the same question over loopback, and the difference between the two round trips is
 *  what the connector, the Cloudflare edge and the backbone cost.
 *
 *  Both halves are timed by this process on one monotonic clock within the same second, so the
 *  subtraction is between two of its own measurements rather than across machines. That is the one
 *  subtraction section 11 sanctions by name; every other derived figure stays out of the ring.
 *
 *  A gateway with no public URL has no tunnel, and this never runs for one.
 *
 *  Flap events are EDGE TRIGGERED. The probe keeps the last outcome and writes one event when the
 *  tunnel goes down and one when it comes back, carrying how long it was out. Writing one per failing
 *  probe would put 2,880 identical rows in the ring for a day of downtime and bury the transition
 *  D3 wants to draw, during exactly the incident an operator is looking at.
 *
 *  Nothing about the probe reaches a row: the URL it fetched, the host it resolved and any body it
 *  received are used and dropped. A flap event carries a reason code and, when there was one, an
 *  HTTP status integer. */
export class TunnelSelfProbe {
  readonly #ring: ObservationRing;
  readonly #publicReadyUrl: string;
  readonly #loopbackReadyUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #inFlight = false;
  /** Undefined until the first probe resolves, so a gateway that starts with its tunnel already down
   *  still writes the transition once rather than assuming it was up. */
  #up: boolean | undefined;
  #downSince = 0;
  #consecutiveFailures = 0;

  constructor(deps: {
    ring: ObservationRing;
    /** The operator's advertised HTTPS origin, e.g. the tunnel hostname. */
    publicUrl: string;
    /** This process's own listener, always plain loopback. */
    loopbackUrl: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
  }) {
    this.#ring = deps.ring;
    this.#publicReadyUrl = readyUrl(deps.publicUrl);
    this.#loopbackReadyUrl = readyUrl(deps.loopbackUrl);
    this.#fetch = deps.fetch ?? globalThis.fetch;
    this.#timeoutMs = deps.timeoutMs ?? TUNNEL_PROBE_TIMEOUT_MS;
  }

  start(intervalMs: number = TUNNEL_PROBE_INTERVAL_MS): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      void this.probe();
    }, intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** One probe. Never throws and never rejects: a metric that can take down the process it
   *  measures is worse than no metric. Overlapping ticks are skipped rather than queued, so a
   *  tunnel that is timing out cannot pile up thirty second requests. */
  async probe(): Promise<void> {
    if (this.#inFlight) return;
    this.#inFlight = true;
    try {
      const loopback = await this.#time(this.#loopbackReadyUrl);
      const publicSide = await this.#time(this.#publicReadyUrl);
      if (publicSide.outcome !== "ok") {
        this.#consecutiveFailures += 1;
        if (this.#up !== false) {
          this.#up = false;
          this.#downSince = monotonicNow();
          this.#ring.tunnelDown(publicSide.outcome, publicSide.status);
        }
        return;
      }
      if (this.#up === false) {
        this.#ring.tunnelRecovered(monotonicNow() - this.#downSince, this.#consecutiveFailures);
      }
      this.#up = true;
      this.#consecutiveFailures = 0;
      // A loopback probe that failed leaves nothing to subtract from. The public leg was fine, so
      // this is not a flap; it is simply a sample this gateway cannot honestly take.
      if (loopback.outcome !== "ok") return;
      // Nor can it when the loopback leg was the slower of the two, which a GC pause or a busy
      // /ready produces. Clamping that to zero would store a number nothing measured as a measured
      // tunnel round trip, which is the one thing the ring must never do.
      const difference = publicSide.ms - loopback.ms;
      if (difference < 0) return;
      this.#ring.tunnelRtt(difference);
    } catch {
      // Unreachable in practice; #time already absorbs every failure. Belt to that pair of braces.
    } finally {
      this.#inFlight = false;
    }
  }

  async #time(url: string): Promise<{
    outcome: "ok" | "timeout" | "bad_gateway" | "unreachable" | "http_error";
    ms: number;
    status?: number;
  }> {
    const startedAt = monotonicNow();
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      return { outcome: timedOut ? "timeout" : "unreachable", ms: monotonicNow() - startedAt };
    }
    const ms = monotonicNow() - startedAt;
    // `/ready` answers 503 when a bridge is down. That is the gateway telling the truth about
    // itself through a tunnel that plainly worked, so it is a healthy sample, not a flap. A 502,
    // 504 or 522 is the edge saying it could not reach this gateway at all, which is the flap.
    if (response.status === 502 || response.status === 504 || response.status === 522 || response.status === 523) {
      return { outcome: "bad_gateway", ms, status: response.status };
    }
    if (response.status >= 500 && response.status !== 503) {
      return { outcome: "http_error", ms, status: response.status };
    }
    return { outcome: "ok", ms };
  }
}

function readyUrl(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/ready`;
}
