import { describe, it, expect } from "vitest";

import { ATTACH_V1_CAPABILITIES } from "../src/adapters/attach/ingress-v1.ts";
import {
  AttachV1CapabilitySchema, AttachV1MobileFailureReasonSchema, AttachV1MobileFailureStageSchema,
} from "../src/adapters/attach/protocol-v1.ts";
import { MOBILE_NODE_FAILURE_REASONS, MOBILE_NODE_FAILURE_STAGES } from "../src/mobile-node.ts";

/**
 * The schema says which capability names are legal; this list says which ones the gateway will
 * actually negotiate. `satisfies readonly AttachV1Capability[]` proves every entry is a real
 * capability but says nothing about the list being complete, so adding a capability to the schema
 * and forgetting it here compiles, passes every other test, and then quietly refuses the surface
 * at hello: the plugin offers it, the gateway drops it, and every request for it dies as
 * `device_unavailable` with nothing in the code looking wrong.
 *
 * That is exactly how camera capture, file picking and actionable notifications shipped dead.
 */

function schemaCapabilities(): string[] {
  return AttachV1CapabilitySchema.anyOf.map((member) => member.const as string);
}

describe("the capabilities the gateway will negotiate", () => {
  it("are every capability the schema defines, so none ships dead", () => {
    expect([...ATTACH_V1_CAPABILITIES].sort()).toEqual(schemaCapabilities().sort());
  });

  it("contain no duplicates", () => {
    expect(new Set(ATTACH_V1_CAPABILITIES).size).toBe(ATTACH_V1_CAPABILITIES.length);
  });

  it("keeps the attach diagnostic vocabulary identical to the broker catalog", () => {
    expect(AttachV1MobileFailureStageSchema.anyOf.map((member) => member.const).sort())
      .toEqual([...MOBILE_NODE_FAILURE_STAGES].sort());
    expect(AttachV1MobileFailureReasonSchema.anyOf.map((member) => member.const).sort())
      .toEqual([...MOBILE_NODE_FAILURE_REASONS].sort());
  });
});
