import { describe, expect, it } from "vitest";

import { primaryLanAddress } from "../src/lan.ts";

describe("primaryLanAddress", () => {
  it("prefers a private RFC1918 address over a tailnet-style address listed first", () => {
    expect(
      primaryLanAddress({
        utun3: [{ address: "100.64.7.9", family: "IPv4", internal: false }],
        en0: [{ address: "192.168.1.23", family: "IPv4", internal: false }],
      }),
    ).toBe("192.168.1.23");
  });

  it("falls back to the first external IPv4 when no private address exists", () => {
    expect(
      primaryLanAddress({
        utun3: [{ address: "100.64.7.9", family: "IPv4", internal: false }],
      }),
    ).toBe("100.64.7.9");
  });

  it("skips loopback, IPv6, and link-local entries", () => {
    expect(
      primaryLanAddress({
        lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        en0: [
          { address: "fe80::1", family: "IPv6", internal: false },
          { address: "169.254.10.10", family: "IPv4", internal: false },
          { address: "10.0.0.5", family: "IPv4", internal: false },
        ],
      }),
    ).toBe("10.0.0.5");
  });

  it("accepts the numeric family form newer Node versions emit", () => {
    expect(primaryLanAddress({ en0: [{ address: "172.16.9.2", family: 4, internal: false }] })).toBe("172.16.9.2");
  });

  it("treats only 172.16/12 as private", () => {
    expect(
      primaryLanAddress({
        en0: [
          { address: "172.32.0.1", family: "IPv4", internal: false },
          { address: "172.31.0.1", family: "IPv4", internal: false },
        ],
      }),
    ).toBe("172.31.0.1");
  });

  it("returns undefined on a machine with no external IPv4", () => {
    expect(primaryLanAddress({ lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }] })).toBeUndefined();
  });
});
