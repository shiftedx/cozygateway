import { QrCapacityError, encodeQr, renderQrHalfBlocks } from "./qr.ts";

export interface PreparedPairingOutput {
  setupCode: string;
  payloadJson: string;
  terminalOutput: string;
}

export interface PairingOutputInput {
  gatewayUrl: string;
  setupCode: string;
  ttlMs: number;
  color: boolean;
  strictQr: boolean;
}

function describeTtl(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return days === 1 ? "1 day" : `${days} days`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

function isLoopbackUrl(url: string): boolean {
  const hostname = new URL(url).hostname;
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

export function preparePairingOutput(input: PairingOutputInput): PreparedPairingOutput {
  const payloadJson = JSON.stringify({ gatewayUrl: input.gatewayUrl, setupCode: input.setupCode });
  const lines: string[] = [];
  try {
    lines.push(renderQrHalfBlocks(encodeQr(payloadJson), { color: input.color }));
  } catch (error) {
    if (input.strictQr || !(error instanceof QrCapacityError)) throw error;
    lines.push("QR omitted: the pairing payload is too large to encode. Use the URL and code below.");
  }
  lines.push(
    payloadJson,
    `Gateway URL: ${input.gatewayUrl}`,
    `Setup code:  ${input.setupCode}`,
    "Scan the QR code with CozyChat, or type the gateway URL and setup code in the app.",
    `Setup code ${input.setupCode} is valid for ${describeTtl(input.ttlMs)}. Mint a fresh one with: cozygateway pair`,
  );
  if (isLoopbackUrl(input.gatewayUrl)) {
    lines.push(
      "This URL is loopback, so only this machine can reach it. Remote access (Tailscale and friends) is documented at https://cozylabs.ai/docs/access/.",
    );
  }
  return {
    setupCode: input.setupCode,
    payloadJson,
    terminalOutput: `${lines.join("\n")}\n`,
  };
}
