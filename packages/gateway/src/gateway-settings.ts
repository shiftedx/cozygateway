import {
  GatewaySettingsSchema,
  ContractViolation,
  assertValid,
  type GatewaySettings,
  type HermesEndpointSetting,
} from "cozygateway-contract";

import {
  loadConfig,
  probeConfigPersistence,
  saveConfig,
  type GatewayConfig,
  type HermesBridgeConfig,
} from "./config.ts";

const PERSISTENCE_ERROR_CODES = new Set([
  "EACCES", "EBUSY", "EDQUOT", "EISDIR", "EMFILE", "ENFILE", "ENOENT", "ENOSPC", "ENOTDIR", "EPERM", "EROFS",
]);

export class GatewaySettingsPersistenceError extends Error {
  readonly configPath: string;
  readonly code: string;

  constructor(
    configPath: string,
    code: string,
    options: { cause: unknown },
  ) {
    super("gateway settings source configuration is not writable", options);
    this.name = "GatewaySettingsPersistenceError";
    this.configPath = configPath;
    this.code = code;
  }
}

function persistenceError(configPath: string, error: unknown): GatewaySettingsPersistenceError | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = String(error.code);
  return PERSISTENCE_ERROR_CODES.has(code)
    ? new GatewaySettingsPersistenceError(configPath, code, { cause: error })
    : undefined;
}

function withPersistenceError<T>(configPath: string, action: () => T): T {
  try {
    return action();
  } catch (error) {
    throw persistenceError(configPath, error) ?? error;
  }
}

function endpointSetting(id: string, label: string | undefined, config: HermesBridgeConfig): HermesEndpointSetting {
  return { id, ...(label === undefined ? {} : { label }), ...config };
}

export function settingsForConfig(config: GatewayConfig): GatewaySettings {
  const endpoints = config.hermesEndpoints.map(({ id, label, ...endpoint }) =>
    endpointSetting(id, label, endpoint));
  return { name: config.name, hermesEndpoints: endpoints };
}

/** File-backed management. Reads afresh on every call so concurrent operator edits are retained;
 * writes replace only the two device-editable fields and preserve deployment/TLS settings. */
export interface GatewaySettingsStore {
  read(): GatewaySettings;
  update(input: unknown): GatewaySettings & { restartRequired: true };
}

export function fileGatewaySettings(configPath: string): GatewaySettingsStore {
  withPersistenceError(configPath, () => probeConfigPersistence(configPath));
  return {
    read: () => withPersistenceError(configPath, () => settingsForConfig(loadConfig(configPath))),
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
      return withPersistenceError(configPath, () => {
        const current = loadConfig(configPath);
        const next = {
          ...current,
          name: settings.name,
          hermesEndpoints: settings.hermesEndpoints,
        } as GatewayConfig;
        saveConfig(configPath, next);
        // Prove the exact bytes now on disk are accepted before acknowledging the mutation.
        const persisted = settingsForConfig(loadConfig(configPath));
        return { ...persisted, restartRequired: true };
      });
    },
  };
}
