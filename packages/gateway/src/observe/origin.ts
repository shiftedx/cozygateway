import type { IncomingMessage } from "node:http";

/** How a device's websocket reached this process, for section 10's `via` tag.
 *
 *  The gateway cannot see a VPN and cannot see the phone's radio; the app reports those on the
 *  receipt. What the gateway CAN see is whether the connection arrived through the public front
 *  door or straight off the local network, and that single bit is the difference between a round
 *  trip that includes the tunnel and the edge and one that does not. Mixing the two into one
 *  distribution would make the median meaningless in exactly the case people ask about.
 *
 *  Evidence, in order: a proxy hop header (a tunnel or reverse proxy adds one; a phone on the LAN
 *  talking to the listener directly does not), then the Host the client asked for matching the
 *  operator's advertised public host. Neither is a security decision and neither is trusted for
 *  one: a client that forges `x-forwarded-for` mislabels its own latency chart and gains nothing.
 */
export type DeviceOriginVia = "tunnel" | "lan";

const PROXY_HEADERS = ["cf-ray", "cf-connecting-ip", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "forwarded"] as const;

export function deviceOriginVia(req: IncomingMessage | undefined, publicHost?: string): DeviceOriginVia {
  if (req === undefined) return "lan";
  for (const header of PROXY_HEADERS) {
    if (req.headers[header] !== undefined) return "tunnel";
  }
  if (publicHost !== undefined) {
    const host = req.headers.host?.toLowerCase();
    if (host !== undefined && hostOnly(host) === publicHost) return "tunnel";
  }
  return "lan";
}

/** The host of an origin, lowercased and without a port, or undefined when there is no origin. */
export function publicHostOf(publicUrl: string | undefined): string | undefined {
  if (publicUrl === undefined) return undefined;
  try {
    return new URL(publicUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function hostOnly(host: string): string {
  if (host.startsWith("[")) return host.slice(1, host.indexOf("]"));
  const colon = host.lastIndexOf(":");
  return colon === -1 ? host : host.slice(0, colon);
}
