import { afterEach, describe, expect, it } from "vitest";

import { parseCliConfig } from "../src/cli.ts";
import {
  createRelayApp,
  DEFAULT_NOTIFY_RATE_LIMIT_PER_MINUTE,
  DEFAULT_REGISTER_RATE_LIMIT_PER_MINUTE,
} from "../src/http.ts";
import { CIPHERTEXT_MAX_LENGTH } from "../src/schemas.ts";
import { DEFAULT_DAILY_CAP, DEFAULT_MAX_REGISTRATIONS } from "../src/server.ts";
import { DEFAULT_REGISTRATION_TTL_DAYS, openRelayStorage, utcDay, type RelayStorage } from "../src/storage.ts";

const NOW = Date.UTC(2026, 7, 21, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;
const storages: RelayStorage[] = [];

afterEach(() => {
  for (const storage of storages.splice(0)) storage.close();
});

function storage(): RelayStorage {
  const result = openRelayStorage(":memory:");
  storages.push(result);
  return result;
}

function app(db: RelayStorage, now = NOW) {
  return createRelayApp({
    storage: db,
    transports: { webhook: { deliver: async () => {} } },
    dailyCap: DEFAULT_DAILY_CAP,
    maxRegistrations: DEFAULT_MAX_REGISTRATIONS,
    registrationTtlDays: DEFAULT_REGISTRATION_TTL_DAYS,
    version: "public-defaults-test",
    now: () => now,
    restrictEgress: true,
    trustForwarded: true,
    sourceIp: () => "cloudflare-peer",
  });
}

describe("public-instance defaults", () => {
  it("pins source rates, caps, TTL, trusted proxy flag, and non-loopback egress restriction", () => {
    expect(DEFAULT_REGISTER_RATE_LIMIT_PER_MINUTE).toBe(10);
    expect(DEFAULT_NOTIFY_RATE_LIMIT_PER_MINUTE).toBe(60);
    expect(DEFAULT_DAILY_CAP).toBe(500);
    expect(DEFAULT_MAX_REGISTRATIONS).toBe(10_000);
    expect(DEFAULT_REGISTRATION_TTL_DAYS).toBe(30);
    expect(parseCliConfig(["--host", "0.0.0.0", "--trust-forwarded"])).toMatchObject({
      restrictEgress: true,
      trustForwarded: true,
    });
  });

  it("enforces the 10000 registration backstop at its public default", async () => {
    const db = storage();
    for (let i = 0; i < DEFAULT_MAX_REGISTRATIONS; i += 1) {
      expect(
        db.saveRegistration(
          { pushId: `p${i}`, platform: "webhook", token: "https://x.example/hook", createdAt: NOW },
          DEFAULT_MAX_REGISTRATIONS,
        ),
      ).toBe(true);
    }
    const res = await app(db).request("/register", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.1" },
      body: JSON.stringify({ platform: "webhook", token: "https://x.example/hook" }),
    });
    expect(res.status).toBe(429);
  });

  it("enforces the 500-notify daily backstop at its public default", async () => {
    const db = storage();
    db.saveRegistration(
      { pushId: "p", platform: "webhook", token: "https://x.example/hook", createdAt: NOW },
      DEFAULT_MAX_REGISTRATIONS,
    );
    for (let i = 0; i < DEFAULT_DAILY_CAP; i += 1) db.incrementNotifyCount("p", utcDay(NOW));
    const res = await app(db).request("/notify", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.1" },
      body: JSON.stringify({ pushId: "p", ciphertext: "C" }),
    });
    expect(res.status).toBe(429);
  });

  it("enforces the default TTL and 8KB ciphertext bound", async () => {
    const db = storage();
    db.saveRegistration(
      { pushId: "expired", platform: "webhook", token: "https://x.example/hook", createdAt: NOW },
      DEFAULT_MAX_REGISTRATIONS,
    );
    const later = NOW + (DEFAULT_REGISTRATION_TTL_DAYS + 1) * DAY_MS;
    const expired = await app(db, later).request("/notify", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.1" },
      body: JSON.stringify({ pushId: "expired", ciphertext: "C" }),
    });
    expect(expired.status).toBe(404);

    db.saveRegistration(
      { pushId: "fresh", platform: "webhook", token: "https://x.example/hook", createdAt: later },
      DEFAULT_MAX_REGISTRATIONS,
    );
    const oversized = await app(db, later).request("/notify", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.2" },
      body: JSON.stringify({ pushId: "fresh", ciphertext: "x".repeat(CIPHERTEXT_MAX_LENGTH + 1) }),
    });
    expect(oversized.status).toBe(400);
  });
});
