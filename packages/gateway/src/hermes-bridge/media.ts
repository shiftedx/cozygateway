/** The media proxy behind `GET /bots/:name/media` (contract/ext-bots-v1.md section 4, capability 7).
 *
 *  A bot writes image references into its replies two ways: an `https` URL, and a path on the box
 *  Hermes runs on (an `image_gen` output, a screenshot). The phone can reach neither: the first
 *  because the app holds no credentials for arbitrary hosts and a direct load leaks the device's IP
 *  to whatever host a bot's text names, and the second because a local path is not addressable off
 *  the box at all.
 *
 *  This module answers the first case only. The second is REFUSED in v1, on purpose: serving an
 *  arbitrary local path from an authenticated route is a file-read primitive over the whole box, and
 *  the containment that would make it safe (a resolved allow-root, symlink realpath checks, a
 *  per-bot output directory Hermes does not currently promise) is a design, not a guard. The refusal
 *  is part of the contract so a client can render a sensible chip instead of a spinner that never
 *  ends.
 *
 *  Nothing here touches Hermes, so none of it can fail the way the rest of the bridge fails. */

import { lookup as dnsLookup } from "node:dns/promises";

/** Bytes. A phone showing an inline image in a chat bubble does not need more, and the cap is what
 *  keeps a bot's text from pointing the gateway at a multi-gigabyte download. Enforced against the
 *  declared `Content-Length` AND against the bytes actually delivered, because the header is a claim
 *  by the upstream host and the body is the fact. */
export const MEDIA_MAX_BYTES = 10 * 1024 * 1024;

/** Milliseconds. Covers the whole exchange, headers and body: an upstream that dribbles one byte a
 *  second must not be able to hold a gateway connection open indefinitely. */
export const MEDIA_TIMEOUT_MS = 15_000;

/** How many redirects the proxy will follow. Followed BY HAND rather than by `fetch`'s own
 *  `redirect: "follow"` so that every hop is re-checked against the same scheme and host rules as
 *  the first: an upstream that answers `302 http://169.254.169.254/...` would otherwise walk the
 *  proxy straight past the guard that refused that address in the query string. */
export const MEDIA_MAX_REDIRECTS = 3;

/** How many media fetches this gateway will run at once, counted for the whole life of a fetch
 *  (headers AND the body stream), because a socket held open dribbling bytes costs the same as one
 *  being negotiated.
 *
 *  Per GATEWAY, not per device, and the choice is deliberate: the resource being protected is this
 *  process's socket table and the household's uplink, both of which are shared by every paired
 *  device. A per-device cap would multiply the fan-out by the number of phones in the house, which is
 *  the opposite of a bound. The cost of the choice is that one device loading a gallery can make
 *  another device's image wait, and that is the right trade for a household gateway with a handful of
 *  devices: the wait is bounded below, and nothing is dropped that a retry cannot get.
 *
 *  The number that matters is not this one but the fan-out it stops: a single reply may carry fifty
 *  image references, and the app asks for all of them at once. Five in flight turns a crafted reply
 *  from a resource event into a gallery that fills in a few at a time. */
export const MEDIA_MAX_CONCURRENT = 5;

/** How long a request will wait for one of those slots before it is refused.
 *
 *  A BOUNDED wait rather than an unbounded queue, and rather than an instant refusal. Unbounded is
 *  wrong because the per-fetch timeout only starts once a slot is held: park four requests behind
 *  four 15 s fetches and the fourth one's spinner runs for a minute with no way for the client to
 *  tell a queued request from a slow host, which is exactly the "silently blow its own budget"
 *  failure. Refusing instantly is wrong the other way: the common deep queue is a burst of thumbnails
 *  that each finish in well under a second, and refusing those would make a normal gallery flicker
 *  with errors. Five seconds covers the burst and gives up before a stalled upstream can hide behind
 *  the queue; past it the client gets a retryable 503 and can ask again when the user scrolls the
 *  image back into view. */
export const MEDIA_QUEUE_WAIT_MS = 5_000;

/** Content types the proxy will pass through. An allow-list, not a `image/*` prefix test, and
 *  `image/svg+xml` is deliberately NOT on it: SVG is a document format that carries script and
 *  external references, and passing one through an authenticated same-origin route hands a bot's
 *  text a way to run markup inside whatever the client renders it in. Every entry here is a raster
 *  format a decoder treats as pixels. */
export const MEDIA_ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/avif",
  "image/bmp",
  "image/tiff",
]);

/** What the app may cache the answer for. The key is the SOURCE URL, and a bot's image URL is in
 *  practice immutable (a generated asset, a CDN object), so a day of `private` caching removes the
 *  re-fetch on every scroll-back through a transcript. `private` because the answer went through a
 *  device-token-authenticated route and belongs to that device, not to any shared cache. */
export const MEDIA_CACHE_CONTROL = "private, max-age=86400";

/** Why a source was refused. Rides the error body as `reason` so a client can say something true in
 *  its fallback chip without parsing prose. */
export type MediaRefusalReason =
  | "local_path" // an absolute or relative filesystem path, or a file: URL
  | "scheme" // anything that is not https
  | "host" // a loopback, private, link-local or otherwise non-public address literal
  | "credentials" // userinfo in the URL
  | "content_type" // upstream served something that is not an allowed image type
  | "too_large"; // declared or delivered body over MEDIA_MAX_BYTES

export class MediaRefused extends Error {
  readonly reason: MediaRefusalReason;
  constructor(reason: MediaRefusalReason, message: string) {
    super(message);
    this.name = "MediaRefused";
    this.reason = reason;
  }
}

export class MediaUpstreamFailed extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "MediaUpstreamFailed";
    if (status !== undefined) this.status = status;
  }
}

export class MediaTimedOut extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaTimedOut";
  }
}

/** Nothing was dialed because this gateway is already fetching as many images as it will fetch at
 *  once, and a slot did not come free in time. Separate from every other error here because it says
 *  nothing about the source: the same URL a moment later is likely to work, which is why the route
 *  turns it into a retryable status rather than a refusal. */
export class MediaBusy extends Error {
  readonly waitedMs: number;
  constructor(waitedMs: number) {
    super(`the gateway is already fetching ${MEDIA_MAX_CONCURRENT} images and no slot came free in ${waitedMs} ms`);
    this.name = "MediaBusy";
    this.waitedMs = waitedMs;
  }
}

/** Released when the fetch is finished with its slot, which is when the BODY is done, not when the
 *  headers arrive. Calling it twice is harmless: the stream teardown paths overlap. */
export type MediaSlot = () => void;

export type MediaLimiter = {
  acquire(waitMs?: number): Promise<MediaSlot>;
  /** For tests and for anything that wants to report saturation. */
  readonly inFlight: number;
};

/** A counting semaphore with a FIFO waiting line. FIFO rather than LIFO so a request that has
 *  already waited is not starved by one that just arrived, which matters when the queue is a burst of
 *  thumbnails from one reply. Exported so a test can cap at two and watch the cap hold, and so a
 *  future per-collab policy has somewhere to go. */
export function createMediaLimiter(limit: number = MEDIA_MAX_CONCURRENT): MediaLimiter {
  type Waiter = { grant: () => void; timer: ReturnType<typeof setTimeout> };
  let inFlight = 0;
  const waiting: Waiter[] = [];
  const take = (): MediaSlot => {
    inFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      inFlight -= 1;
      const next = waiting.shift();
      if (next !== undefined) {
        clearTimeout(next.timer);
        next.grant();
      }
    };
  };
  return {
    get inFlight() {
      return inFlight;
    },
    acquire(waitMs: number = MEDIA_QUEUE_WAIT_MS): Promise<MediaSlot> {
      if (inFlight < limit) return Promise.resolve(take());
      return new Promise<MediaSlot>((resolve, reject) => {
        let entry: Waiter;
        const timer = setTimeout(() => {
          const at = waiting.indexOf(entry);
          if (at >= 0) waiting.splice(at, 1);
          reject(new MediaBusy(waitMs));
        }, waitMs);
        // `unref` where it exists, so a queued waiter cannot hold a process open on shutdown.
        (timer as unknown as { unref?: () => void }).unref?.();
        entry = { grant: () => resolve(take()), timer };
        waiting.push(entry);
      });
    },
  };
}

/** The one every request shares, because the bound is a property of the process. */
const gatewayMediaLimiter = createMediaLimiter();

/** Reads as a filesystem path rather than as a URL. Checked BEFORE parsing so the refusal names the
 *  real reason: `/Users/x/out.png` and `C:\out.png` do not parse as URLs at all, and reporting them
 *  as "malformed" would tell a user to fix a URL that is not one. */
function looksLikeLocalPath(src: string): boolean {
  if (src.startsWith("/") || src.startsWith("./") || src.startsWith("../") || src.startsWith("~")) return true;
  if (/^[a-zA-Z]:[\\/]/.test(src)) return true; // windows drive letter
  if (src.startsWith("\\\\")) return true; // UNC share
  return false;
}

/** Address literals the proxy will not dial. The gateway sits on the operator's own network with
 *  reach into it, and the `src` it is handed comes out of a bot's reply text, which is model output
 *  and therefore untrusted input. Without this a crafted reply turns an authenticated app route into
 *  a probe of the operator's LAN and of every cloud metadata endpoint that lives on a link-local
 *  address.
 *
 *  This function checks one ADDRESS OR NAME as written. It is applied twice: to the literal in the
 *  URL, and (by `assertResolvesPublic`) to whatever that URL's hostname resolves to, so a public DNS
 *  name pointed at private space is caught as well. What survives is the gap between the check and
 *  the connection: the socket can still be handed a different answer than the one that was checked.
 *  Closing that means pinning the socket to the address that was checked, which is a bigger change.
 *  The contract says exactly this rather than implying a guarantee. */
function isBlockedHost(hostname: string): boolean {
  // The trailing FQDN root dot is stripped FIRST, before any rule, because it changes nothing about
  // where a name resolves and everything about how a suffix test reads: `localhost.` resolves to
  // 127.0.0.1 and `nas.local.` is the ordinary mDNS spelling, and both walked past the three name
  // rules below while the same names without the dot were refused.
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  // IPv6 loopback, unspecified, unique-local (fc00::/7) and link-local (fe80::/10).
  if (host === "::1" || host === "::") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
  // A v4 address written inside a v6 one, checked by unwrapping to the v4 literal. BOTH spellings of
  // each prefix are handled, because `new URL()` rewrites the readable one: `[::ffff:10.0.0.1]` comes
  // back out of `url.hostname` as `[::ffff:a00:1]`, so a check that only knew the dotted form let
  // every private address through behind four characters of prefix.
  //
  // Three prefixes carry a v4 address inside a v6 one and all three are unwrapped the same way, so
  // the v4 rules below decide every spelling of the same address:
  //   `::ffff:a.b.c.d`  IPv4-mapped, the common one
  //   `::a.b.c.d`       IPv4-compatible, deprecated but still routed, and `[::127.0.0.1]` is a
  //                     perfectly ordinary way to write loopback that Node hands back as `::7f00:1`
  //   `64:ff9b::a.b.c.d` the well-known NAT64 prefix, which on a network running NAT64 is a live
  //                     route to the embedded v4 address
  // Unwrapping rather than blanket-blocking the prefixes keeps the answer consistent across
  // spellings: `[::ffff:8.8.8.8]` and `[64:ff9b::8.8.8.8]` are public and stay allowed, exactly as
  // the dotted form does.
  const dotted = /^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  const hex = /^(?:::ffff:|::|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  const v4 = dotted
    ? dotted[1]
    : hex
      ? [
          (Number.parseInt(hex[1] ?? "0", 16) >> 8) & 0xff,
          Number.parseInt(hex[1] ?? "0", 16) & 0xff,
          (Number.parseInt(hex[2] ?? "0", 16) >> 8) & 0xff,
          Number.parseInt(hex[2] ?? "0", 16) & 0xff,
        ].join(".")
      : host;
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4 ?? "");
  if (!octets) return false;
  const [a, b] = [Number(octets[1]), Number(octets[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local, and the cloud metadata address
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast and reserved
  return false;
}

/** Turns the raw `src` query value into a URL the proxy is willing to dial, or throws the refusal
 *  that says why not. Exported because the rules are the interesting part and they are worth testing
 *  without a socket. */
export function resolveMediaSource(raw: string): URL {
  const src = raw.trim();
  if (looksLikeLocalPath(src)) {
    throw new MediaRefused(
      "local_path",
      "local file paths are not served by this gateway; only https sources are proxied",
    );
  }
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    throw new MediaRefused("scheme", `src is not a URL: ${src.slice(0, 120)}`);
  }
  if (url.protocol === "file:") {
    throw new MediaRefused(
      "local_path",
      "local file paths are not served by this gateway; only https sources are proxied",
    );
  }
  if (url.protocol !== "https:") {
    throw new MediaRefused("scheme", `only https sources are proxied, not ${url.protocol.replace(":", "")}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new MediaRefused("credentials", "a media source must not carry credentials in the URL");
  }
  if (isBlockedHost(url.hostname)) {
    throw new MediaRefused("host", `refusing to fetch from a non-public address: ${url.hostname}`);
  }
  return url;
}

/** Injected in tests, exactly like `fetchImpl`, so the resolved-address rule can be exercised with no
 *  network and no DNS. Returns every address the name resolves to. */
export type MediaLookup = (hostname: string) => Promise<string[]>;

const defaultLookup: MediaLookup = async (hostname) =>
  (await dnsLookup(hostname, { all: true })).map((entry) => entry.address);

/** Reads as an address rather than a name, in which case `isBlockedHost` has already had the final
 *  word and there is nothing to resolve. `url.hostname` hands back IPv6 in brackets. */
function isAddressLiteral(hostname: string): boolean {
  return hostname.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

/** The second half of the host rule: resolve the name and apply the SAME address rules to what came
 *  back.
 *
 *  Without this the literal check is bypassed with no infrastructure at all, because public DNS names
 *  that answer with private addresses are a service anyone can use: `localtest.me` is 127.0.0.1, and
 *  the `nip.io` and `sslip.io` families answer with whatever address is spelled into the name. A
 *  literals-only guard refuses `https://127.0.0.1/` and allows `https://127.0.0.1.nip.io/`, which is
 *  not a guard.
 *
 *  What this does NOT close, and the contract says so too: the resolver is asked here and the socket
 *  asks again, so a name that answers publicly now and privately in a moment (DNS rebinding, or a
 *  short-TTL record that changes between the two lookups) still reaches a private address. Only
 *  pinning the connection to the address that was checked closes that, and it needs a custom agent
 *  per request. This closes "point a hostname at 10.0.0.5", which is the part that costs an attacker
 *  nothing. */
async function assertResolvesPublic(url: URL, lookup: MediaLookup): Promise<void> {
  if (isAddressLiteral(url.hostname)) return;
  let addresses: string[];
  try {
    addresses = await lookup(url.hostname);
  } catch (err) {
    throw new MediaUpstreamFailed(
      `the image source's hostname did not resolve: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // EVERY answer, not the first: a name that answers with one public and one private address must be
  // refused, because which one the socket picks is not this function's to decide.
  const blocked = addresses.find((address) => isBlockedHost(address));
  if (blocked !== undefined) {
    throw new MediaRefused("host", `refusing to fetch from ${url.hostname}, which resolves to ${blocked}`);
  }
}

export type MediaFetchResult = {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  /** The upstream's declared length when it declared one, so the answer can carry it through and let
   *  the app show real download progress. */
  contentLength?: number;
};

/** Injected in tests. Matches the shape of global `fetch` closely enough for the one call made. */
export type MediaFetch = (url: string, init: { redirect: "manual"; signal: AbortSignal }) => Promise<Response>;

/** Fetches one image, following redirects by hand and refusing anything that breaks the rules above.
 *  Returns a STREAM: a 10 MB cap is worth enforcing without first buffering 10 MB per concurrent
 *  request, and the phone starts decoding sooner. */
export async function fetchMedia(
  source: URL,
  options: {
    fetchImpl?: MediaFetch;
    timeoutMs?: number;
    lookup?: MediaLookup;
    limiter?: MediaLimiter;
    queueWaitMs?: number;
  } = {},
): Promise<MediaFetchResult> {
  const doFetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const lookup = options.lookup ?? defaultLookup;
  const timeoutMs = options.timeoutMs ?? MEDIA_TIMEOUT_MS;
  const limiter = options.limiter ?? gatewayMediaLimiter;

  // The slot is taken BEFORE the timer starts, and that ordering is the point: a request that waited
  // in the queue must get its full 15 s once it is dialing, or a deep queue would silently spend a
  // request's whole budget on waiting and report it as an upstream timeout. Time in the queue is
  // bounded separately, and running out of it is a different answer (`MediaBusy`) that says the
  // gateway was busy rather than blaming the source.
  const slot = await limiter.acquire(options.queueWaitMs);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    slot();
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let timedOut = false;
  const onAbort = () => {
    timedOut = true;
    // The slot goes back at the timeout too, not only on a clean end of stream: a caller that takes
    // the body and then walks away without reading or cancelling it would otherwise hold a slot for
    // as long as the process lives. The timeout covers the body as well as the headers, so once it
    // has fired this fetch is finished with the socket either way.
    release();
  };
  controller.signal.addEventListener("abort", onAbort);

  try {
    let url = source;
    let response: Response | undefined;
    for (let hop = 0; hop <= MEDIA_MAX_REDIRECTS; hop += 1) {
      // Per hop, not once: a redirect's host gets the resolved-address check for the same reason it
      // gets the literal one, since a `302` is just another URL chosen by someone other than us.
      await assertResolvesPublic(url, lookup);
      let attempt: Response;
      try {
        attempt = await doFetch(url.toString(), { redirect: "manual", signal: controller.signal });
      } catch (err) {
        if (timedOut) throw new MediaTimedOut(`the image source did not answer inside ${timeoutMs} ms`);
        throw new MediaUpstreamFailed(err instanceof Error ? err.message : "the image source could not be reached");
      }
      if (attempt.status >= 300 && attempt.status < 400) {
        const location = attempt.headers.get("location");
        await attempt.body?.cancel().catch(() => {});
        if (!location) throw new MediaUpstreamFailed("the image source redirected without a location", attempt.status);
        if (hop === MEDIA_MAX_REDIRECTS) {
          throw new MediaUpstreamFailed(`the image source redirected more than ${MEDIA_MAX_REDIRECTS} times`);
        }
        // Re-checked, not merely resolved: the whole point of following by hand.
        url = resolveMediaSource(new URL(location, url).toString());
        continue;
      }
      response = attempt;
      break;
    }
    if (!response) throw new MediaUpstreamFailed("the image source could not be reached");

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new MediaUpstreamFailed(`the image source answered ${response.status}`, response.status);
    }

    const rawType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (!MEDIA_ALLOWED_TYPES.has(rawType)) {
      await response.body?.cancel().catch(() => {});
      throw new MediaRefused(
        "content_type",
        rawType === ""
          ? "the image source declared no content type"
          : `the image source served ${rawType}, which is not a proxied image type`,
      );
    }

    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MEDIA_MAX_BYTES) {
      await response.body?.cancel().catch(() => {});
      throw new MediaRefused("too_large", `the image is ${declared} bytes, over the ${MEDIA_MAX_BYTES} byte cap`);
    }

    const upstream = response.body;
    if (!upstream) throw new MediaUpstreamFailed("the image source sent no body");

    // The cap again, against the bytes that actually arrive. An upstream that lies in its
    // Content-Length (or omits it) gets cut off mid-stream, and the client sees a truncated
    // response rather than a gateway that quietly buffered a gigabyte.
    let seen = 0;
    const reader = upstream.getReader();
    const capped = new ReadableStream<Uint8Array>({
      async pull(controllerOut) {
        const { done, value } = await reader.read();
        if (done) {
          clearTimeout(timer);
          release();
          controllerOut.close();
          return;
        }
        seen += value.byteLength;
        if (seen > MEDIA_MAX_BYTES) {
          await reader.cancel().catch(() => {});
          clearTimeout(timer);
          release();
          controllerOut.error(new MediaRefused("too_large", `the image ran past the ${MEDIA_MAX_BYTES} byte cap`));
          return;
        }
        controllerOut.enqueue(value);
      },
      async cancel(reason) {
        clearTimeout(timer);
        release();
        await reader.cancel(reason).catch(() => {});
      },
    });

    return {
      body: capped,
      contentType: rawType,
      ...(Number.isFinite(declared) && declared > 0 ? { contentLength: declared } : {}),
    };
  } catch (err) {
    clearTimeout(timer);
    // Every failure path gives the slot back here; the success path holds it until the body ends.
    release();
    throw err;
  } finally {
    controller.signal.removeEventListener("abort", onAbort);
  }
}
