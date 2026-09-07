/** Capabilities 70 and 71 (contract/ext-bots-v1.md rows 70 and 71).
 *
 *  Row 70: a person chooses which of their phones a capability request goes to. Row 68's binding
 *  is untouched: this only widens WHERE the one target device is resolved from, and once a request
 *  is admitted the target never moves.
 *
 *  Row 71: a composer draft follows the person rather than the phone they typed it on, and the
 *  clear that a send writes crosses devices, so a message sent on one phone is never still offered
 *  for sending on another. */
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { describe, expect, it, vi } from "vitest";

import {
  BOTS_CAPABILITY_VERSION,
  BotComposerDraftSchema,
  BotDraftUpdatedFrameSchema,
  BotMobilePreferredDeviceSchema,
  check,
} from "cozygateway-contract";

import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";
import { registerBotRoutes } from "../src/hermes-bridge/routes.ts";
import {
  MobileNodeBroker,
  resolveMobileTargetDevice,
  type MobileNodeLifecycleEvent,
  type MobileNodeRoute,
} from "../src/mobile-node.ts";
import { openStorage } from "../src/storage.ts";

const purpose = "Report phone readiness";

function available(): MobileNodeRoute {
  return {
    status: "available", selectedSocketPresent: true, selectedSocketOpen: true,
    commandAdvertised: true, connectedSocketCount: 1, foreground: true,
  };
}

function harness() {
  const lifecycle = vi.fn<(event: MobileNodeLifecycleEvent) => void>();
  const send = vi.fn((_deviceId: string, _frame: unknown) => "sent" as const);
  const broker = new MobileNodeBroker({
    lifecycle, wake: () => true, route: () => available(), send,
    result: vi.fn(), receipt: () => true, now: () => 1_000,
  });
  return { broker, lifecycle, send };
}

function statusRequest(deviceId: string) {
  return {
    requestId: "req-1", command: "device.status" as const, bot: "sage", threadId: "thread-1",
    turnId: "turn-1", expiresAt: 20_000, purpose, deviceId, agentId: "sage",
  };
}

function paired(...ids: string[]): (deviceId: string) => boolean {
  return (deviceId) => ids.includes(deviceId);
}

type Env = { Variables: { deviceId: string } };

function mount(surface: Partial<BotsSurface>): Hono<Env> {
  const app = new Hono<Env>();
  const requireDevice: MiddlewareHandler<Env> = async (c, next) => {
    c.set("deviceId", "device-1");
    await next();
  };
  registerBotRoutes(app, requireDevice, surface as unknown as BotsSurface);
  return app;
}

function storageWithDevices(...ids: string[]) {
  const store = openStorage(":memory:");
  for (const id of ids)
    store.createDevice({ id, name: id, tokenHash: `hash-${id}`, createdAt: 1_000 });
  return store;
}

describe("capability-70 explicit device selection", () => {
  it("advertises both new rows on the capability version", () => {
    expect(BOTS_CAPABILITY_VERSION).toBe(71);
  });

  it("a client can select which paired device a request targets", () => {
    const store = storageWithDevices("phone-a", "phone-b");
    // The person picks their second phone for this conversation.
    expect(store.setBotMobilePreferredDevice("sage", "thread-1", "phone-b", 2_000)).toBe("ok");
    const preference = store.botMobilePreferredDevice("sage", "thread-1");
    expect(preference).toMatchObject({ sessionId: "thread-1", deviceId: "phone-b", updatedAt: 2_000 });
    expect(check(BotMobilePreferredDeviceSchema, preference)).toBe(true);

    // Admission resolves the named device, NOT the device that opened the turn.
    const resolved = resolveMobileTargetDevice({
      preferred: preference.deviceId, turnOrigin: "phone-a", isPaired: paired("phone-a", "phone-b"),
    });
    expect(resolved).toEqual({ deviceId: "phone-b", source: "preference", droppedHint: false });

    // And the request is admitted against that device.
    const { broker, lifecycle, send } = harness();
    broker.invoke(statusRequest(resolved.deviceId!));
    expect(send.mock.calls.every((call) => call[0] === "phone-b")).toBe(true);
    expect(lifecycle.mock.calls[0]?.[0]).toMatchObject({ deviceId: "phone-b", state: "requested" });
    store.close();
  });

  it("prefers the peer's own hint, then the stored preference, then the turn origin", () => {
    const isPaired = paired("phone-a", "phone-b", "phone-c");
    expect(resolveMobileTargetDevice({
      hinted: "phone-c", preferred: "phone-b", turnOrigin: "phone-a", isPaired,
    })).toEqual({ deviceId: "phone-c", source: "hint", droppedHint: false });
    expect(resolveMobileTargetDevice({ turnOrigin: "phone-a", isPaired }))
      .toEqual({ deviceId: "phone-a", source: "turn_origin", droppedHint: false });
    // Nothing resolves: row 68's own `no_selected_device` outcome, unchanged.
    expect(resolveMobileTargetDevice({ isPaired }))
      .toEqual({ deviceId: undefined, source: "none", droppedHint: false });
  });

  it("drops an unpaired or malformed hint and falls through rather than refusing the request", () => {
    const isPaired = paired("phone-a");
    expect(resolveMobileTargetDevice({ hinted: "stranger", turnOrigin: "phone-a", isPaired }))
      .toEqual({ deviceId: "phone-a", source: "turn_origin", droppedHint: true });
    expect(resolveMobileTargetDevice({ hinted: "x".repeat(300), turnOrigin: "phone-a", isPaired }))
      .toEqual({ deviceId: "phone-a", source: "turn_origin", droppedHint: true });
    expect(resolveMobileTargetDevice({ hinted: "", turnOrigin: "phone-a", isPaired }))
      .toEqual({ deviceId: "phone-a", source: "turn_origin", droppedHint: true });
    // A stored preference that no longer names a paired device is skipped the same way.
    expect(resolveMobileTargetDevice({ preferred: "retired", turnOrigin: "phone-a", isPaired }))
      .toEqual({ deviceId: "phone-a", source: "turn_origin", droppedHint: false });
  });

  it("a second device attaching mid-request does not steal an explicitly targeted request", () => {
    const { broker, lifecycle, send } = harness();
    broker.invoke(statusRequest("phone-b"));
    const dispatched = send.mock.calls.length;

    // The device that opened the turn comes back. It is not the target and never becomes one.
    broker.reconnectDevice("phone-a");

    expect(send.mock.calls.length).toBe(dispatched);
    expect(send.mock.calls.every((call) => call[0] === "phone-b")).toBe(true);
    expect(lifecycle.mock.calls.every(
      (call) => (call[0] as MobileNodeLifecycleEvent).deviceId !== "phone-a",
    )).toBe(true);
  });

  it("a preference written after admission changes nothing about the request already admitted", () => {
    const store = storageWithDevices("phone-a", "phone-b");
    const { broker, lifecycle, send } = harness();
    broker.invoke(statusRequest("phone-a"));
    store.setBotMobilePreferredDevice("sage", "thread-1", "phone-b", 3_000);
    broker.reconnectDevice("phone-b");

    expect(send.mock.calls.every((call) => call[0] === "phone-a")).toBe(true);
    expect(lifecycle.mock.calls.every(
      (call) => (call[0] as MobileNodeLifecycleEvent).deviceId === "phone-a",
    )).toBe(true);
    store.close();
  });

  it("refuses a preference naming a device paired to nobody, and clears on null", () => {
    const store = storageWithDevices("phone-a");
    expect(store.setBotMobilePreferredDevice("sage", "thread-1", "stranger", 2_000)).toBe("unknown_device");
    expect(store.botMobilePreferredDevice("sage", "thread-1")).toEqual({ sessionId: "thread-1" });

    store.setBotMobilePreferredDevice("sage", "thread-1", "phone-a", 2_000);
    store.setBotMobilePreferredDevice("sage", "thread-1", null, 2_100);
    expect(store.botMobilePreferredDevice("sage", "thread-1")).toEqual({ sessionId: "thread-1" });
    store.close();
  });

  it("scopes the preference to one profile and one conversation and drops it with the bot", () => {
    const store = storageWithDevices("phone-a");
    store.setBotMobilePreferredDevice("sage", "thread-1", "phone-a", 2_000);
    expect(store.botMobilePreferredDevice("sage", "other-thread")).toEqual({ sessionId: "other-thread" });
    expect(store.botMobilePreferredDevice("other", "thread-1")).toEqual({ sessionId: "thread-1" });

    const purged = store.purgeBot("sage");
    expect(purged["mobilePreferredDevices"]).toBe(1);
    expect(store.botMobilePreferredDevice("sage", "thread-1")).toEqual({ sessionId: "thread-1" });
    store.close();
  });

  it("reads and writes the preference over its route, and names the field it refuses", async () => {
    const mobilePreferredDevice = vi.fn(() => ({ sessionId: "thread-1", deviceId: "phone-b", updatedAt: 2_000 }));
    const setMobilePreferredDevice = vi.fn(() => "ok" as const);
    const app = mount({ mobilePreferredDevice, setMobilePreferredDevice });

    const read = await app.request("/bots/sage/mobile-requests/preferred-device?sessionId=thread-1");
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ sessionId: "thread-1", deviceId: "phone-b", updatedAt: 2_000 });

    const written = await app.request("/bots/sage/mobile-requests/preferred-device?sessionId=thread-1", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: "phone-b" }),
    });
    expect(written.status).toBe(200);
    expect(setMobilePreferredDevice).toHaveBeenCalledWith("sage", "thread-1", "phone-b");

    // A conversation is required: a preference naming none could only bind the wrong one.
    expect((await app.request("/bots/sage/mobile-requests/preferred-device")).status).toBe(400);

    const unknown = mount({
      mobilePreferredDevice, setMobilePreferredDevice: vi.fn(() => "unknown_device" as const),
    });
    const refused = await unknown.request("/bots/sage/mobile-requests/preferred-device?sessionId=thread-1", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: "stranger" }),
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: { code: "invalid_request" } });
  });
});

describe("capability-71 composer draft sync", () => {
  it("syncs a draft across devices without a duplicate send", () => {
    const store = storageWithDevices("phone-a", "phone-b");
    // Device A types. The record is per person and conversation, never per device.
    const typed = store.setBotComposerDraft("sage", "thread-1", "half a thought", 2_000);
    expect(typed.changed).toBe(true);
    expect(typed.draft).toEqual({ sessionId: "thread-1", text: "half a thought", updatedAt: 2_000 });
    expect(check(BotComposerDraftSchema, typed.draft)).toBe(true);

    // Device B reconnects and reads exactly what device A typed.
    expect(store.botComposerDraft("sage", "thread-1")).toEqual({
      sessionId: "thread-1", text: "half a thought", updatedAt: 2_000,
    });

    // Device A sends. The clear is written at once, not on the typing debounce.
    const cleared = store.setBotComposerDraft("sage", "thread-1", "", 2_100);
    expect(cleared.changed).toBe(true);
    expect(cleared.draft).toEqual({ sessionId: "thread-1", text: "", updatedAt: 2_100 });

    // Device B's copy is gone, so it can never offer to resend what was already sent.
    expect(store.botComposerDraft("sage", "thread-1")).toEqual({
      sessionId: "thread-1", text: "", updatedAt: 2_100,
    });
    store.close();
  });

  it("answers an empty draft for a conversation that has none, last write wins, and a replay is quiet", () => {
    const store = storageWithDevices("phone-a");
    expect(store.botComposerDraft("sage", "thread-1")).toEqual({
      sessionId: "thread-1", text: "", updatedAt: 0,
    });

    store.setBotComposerDraft("sage", "thread-1", "first", 2_000);
    expect(store.setBotComposerDraft("sage", "thread-1", "second", 2_100).draft.text).toBe("second");
    // A device replaying the text it already had wakes nobody.
    expect(store.setBotComposerDraft("sage", "thread-1", "second", 2_200).changed).toBe(false);
    store.close();
  });

  it("scopes a draft to one profile and one conversation and drops it with the bot", () => {
    const store = storageWithDevices("phone-a");
    store.setBotComposerDraft("sage", "thread-1", "mine", 2_000);
    expect(store.botComposerDraft("sage", "other-thread").text).toBe("");
    expect(store.botComposerDraft("other", "thread-1").text).toBe("");

    const purged = store.purgeBot("sage");
    expect(purged["composerDrafts"]).toBe(1);
    expect(store.botComposerDraft("sage", "thread-1").text).toBe("");
    store.close();
  });

  it("sweeps an untouched draft after thirty days and never a fresh one", () => {
    const store = storageWithDevices("phone-a");
    const day = 24 * 60 * 60 * 1_000;
    store.setBotComposerDraft("sage", "old", "abandoned", 1_000);
    store.setBotComposerDraft("sage", "new", "current", 1_000 + 31 * day);

    expect(store.botComposerDraft("sage", "old").text).toBe("");
    expect(store.botComposerDraft("sage", "new").text).toBe("current");
    store.close();
  });

  it("carries the draft on a full-replace frame that names no device", () => {
    const frame = {
      type: "bot_draft_updated", bot: "sage", sessionId: "thread-1",
      text: "half a thought", updatedAt: 2_000,
    };
    expect(check(BotDraftUpdatedFrameSchema, frame)).toBe(true);
    // A draft belongs to the person, so no device id is accepted on the frame.
    expect(check(BotDraftUpdatedFrameSchema, { ...frame, deviceId: "phone-a" })).toBe(false);
  });

  it("reads and writes the draft over its route and refuses an overlong one by name", async () => {
    const composerDraft = vi.fn(() => ({ sessionId: "thread-1", text: "half a thought", updatedAt: 2_000 }));
    const setComposerDraft = vi.fn(() => ({ sessionId: "thread-1", text: "sent", updatedAt: 2_100 }));
    const app = mount({ composerDraft, setComposerDraft });

    const read = await app.request("/bots/sage/drafts?sessionId=thread-1");
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ sessionId: "thread-1", text: "half a thought", updatedAt: 2_000 });
    expect(composerDraft).toHaveBeenCalledWith("sage", "thread-1");

    const written = await app.request("/bots/sage/drafts", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "thread-1", text: "sent" }),
    });
    expect(written.status).toBe(200);
    expect(setComposerDraft).toHaveBeenCalledWith("sage", "thread-1", "sent");

    expect((await app.request("/bots/sage/drafts")).status).toBe(400);

    // Refused rather than truncated: a draft whose end the person cannot see is worse.
    const overlong = await app.request("/bots/sage/drafts", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "thread-1", text: "x".repeat(8_001) }),
    });
    expect(overlong.status).toBe(400);
    expect(await overlong.json()).toMatchObject({ error: { code: "invalid_request" } });
  });
});
