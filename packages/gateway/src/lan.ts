/** Picks the address a phone on the same network should dial.
 *
 *  The pairing QR is scanned by a phone, so `127.0.0.1` in the payload sends every scan at the
 *  phone itself. When the gateway listens beyond loopback, the payload should carry the LAN
 *  address of the machine the install just bound. Preference order: RFC1918 private IPv4 (the
 *  home-network case the simple install track exists for), then any other external IPv4 (a
 *  tailnet or public address is still phone-reachable). Link-local addresses never qualify.
 */

import { networkInterfaces } from "node:os";

export interface LanCandidate {
  address: string;
  family: string | number;
  internal: boolean;
}

export type InterfaceMap = Record<string, LanCandidate[] | undefined>;

function isPrivateIpv4(address: string): boolean {
  if (address.startsWith("10.") || address.startsWith("192.168.")) return true;
  const octets = address.split(".");
  return octets[0] === "172" && Number(octets[1]) >= 16 && Number(octets[1]) <= 31;
}

/** The primary LAN IPv4 address, or `undefined` when the machine has none. */
export function primaryLanAddress(interfaces: InterfaceMap = networkInterfaces()): string | undefined {
  const candidates: string[] = [];
  for (const name of Object.keys(interfaces)) {
    for (const entry of interfaces[name] ?? []) {
      const ipv4 = entry.family === "IPv4" || entry.family === 4;
      if (!ipv4 || entry.internal || entry.address.startsWith("169.254.")) continue;
      candidates.push(entry.address);
    }
  }
  return candidates.find(isPrivateIpv4) ?? candidates[0];
}
