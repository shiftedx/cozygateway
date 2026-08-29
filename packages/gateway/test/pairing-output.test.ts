import { describe, expect, it } from "vitest";

import { preparePairingOutput } from "../src/pairing-output.ts";
import { QrCapacityError } from "../src/qr.ts";

describe("preparePairingOutput", () => {
  it("buffers the exact CozyChat payload and complete pairing finale", () => {
    const prepared = preparePairingOutput({
      gatewayUrl: "https://cozy.example.ts.net",
      setupCode: "COZY-1234",
      ttlMs: 10 * 60_000,
      color: false,
      strictQr: false,
    });

    expect(prepared.setupCode).toBe("COZY-1234");
    expect(prepared.payloadJson).toBe(
      '{"gatewayUrl":"https://cozy.example.ts.net","setupCode":"COZY-1234"}',
    );
    expect(prepared.terminalOutput).toContain(prepared.payloadJson);
    expect(prepared.terminalOutput).toContain("Gateway URL: https://cozy.example.ts.net");
    expect(prepared.terminalOutput).toContain("Setup code:  COZY-1234");
    expect(prepared.terminalOutput).toContain("valid for 10 minutes");
    expect(prepared.terminalOutput.endsWith("\n")).toBe(true);
  });

  it("keeps the legacy plain-text fallback when the payload exceeds QR capacity", () => {
    const prepared = preparePairingOutput({
      gatewayUrl: `https://example.com/${"a".repeat(220)}`,
      setupCode: "COZY-1234",
      ttlMs: 14 * 24 * 60 * 60_000,
      color: false,
      strictQr: false,
    });

    expect(prepared.terminalOutput).toContain("QR omitted: the pairing payload is too large to encode.");
    expect(prepared.terminalOutput).toContain("valid for 14 days");
  });

  it("rejects an oversized QR before returning any onboarding output", () => {
    expect(() => preparePairingOutput({
      gatewayUrl: `https://example.com/${"a".repeat(220)}`,
      setupCode: "COZY-1234",
      ttlMs: 10 * 60_000,
      color: false,
      strictQr: true,
    })).toThrow(QrCapacityError);
  });
});
