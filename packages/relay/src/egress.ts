import { BlockList, isIP } from "node:net";

/**
 * Address ranges a restricted relay refuses to deliver webhooks to (design decision,
 * issue #8): loopback, link-local, RFC1918/ULA private, and the unspecified addresses.
 * `BlockList.check` treats IPv4-mapped IPv6 addresses (e.g. "::ffff:127.0.0.1") checked
 * as "ipv6" as also matching any "ipv4" rule on the embedded address, so this single
 * list covers the mapped forms too without extra bookkeeping.
 */
function buildRestrictedRanges(): BlockList {
  const blockList = new BlockList();
  blockList.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
  blockList.addSubnet("169.254.0.0", 16, "ipv4"); // link-local
  blockList.addSubnet("10.0.0.0", 8, "ipv4"); // RFC1918
  blockList.addSubnet("172.16.0.0", 12, "ipv4"); // RFC1918
  blockList.addSubnet("192.168.0.0", 16, "ipv4"); // RFC1918
  blockList.addAddress("0.0.0.0", "ipv4"); // unspecified
  blockList.addSubnet("::1", 128, "ipv6"); // loopback
  blockList.addSubnet("fe80::", 10, "ipv6"); // link-local
  blockList.addSubnet("fc00::", 7, "ipv6"); // unique local (private)
  blockList.addAddress("::", "ipv6"); // unspecified
  return blockList;
}

const RESTRICTED_RANGES = buildRestrictedRanges();

/** A separate, narrower list used only to decide the CLI's restrict-egress default:
 *  is the configured bind host a loopback address (the self-host dev default)? */
function buildLoopbackOnlyRanges(): BlockList {
  const blockList = new BlockList();
  blockList.addSubnet("127.0.0.0", 8, "ipv4");
  blockList.addSubnet("::1", 128, "ipv6");
  return blockList;
}

const LOOPBACK_ONLY_RANGES = buildLoopbackOnlyRanges();

/** Strips the brackets the WHATWG URL parser puts around an IPv6 literal hostname
 *  (`new URL("http://[::1]/x").hostname === "[::1]"`), which `net.isIP` rejects. */
export function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/** True when `address` (a real, already-resolved address, family 4 or 6) falls in a
 *  restricted range. This is the check applied at delivery time to the resolved
 *  address, and at registration time to a literal-IP token host. */
export function isBlockedAddress(address: string, family: 4 | 6): boolean {
  return RESTRICTED_RANGES.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** True when `hostname` is itself a literal IP (v4 or v6, brackets already stripped)
 *  that falls in a restricted range. False for anything that is not a literal IP
 *  address (a DNS name is not vetted here; it is vetted at delivery time once resolved). */
export function isBlockedLiteralHost(hostname: string): boolean {
  const family = isIP(hostname);
  if (family === 0) return false;
  return isBlockedAddress(hostname, family as 4 | 6);
}

/** True when `host` (a relay CLI `--host` bind value) is loopback: a literal loopback
 *  IP, or the "localhost" name. Used only to pick the restrict-egress default. */
export function isLoopbackBindHost(host: string): boolean {
  const stripped = stripIpv6Brackets(host);
  if (stripped.toLowerCase() === "localhost") return true;
  const family = isIP(stripped);
  if (family === 0) return false;
  return LOOPBACK_ONLY_RANGES.check(stripped, family === 4 ? "ipv4" : "ipv6");
}
