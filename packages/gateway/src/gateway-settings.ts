import {
  GatewaySettingsSchema,
  ContractViolation,
  assertValid,
  type GatewaySettings,
  type HermesEndpointSetting,
} from "cozygateway-contract";

import { loadConfig, saveConfig, type GatewayConfig, type HermesBridgeConfig } from "./config.ts";

function endpointSetting(id: string, label: string | undefined, config: HermesBridgeConfig): HermesEndpointSetting {
  return { id, ...(label === undefined ? {} : { label }), ...config };
}

export function settingsForConfig(config: GatewayConfig): GatewaySettings {
  const endpoints = config.hermesEndpoints?.map(({ id, label, ...endpoint }) =>
    endpointSetting(id, label, endpoint)) ??
    (config.hermes === undefined ? [] : [endpointSetting("default", "Hermes", config.hermes)]);
  return { name: config.name, hermesEndpoints: endpoints };
}

/** File-backed management. Reads afresh on every call so concurrent operator edits are retained;
 * writes replace only the two device-editable fields and preserve deployment/TLS settings. */
export function fileGatewaySettings(configPath: string): {
  read(): GatewaySettings;
  update(input: unknown): GatewaySettings & { restartRequired: true };
} {
  return {
    read: () => settingsForConfig(loadConfig(configPath)),
    update: (input) => {
      const settings = assertValid(GatewaySettingsSchema, input);
      const endpointIds = new Set<string>();
      for (const [index, endpoint] of settings.hermesEndpoints.entries()) {
        if (endpointIds.has(endpoint.id))
          throw new ContractViolation(`duplicate Hermes endpoint id "${endpoint.id}"`, `/hermesEndpoints/${index}/id`);
        endpointIds.add(endpoint.id);
        let url: URL;
        try { url = new URL(endpoint.url); } catch {
          throw new ContractViolation("Hermes endpoint URL must be a ws:// or wss:// URL", `/hermesEndpoints/${index}/url`);
        }
        if (url.protocol !== "ws:" && url.protocol !== "wss:")
          throw new ContractViolation("Hermes endpoint URL must be a ws:// or wss:// URL", `/hermesEndpoints/${index}/url`);
        const mode = endpoint.authMode ?? "token";
        if (mode === "token" && endpoint.tokenEnv === undefined)
          throw new ContractViolation("token auth requires tokenEnv", `/hermesEndpoints/${index}/tokenEnv`);
        if (mode === "password" && (endpoint.username === undefined || endpoint.passwordEnv === undefined))
          throw new ContractViolation("password auth requires username and passwordEnv", `/hermesEndpoints/${index}`);
        const profiles = new Set<string>();
        for (const rawProfile of Object.keys(endpoint.profiles)) {
          const profile = rawProfile.trim().toLowerCase();
          if (profiles.has(profile))
            throw new ContractViolation(`duplicate Hermes profile id "${profile}"`, `/hermesEndpoints/${index}/profiles`);
          profiles.add(profile);
        }
      }
      const current = loadConfig(configPath);
      const next = {
        ...current,
        name: settings.name,
        hermes: undefined,
        hermesEndpoints: settings.hermesEndpoints,
      } as unknown as GatewayConfig;
      saveConfig(configPath, next);
      // Prove the exact bytes now on disk are accepted before acknowledging the mutation.
      const persisted = settingsForConfig(loadConfig(configPath));
      return { ...persisted, restartRequired: true };
    },
  };
}
