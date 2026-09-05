import { expect, it, vi } from "vitest";
import type { BotModelConfig, BotModelConfigPatch } from "cozygateway-contract";
import { NativeBotDataPlane } from "../src/hermes-bridge/native-data-plane.ts";
import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";
import type { ConfigSurface } from "../src/hermes-bridge/bot-config.ts";
import { openStorage } from "../src/storage.ts";

it("combines Hermes builtin and saved endpoint models and writes defaults to their owner", async () => {
  const storage = openStorage(":memory:");
  const builtin: BotModelConfig = { model: "openai:example", effort: "medium", catalog: [{ id: "openai:example", displayName: "Example" }], efforts: ["medium"] };
  let selected: string | null = null;
  const customModel = "custom-11111111-1111-4111-8111-111111111111:local";
  const configureModel = vi.fn(async (_bot: string, patch: BotModelConfigPatch) => { if (patch.model !== undefined) builtin.model = patch.model; if (patch.effort !== undefined) builtin.effort = patch.effort; return builtin; });
  const customRead = async (): Promise<BotModelConfig> => ({ model: selected, effort: null, catalog: [{ id: customModel, displayName: "Local" }], efforts: [] });
  const customWrite = vi.fn(async (_bot: string, patch: BotModelConfigPatch) => { if (patch.model !== undefined) selected = patch.model; return customRead(); });
  const plane = new NativeBotDataPlane({
    storage, nativeBots: ["sage"], chatSuggestion: "", broadcast: () => undefined,
    control: { modelConfig: async () => builtin, configureModel } as unknown as BotsSurface,
    botConfig: { modelConfig: customRead, configureModel: customWrite } as unknown as ConfigSurface,
    ingress: { negotiatedCapabilities: () => new Set(["provider_connections"]) } as never,
  });
  try {
    expect((await plane.surface().modelConfig("sage")).catalog).toHaveLength(2);
    expect((await plane.surface().configureModel("sage", { model: customModel, effort: "high" })).model).toBe(customModel);
    expect(configureModel).toHaveBeenCalledWith("sage", { effort: "high" });
    expect(customWrite).toHaveBeenCalledWith("sage", { model: customModel });
    expect((await plane.surface().configureModel("sage", { model: "openai:example" })).model).toBe("openai:example");
    expect(selected).toBeNull();
  } finally { plane.close(); storage.close(); }
});
