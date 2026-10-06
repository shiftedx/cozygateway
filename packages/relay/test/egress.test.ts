import { describe, expect, it } from "vitest";

import { isBlockedAddress, isBlockedLiteralHost, isLoopbackBindHost, stripIpv6Brackets } from "../src/egress.ts";

describe("stripIpv6Brackets", () => {
  it("strips brackets from a bracketed IPv6 literal", () => {
    expect(stripIpv6Brackets("[::1]")).toBe("::1");
  });

  it("leaves an unbracketed host untouched", () => {
    expect(stripIpv6Brackets("example.com")).toBe("example.com");
    expect(stripIpv6Brackets("127.0.0.1")).toBe("127.0.0.1");
  });
});

describe("isBlockedAddress", () => {
  it("blocks IPv4 loopback, link-local, and RFC1918 ranges", () => {
    expect(isBlockedAddress("127.0.0.1", 4)).toBe(true);
    expect(isBlockedAddress("127.255.255.255", 4)).toBe(true);
    expect(isBlockedAddress("169.254.1.1", 4)).toBe(true);
    expect(isBlockedAddress("10.0.0.5", 4)).toBe(true);
    expect(isBlockedAddress("172.16.0.1", 4)).toBe(true);
    expect(isBlockedAddress("172.31.255.255", 4)).toBe(true);
    expect(isBlockedAddress("192.168.1.1", 4)).toBe(true);
    expect(isBlockedAddress("0.0.0.0", 4)).toBe(true);
  });

  it("does not block a boundary-adjacent or public IPv4 address", () => {
    expect(isBlockedAddress("172.15.255.255", 4)).toBe(false); // just below 172.16.0.0/12
    expect(isBlockedAddress("172.32.0.0", 4)).toBe(false); // just above 172.16.0.0/12
    expect(isBlockedAddress("8.8.8.8", 4)).toBe(false);
    expect(isBlockedAddress("1.1.1.1", 4)).toBe(false);
  });

  it("blocks IPv6 loopback, link-local, unique-local, and unspecified", () => {
    expect(isBlockedAddress("::1", 6)).toBe(true);
    expect(isBlockedAddress("fe80::1", 6)).toBe(true);
    expect(isBlockedAddress("fc00::1", 6)).toBe(true);
    expect(isBlockedAddress("fd12:3456:789a::1", 6)).toBe(true);
    expect(isBlockedAddress("::", 6)).toBe(true);
  });

  it("does not block a public IPv6 address", () => {
    expect(isBlockedAddress("2001:4860:4860::8888", 6)).toBe(false);
  });

  it("blocks IPv4-mapped IPv6 forms of blocked IPv4 addresses", () => {
    expect(isBlockedAddress("::ffff:127.0.0.1", 6)).toBe(true);
    expect(isBlockedAddress("::ffff:10.0.0.5", 6)).toBe(true);
    expect(isBlockedAddress("::ffff:192.168.1.1", 6)).toBe(true);
    expect(isBlockedAddress("::ffff:169.254.1.1", 6)).toBe(true);
  });

  it("does not block an IPv4-mapped IPv6 form of a public IPv4 address", () => {
    expect(isBlockedAddress("::ffff:8.8.8.8", 6)).toBe(false);
  });
});

describe("isBlockedLiteralHost", () => {
  it("blocks a literal private/loopback/link-local IP host", () => {
    expect(isBlockedLiteralHost("127.0.0.1")).toBe(true);
    expect(isBlockedLiteralHost("10.1.2.3")).toBe(true);
    expect(isBlockedLiteralHost("169.254.169.254")).toBe(true); // cloud metadata address
    expect(isBlockedLiteralHost("::1")).toBe(true);
    expect(isBlockedLiteralHost("fd00::1")).toBe(true);
  });

  it("allows a public literal IP host", () => {
    expect(isBlockedLiteralHost("8.8.8.8")).toBe(false);
    expect(isBlockedLiteralHost("2001:4860:4860::8888")).toBe(false);
  });

  it("is false for a non-IP hostname (a DNS name is vetted at delivery time instead)", () => {
    expect(isBlockedLiteralHost("attacker.example")).toBe(false);
    expect(isBlockedLiteralHost("localhost")).toBe(false);
  });
});

describe("isLoopbackBindHost", () => {
  it("treats loopback IPs and localhost as loopback binds", () => {
    expect(isLoopbackBindHost("127.0.0.1")).toBe(true);
    expect(isLoopbackBindHost("127.5.6.7")).toBe(true);
    expect(isLoopbackBindHost("::1")).toBe(true);
    expect(isLoopbackBindHost("localhost")).toBe(true);
    expect(isLoopbackBindHost("LOCALHOST")).toBe(true);
  });

  it("treats a wildcard or public bind host as not loopback", () => {
    expect(isLoopbackBindHost("0.0.0.0")).toBe(false);
    expect(isLoopbackBindHost("203.0.113.5")).toBe(false);
    expect(isLoopbackBindHost("::")).toBe(false);
  });
});
