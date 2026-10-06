import type { HermesBridgeConfig } from "../../src/config.ts";

/** A deliberately inert control-plane endpoint for tests that construct an app directly.
 * Tests that start the gateway should override `url` with the fake Hermes server they own. */
export function testHermes(url = "ws://127.0.0.1:1/api/ws"): HermesBridgeConfig {
  return {
    url,
    tokenEnv: "TEST_HERMES_CONTROL_TOKEN",
    profiles: { mock: { tokenEnv: "TEST_ATTACH_TOKEN", name: "Mock" } },
  };
}
