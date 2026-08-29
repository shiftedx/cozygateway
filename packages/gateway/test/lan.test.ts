import { describe, expect, it } from "vitest";

import {
  primaryLanAddress,
  selectPhysicalLanCandidate,
  type WindowsLanAdapter,
  type WindowsLanInventory,
} from "../src/lan.ts";

function adapter(overrides: Partial<WindowsLanAdapter> = {}): WindowsLanAdapter {
  return {
    id: "ethernet-1",
    displayName: "Ethernet",
    kind: "ethernet",
    hardwareInterface: true,
    status: "up",
    ipv4Addresses: ["192.168.1.23"],
    ...overrides,
  };
}

function inventory(adapters: WindowsLanAdapter[]): WindowsLanInventory {
  return { schemaVersion: 1, adapters };
}

describe("strict physical LAN selection", () => {
  it.each(["10.90.1.2", "172.16.0.1", "172.31.255.254", "192.168.240.8"])(
    "accepts the RFC1918 address %s from one Up physical Ethernet adapter",
    (address) => {
      const result = selectPhysicalLanCandidate(inventory([
        adapter({ displayName: "Connexion locale #7", ipv4Addresses: [address] }),
      ]));

      expect(result).toEqual({
        outcome: "selected",
        candidate: {
          adapterId: "ethernet-1",
          displayName: "Connexion locale #7",
          kind: "ethernet",
          address,
        },
      });
      expect(primaryLanAddress(inventory([adapter({ ipv4Addresses: [address] })]))).toBe(address);
    },
  );

  it("uses helper-provided Wi-Fi classification without interpreting a localized or arbitrary name", () => {
    expect(selectPhysicalLanCandidate(inventory([
      adapter({
        id: "wifi-guid",
        displayName: "家の接続 (Hyper-V is only text here)",
        kind: "wifi",
        ipv4Addresses: ["192.168.50.10"],
      }),
    ]))).toMatchObject({
      outcome: "selected",
      candidate: { adapterId: "wifi-guid", kind: "wifi", address: "192.168.50.10" },
    });
  });

  it("rejects loopback, public, link-local, Tailscale, virtual, software, and disconnected entries", () => {
    const result = selectPhysicalLanCandidate(inventory([
      adapter({ id: "loopback", ipv4Addresses: ["127.0.0.1"] }),
      adapter({ id: "public", ipv4Addresses: ["8.8.8.8"] }),
      adapter({ id: "link-local", ipv4Addresses: ["169.254.2.3"] }),
      adapter({ id: "tailscale", kind: "other", hardwareInterface: false, ipv4Addresses: ["100.64.7.9"] }),
      adapter({ id: "hyper-v", kind: "other", hardwareInterface: false, ipv4Addresses: ["192.168.100.1"] }),
      adapter({ id: "wsl", kind: "other", hardwareInterface: false, ipv4Addresses: ["172.25.64.1"] }),
      adapter({ id: "container", kind: "other", hardwareInterface: false, ipv4Addresses: ["172.18.0.1"] }),
      adapter({ id: "disabled", status: "disabled", ipv4Addresses: ["192.168.2.3"] }),
      adapter({ id: "down", status: "down", ipv4Addresses: ["192.168.3.4"] }),
      adapter({ id: "vpn", kind: "other", hardwareInterface: false, ipv4Addresses: ["10.20.30.40"] }),
      adapter({ id: "real-wifi", displayName: "Wi-Fi 4", kind: "wifi", ipv4Addresses: ["10.0.0.5"] }),
    ]));

    expect(result).toMatchObject({
      outcome: "selected",
      candidate: { adapterId: "real-wifi", address: "10.0.0.5" },
    });
  });

  it("pauses with structured candidates when physical Ethernet and Wi-Fi are both eligible", () => {
    expect(selectPhysicalLanCandidate(inventory([
      adapter({ id: "wired", displayName: "Dock", kind: "ethernet", ipv4Addresses: ["192.168.1.20"] }),
      adapter({ id: "wireless", displayName: "Maison", kind: "wifi", ipv4Addresses: ["10.0.0.8"] }),
    ]))).toEqual({
      outcome: "paused",
      reason: "multiple_up_physical_private_ipv4",
      candidates: [
        { adapterId: "wired", displayName: "Dock", kind: "ethernet", address: "192.168.1.20" },
        { adapterId: "wireless", displayName: "Maison", kind: "wifi", address: "10.0.0.8" },
      ],
    });
  });

  it("pauses instead of choosing when one physical adapter owns two private addresses", () => {
    expect(selectPhysicalLanCandidate(inventory([
      adapter({ ipv4Addresses: ["192.168.1.20", "10.0.0.8"] }),
    ]))).toMatchObject({
      outcome: "paused",
      reason: "multiple_up_physical_private_ipv4",
      candidates: [
        { adapterId: "ethernet-1", address: "192.168.1.20" },
        { adapterId: "ethernet-1", address: "10.0.0.8" },
      ],
    });
  });

  it("returns a retryable reason rather than guessing when no safe candidate exists", () => {
    expect(selectPhysicalLanCandidate(inventory([
      adapter({ status: "down" }),
      adapter({ id: "public", ipv4Addresses: ["203.0.113.7"] }),
    ]))).toEqual({
      outcome: "paused",
      reason: "no_up_physical_private_ipv4",
      candidates: [],
    });
    expect(primaryLanAddress()).toBeUndefined();
  });

  it("rejects malformed IPv4 strings rather than accepting prefix lookalikes", () => {
    expect(selectPhysicalLanCandidate(inventory([
      adapter({ ipv4Addresses: ["192.168.1.1.evil", "10.0.0.999", "172.16.1"] }),
    ]))).toMatchObject({ outcome: "paused", reason: "no_up_physical_private_ipv4" });
  });
});
