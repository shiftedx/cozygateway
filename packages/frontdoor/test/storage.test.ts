import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { credentialHash, newCredential, newHouseholdId } from "../src/ids.ts";
import { openFrontdoorStorage, type FrontdoorStorage } from "../src/storage.ts";

let dir: string | undefined;
let storage: FrontdoorStorage | undefined;

afterEach(() => {
  storage?.close();
  storage = undefined;
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function open(): FrontdoorStorage {
  dir = mkdtempSync(join(tmpdir(), "frontdoor-"));
  storage = openFrontdoorStorage(join(dir, "frontdoor.db"));
  return storage;
}

describe("ids", () => {
  it("generates prefixed ids and stable hashes", () => {
    expect(newHouseholdId()).toMatch(/^hh_[0-9a-f]{12}$/);
    const c = newCredential();
    expect(c).toMatch(/^fdc_[0-9a-f]{48}$/);
    expect(credentialHash(c)).toBe(credentialHash(c));
    expect(credentialHash(c)).not.toContain(c.slice(4, 20));
  });
});

describe("storage", () => {
  it("provisions from the pool, one hostname per household, until exhausted", () => {
    const s = open();
    s.syncPool(["relay-01.cozylabs.ai", "relay-02.cozylabs.ai"]);
    const a = s.provisionHousehold(1000);
    const b = s.provisionHousehold(2000);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.hostname).not.toBe(b!.hostname);
    expect(s.provisionHousehold(3000)).toBeUndefined(); // pool exhausted
    expect(s.householdCount()).toBe(2);
  });

  it("resolves credentials and hostnames back to household ids, storing only hashes", () => {
    const s = open();
    s.syncPool(["relay-01.cozylabs.ai"]);
    const p = s.provisionHousehold(1000)!;
    expect(s.householdIdForCredential(p.credential)).toBe(p.householdId);
    expect(s.householdIdForCredential("fdc_" + "0".repeat(48))).toBeUndefined();
    expect(s.householdIdForHostname(p.hostname)).toBe(p.householdId);
    expect(s.householdIdForHostname("nope.cozylabs.ai")).toBeUndefined();
  });

  it("syncPool is idempotent and additive", () => {
    const s = open();
    s.syncPool(["relay-01.cozylabs.ai"]);
    s.provisionHousehold(1000);
    s.syncPool(["relay-01.cozylabs.ai", "relay-02.cozylabs.ai"]);
    expect(s.provisionHousehold(2000)!.hostname).toBe("relay-02.cozylabs.ai");
  });
});
