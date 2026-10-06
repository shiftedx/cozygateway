import { expect, it } from "vitest";

import { HermesBridge } from "../src/hermes-bridge/bridge.ts";
import { createHermesClient } from "../src/hermes-bridge/client.ts";
import { openStorage } from "../src/storage.ts";
import { startFakeHermesServer } from "./support/fake-hermes-server.ts";

it("loads the initial roster when Hermes connected before bridge subscriptions", async () => {
  const server = await startFakeHermesServer({
    methods: {
      "profiles.list": () => ({
        profiles: [{ name: "sage", description: "ready before bridge", has_avatar: false }],
      }),
    },
  });
  const storage = openStorage(":memory:");
  const client = createHermesClient({ url: server.url, auth: { mode: "token", token: "fixture" } });
  const bridge = new HermesBridge({ client, storage, broadcast: () => {}, now: Date.now });
  try {
    // startGateway connects early for discovery, before it constructs the bridge.
    client.start();
    await expect.poll(() => client.state()).toBe("online");
    expect(server.callsOf("profiles.list")).toHaveLength(0);
    bridge.start();
    await expect.poll(() => storage.botRoster().bots.map((bot) => bot.name)).toEqual(["sage"]);
    expect(server.totalConnections()).toBe(1);
  } finally {
    await bridge.close();
    storage.close();
    await server.close();
  }
});
