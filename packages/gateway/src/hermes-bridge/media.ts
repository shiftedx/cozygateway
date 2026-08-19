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
 *  This checks LITERALS only. A hostname that RESOLVES into private space still gets dialed, and a
 *  DNS answer that changes between this check and the connection could not be caught here anyway;
 *  closing that properly means resolving first and pinning the socket to the address that was
 *  checked, which is a bigger change than tonight's. The contract says so plainly rather than
 *  implying a guarantee this does not make. */
function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  // IPv6 loopback, unspecified, unique-local (fc00::/7) and link-local (fe80::/10).
  if (host === "::1" || host === "::") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
  // IPv4-mapped IPv6, checked by unwrapping to the v4 literal. BOTH spellings are handled, because
  // `new URL()` rewrites the readable one: `[::ffff:10.0.0.1]` comes back out of `url.hostname` as
  // `[::ffff:a00:1]`, so a check that only knew the dotted form let every private address through
  // behind four characters of prefix.
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
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
  options: { fetchImpl?: MediaFetch; timeoutMs?: number } = {},
): Promise<MediaFetchResult> {
  const doFetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? MEDIA_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let timedOut = false;
  const onAbort = () => {
    timedOut = true;
  };
  controller.signal.addEventListener("abort", onAbort);

  try {
    let url = source;
    let response: Response | undefined;
    for (let hop = 0; hop <= MEDIA_MAX_REDIRECTS; hop += 1) {
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
          controllerOut.close();
          return;
        }
        seen += value.byteLength;
        if (seen > MEDIA_MAX_BYTES) {
          await reader.cancel().catch(() => {});
          clearTimeout(timer);
          controllerOut.error(new MediaRefused("too_large", `the image ran past the ${MEDIA_MAX_BYTES} byte cap`));
          return;
        }
        controllerOut.enqueue(value);
      },
      async cancel(reason) {
        clearTimeout(timer);
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
    throw err;
  } finally {
    controller.signal.removeEventListener("abort", onAbort);
  }
}
