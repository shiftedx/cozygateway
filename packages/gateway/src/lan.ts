/** A normalized, versioned projection produced by CozyGateway's fixed Windows helper.
 *
 * Node deliberately does not classify adapters from `os.networkInterfaces()`: that API exposes
 * addresses but cannot prove that an interface is physical Ethernet/Wi-Fi, Up, or a software
 * adapter. Display names are retained only so a later interactive flow can identify choices to a
 * person; selection never interprets or regexes localized names.
 */
export interface WindowsLanInventory {
  schemaVersion: 1;
  adapters: WindowsLanAdapter[];
}

export interface WindowsLanAdapter {
  /** Stable helper-provided interface identifier, not a localized display name. */
  id: string;
  displayName: string;
  /** Machine-normalized media classification from the helper. */
  kind: "ethernet" | "wifi" | "other";
  hardwareInterface: boolean;
  /** Machine-normalized operational status from the helper. */
  status: "up" | "down" | "disabled" | "unknown";
  ipv4Addresses: string[];
}

export interface PhysicalLanCandidate {
  adapterId: string;
  displayName: string;
  kind: "ethernet" | "wifi";
  address: string;
}

export type PhysicalLanSelection =
  | { outcome: "selected"; candidate: PhysicalLanCandidate }
  | {
      outcome: "paused";
      reason: "no_up_physical_private_ipv4" | "multiple_up_physical_private_ipv4";
      candidates: PhysicalLanCandidate[];
    };

function ipv4Octets(address: string): [number, number, number, number] | undefined {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^(?:0|[1-9]\d{0,2})$/.test(part))) return undefined;
  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) return undefined;
  return octets as [number, number, number, number];
}

/** Exact RFC1918 IPv4 classification. Public, loopback, 169.254/16, and Tailscale's
 * 100.64/10 range fail closed because none belongs to the three private ranges. */
export function isRfc1918Ipv4(address: string): boolean {
  const octets = ipv4Octets(address);
  if (octets === undefined) return false;
  const [first, second] = octets;
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

/** Selects only when the helper proves there is exactly one eligible address. Ambiguity and lack
 * of a candidate are resumable outcomes: callers can wait for network state to settle or present
 * the bounded candidate list for an explicit advanced choice. */
export function selectPhysicalLanCandidate(inventory: WindowsLanInventory): PhysicalLanSelection {
  const candidates: PhysicalLanCandidate[] = [];
  for (const adapter of inventory.adapters) {
    if (
      adapter.status !== "up"
      || !adapter.hardwareInterface
      || (adapter.kind !== "ethernet" && adapter.kind !== "wifi")
    ) continue;
    for (const address of adapter.ipv4Addresses) {
      if (!isRfc1918Ipv4(address)) continue;
      candidates.push({
        adapterId: adapter.id,
        displayName: adapter.displayName,
        kind: adapter.kind,
        address,
      });
    }
  }
  if (candidates.length === 1) return { outcome: "selected", candidate: candidates[0]! };
  if (candidates.length === 0) {
    return { outcome: "paused", reason: "no_up_physical_private_ipv4", candidates };
  }
  return { outcome: "paused", reason: "multiple_up_physical_private_ipv4", candidates };
}

/** Compatibility-shaped convenience for pairing callers. Without fixed helper inventory there is
 * intentionally no answer; CozyGateway never guesses a physical LAN from Node's address list. */
export function primaryLanAddress(inventory?: WindowsLanInventory): string | undefined {
  if (inventory === undefined) return undefined;
  const selection = selectPhysicalLanCandidate(inventory);
  return selection.outcome === "selected" ? selection.candidate.address : undefined;
}
