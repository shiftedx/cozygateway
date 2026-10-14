import { afterEach, describe, expect, it } from "vitest";

import { testHermes } from "./support/test-config.ts";
import { openStorage, type Storage } from "../src/storage.ts";
import { createHermesClient } from "../src/hermes-bridge/client.ts";
import { HermesBridge } from "../src/hermes-bridge/bridge.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

/** Capability 88 on a namespaced federation endpoint. Team rows are keyed by the PUBLIC name
 *  (`<endpoint>:<profile>`), the same name `PATCH /bots/:name/profile` was called with, but
 *  `profiles.list` and this bridge's own roster cache only ever speak bare Hermes profile ids. A
 *  roster read that looks a bare name straight up in the team table either misses its own leader
 *  or, worse, picks up an unrelated bot's row that happens to share the bare name. */

const servers: FakeHermesServer[] = [];
const bridges: HermesBridge[] = [];
const storages: Storage[] = [];
afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.close();
  for (const server of servers.splice(0)) await server.close();
  for (const storage of storages.splice(0)) storage.close();
});

async function setup(): Promise<{ storage: Storage; server: FakeHermesServer }> {
  const server = await startFakeHermesServer({
    methods: {
      "profiles.list": () => ({
        profiles: [
          { name: "lead", description: "", has_avatar: false },
          { name: "scout", description: "", has_avatar: false },
        ],
        bot_mode_protocol: true,
      }),
    },
  });
  servers.push(server);
  const storage = openStorage(":memory:");
  storages.push(storage);
  const client = createHermesClient({ url: server.url, auth: { mode: "token", token: "T" }, reconnect: { minMs: 15, maxMs: 60 } });
  const bridge = new HermesBridge({
    client, storage, broadcast: () => {}, now: () => 1_000, logSink: () => {}, hiddenProfiles: [],
    roomMemberNamespace: "ep",
  });
  bridges.push(bridge);
  bridge.start();
  for (const start = Date.now(); client.state() !== "online";) {
    if (Date.now() - start > 4_000) throw new Error("hermes client never came online");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { storage, server };
}

const pollRole = async (storage: Storage, name: string, want: "leader" | undefined): Promise<void> => {
  for (const start = Date.now(); Date.now() - start < 2_000;) {
    const row = storage.botRoster().bots.find((bot) => bot.name === name) as { role?: "leader" } | undefined;
    if (row !== undefined && (row.role ?? undefined) === want) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${name}'s roster role never became ${String(want)}`);
};

describe("team role on a namespaced federation endpoint", () => {
  it("finds its own leader by the public name, and never picks up a bare bot's row of the same name", async () => {
    const { storage } = await setup();
    // The gateway's own bare "scout" (a different bot entirely, elsewhere on this gateway) is a
    // leader; its row is keyed by its own bare name, no namespace.
    storage.setBotTeam({ bot: "scout", role: "leader", reports: [], updatedAt: 1 });
    // This endpoint's own "lead" was promoted the way PATCH stores it: under its PUBLIC name.
    storage.setBotTeam({ bot: "ep:lead", role: "leader", reports: [], updatedAt: 1 });

    await pollRole(storage, "lead", "leader");
    await pollRole(storage, "scout", undefined);
  });
});
