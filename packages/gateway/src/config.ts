import { readFileSync } from "node:fs";

import { type Static, Type } from "@sinclair/typebox";
import { ContractViolation, assertValid } from "cozygateway-contract";

const AgentConfigSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  avatar: Type.Optional(Type.String()),
  backend: Type.String({ minLength: 1 }),
  options: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type AgentConfig = Static<typeof AgentConfigSchema>;

/** Optional Hermes bridge (vendor extension com.cozylabs.bots). Configured like the openclaw
 *  backend: the config file carries the gateway URL and the NAME of the environment variable
 *  holding the credential, never the credential itself. Present means the `/bots` routes exist
 *  and the capability is advertised; absent means neither. */
const HermesBridgeConfigSchema = Type.Object({
  /** The Hermes gateway WebSocket URL, e.g. ws://homelab:8790/api/ws */
  url: Type.String({ minLength: 1 }),
  /** How the WS upgrade is authenticated. "token" (default) is the loopback shape: the credential
   *  rides the upgrade URL. "password" is the gated shape: the bridge logs in to the dashboard
   *  over HTTP and mints a fresh single-use ws ticket for every connect. */
  authMode: Type.Optional(Type.Union([Type.Literal("token"), Type.Literal("password")])),
  /** Token mode: NAME of the env var holding the session token (loopback) or a pre-minted ticket.
   *  Required when authMode is "token"; unused in password mode. */
  tokenEnv: Type.Optional(Type.String({ minLength: 1 })),
  /** Token mode: which upgrade-URL query parameter the credential rides. Default "token". */
  authParam: Type.Optional(Type.Union([Type.Literal("token"), Type.Literal("ticket")])),
  /** Password mode: the dashboard username. Not a secret, so it lives in the config file. */
  username: Type.Optional(Type.String({ minLength: 1 })),
  /** Password mode: NAME of the env var holding the dashboard password. The value itself NEVER
   *  appears in the config file. */
  passwordEnv: Type.Optional(Type.String({ minLength: 1 })),
  /** Password mode: which registered dashboard auth provider the login names. "basic" is the
   *  bundled implementation and the default, not the protocol: a dashboard that registers another
   *  password provider (an LDAP bind, say) names it here. A provider the dashboard does not know
   *  answers 404, and the bridge says so by name. */
  provider: Type.Optional(Type.String({ minLength: 1 })),
  /** Password mode: HTTP origin of the dashboard, e.g. http://homelab:9119. Defaults to the WS
   *  URL's origin with ws -> http and wss -> https. */
  baseUrl: Type.Optional(Type.String({ minLength: 1 })),
  /** Canonical Bot Chats are created hidden so they stay out of the global Sessions list, which
   *  is what the desktop plugin defaults to. */
  hideBotChats: Type.Optional(Type.Boolean()),
  /** Profile names this gateway keeps off its roster. They remain REAL profiles Hermes-side, and
   *  every by-name `/bots/:name` route still addresses them; they are only left out of `GET /bots`
   *  and the `bot_roster` frames. This is for a box whose Hermes also runs automation or service
   *  profiles that are not bots anybody should chat with. Matched case-insensitively, since Hermes
   *  stores profile ids lowercase. */
  hiddenProfiles: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  /** The Hermes profile this bridge's own link runs on. Setting it makes `DELETE /bots/:name`
   *  refuse that name: deleting a profile stops its gateway, so an authenticated device could
   *  otherwise cut the link this gateway talks over. Optional because it cannot be detected (the
   *  RPC surface reports the profile a SESSION is routed to, never the one the gateway process was
   *  launched under) and a wrong guess would make a real bot undeletable. */
  profile: Type.Optional(Type.String({ minLength: 1 })),
  /** How long a pending tool-call approval waits before this gateway calls it `expired`
   *  (capability 10, issue #19). MIRRORS the hermes `approvals.timeout`, whose default is 300 s.
   *
   *  It has to be mirrored rather than read: hermes emits no expiry event of any kind (it drops
   *  the queue entry silently) and does not expose the timeout on its JSON-RPC surface, so the
   *  gateway runs its own timer. An operator who changes `approvals.timeout` hermes-side sets this
   *  to match; leaving them out of step only shifts when the gateway stops offering the buttons,
   *  and never resolves anything on its own. */
  approvalTimeoutSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
  /** The opener an EMPTY bot chat offers a client (capability 11, issue #59). Defaults to the line
   *  this gateway used to submit by itself, "Hey, tell me about yourself!".
   *
   *  It is a SUGGESTION and nothing else: the gateway never submits it, and it enters the
   *  conversation only if the user chooses to send it as their own message. Set it to the empty
   *  string to offer nothing at all, which leaves a fresh chat completely bare. */
  chatSuggestion: Type.Optional(Type.String()),
  /** Per-profile attach-v1 rollout. Management remains on the dashboard bridge; chat traffic for
   *  a profile in `native` mode uses only the durable attach-v1 data plane. `shadow` authenticates
   *  and journals the native stream without taking ownership of app-visible chat submission. */
  nativeDataPlane: Type.Optional(
    Type.Record(
      Type.String({ minLength: 1 }),
      Type.Object({
        tokenEnv: Type.String({ minLength: 1 }),
        mode: Type.Optional(Type.Union([Type.Literal("native"), Type.Literal("shadow")])),
        /** Independently reversible attach-v1 feature gates. Omitted fields default true so an
         * existing native/shadow config retains the complete v1 surface. */
        features: Type.Optional(
          Type.Object({
            media: Type.Optional(Type.Boolean()),
            tools: Type.Optional(Type.Boolean()),
            interactions: Type.Optional(Type.Boolean()),
            clarify: Type.Optional(Type.Boolean()),
            scheduled: Type.Optional(Type.Boolean()),
          }),
        ),
      }),
    ),
  ),
});
export type HermesBridgeConfig = Static<typeof HermesBridgeConfigSchema>;

/** Optional gateway-native TLS. Both halves are required together: a cert without a key (or the
 *  reverse) is a half-configured deployment, not a default, and is refused rather than quietly
 *  falling back to plaintext. Paths only -- key material never enters the config file. Omitting the
 *  whole block leaves the gateway on plain HTTP exactly as before, which stays the right default
 *  for a box that already terminates TLS in a reverse proxy in front of it. */
const TlsConfigSchema = Type.Object({
  /** Path to the PEM certificate chain, leaf first. */
  certFile: Type.String({ minLength: 1 }),
  /** Path to the matching unencrypted PEM private key. */
  keyFile: Type.String({ minLength: 1 }),
});
export type TlsConfig = Static<typeof TlsConfigSchema>;

const GatewayConfigSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  port: Type.Integer({ minimum: 1, maximum: 65535, default: 8787 }),
  host: Type.Optional(Type.String({ minLength: 1 })),
  dbPath: Type.String({ minLength: 1, default: "cozygateway.db" }),
  /** Per-turn wall-clock bound in seconds. A turn that runs longer than this is interrupted
   *  server-side via the ordinary interrupt path (the same one a manual stop uses), so a device
   *  that disconnects mid-turn cannot leave the agent looping tool calls forever. 0 disables the
   *  bound. Config-file only; not env-driven (see applyEnvOverrides). */
  turnTimeoutSeconds: Type.Integer({ minimum: 0, default: 600 }),
  /** Attach/openclaw/mock agents this gateway serves. May be empty or omitted on a pure-bots
   *  gateway, whose whole surface is the hermes bridge; see the "at least one surface" check in
   *  `loadConfig`. It was once required to be non-empty, which forced a placeholder attach agent
   *  into the config of a box that serves nothing but bots. */
  agents: Type.Array(AgentConfigSchema, { default: [] }),
  /** Capability id -> integer version, surfaced verbatim as GatewayInfo.capabilities (contract
   *  v1.md section 5). Optional; a gateway with nothing to advertise omits it and gets an empty
   *  map (see server.ts). Ids under com.cozylabs.* are vendor extensions. */
  capabilities: Type.Optional(Type.Record(Type.String(), Type.Integer({ minimum: 1 }))),
  /** Private push relay origin used by the authenticated `/push` proxy. The gateway and relay may
   *  share a Docker network without exposing the relay listener on the public host. */
  pushRelayUrl: Type.Optional(Type.String({ minLength: 1 })),
  hermes: Type.Optional(HermesBridgeConfigSchema),
  tls: Type.Optional(TlsConfigSchema),
});
export type GatewayConfig = Static<typeof GatewayConfigSchema>;

export function loadConfig(path: string): GatewayConfig {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const withDefaults =
    typeof raw === "object" && raw !== null
      ? { port: 8787, dbPath: "cozygateway.db", turnTimeoutSeconds: 600, agents: [], ...raw }
      : raw;
  const config = assertValid(GatewayConfigSchema, withDefaults);
  // A gateway has to serve SOMETHING. Agents and the hermes bridge are the two surfaces, and
  // either alone is a complete deployment: a pure-bots gateway carries no agents at all, while a
  // classic attach gateway carries no bridge. Only a config with neither is refused, and it is
  // refused here rather than by a `minItems` on `agents`, which used to make the pure-bots shape
  // impossible to express.
  if (config.agents.length === 0 && config.hermes === undefined) {
    throw new ContractViolation(
      'a gateway must serve something: configure at least one entry in "agents", or a "hermes" bridge block for a pure-bots gateway',
      "/agents",
    );
  }
  const seen = new Set<string>();
  for (const agent of config.agents) {
    if (seen.has(agent.id)) {
      throw new ContractViolation(`duplicate agent id "${agent.id}"`, "/agents");
    }
    seen.add(agent.id);
  }
  return config;
}

/** Apply container-friendly environment overrides on top of a loaded config. Returns a new object;
 *  the input is not mutated. */
const nonEmpty = (value: string | undefined): string | undefined =>
  value !== undefined && value.length > 0 ? value : undefined;

export function applyEnvOverrides(
  config: GatewayConfig,
  env: Record<string, string | undefined>,
): GatewayConfig {
  const next: GatewayConfig = { ...config };
  const host = env["COZYGATEWAY_HOST"];
  if (host !== undefined && host.length > 0) next.host = host;
  const portRaw = env["COZYGATEWAY_PORT"];
  if (portRaw !== undefined && portRaw.length > 0) {
    const port = Number(portRaw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`invalid COZYGATEWAY_PORT "${portRaw}"`);
    }
    next.port = port;
  }
  const dbPath = env["COZYGATEWAY_DB_PATH"];
  if (dbPath !== undefined && dbPath.length > 0) next.dbPath = dbPath;
  const pushRelayUrl = env["COZYGATEWAY_PUSH_RELAY_URL"];
  if (pushRelayUrl !== undefined && pushRelayUrl.length > 0) next.pushRelayUrl = pushRelayUrl;
  // Container-friendly override for the hermes bridge's TARGET only. It never carries the
  // credential: that still rides the env var named by hermes.tokenEnv. Ignored when no bridge is
  // configured, so setting it cannot switch the bots surface on by accident.
  const hermesUrl = env["COZYGATEWAY_HERMES_URL"];
  if (hermesUrl !== undefined && hermesUrl.length > 0 && next.hermes !== undefined) {
    next.hermes = { ...next.hermes, url: hermesUrl };
  }
  // Gateway-native TLS, container-friendly: the paths ride the environment so a compose file can
  // mount certs and switch the listener without a config-file edit. Only PATHS -- the key material
  // stays on the mounted volume. Empty strings are treated as unset, matching the other overrides,
  // so a compose file that always exports `COZY_TLS_CERT_FILE: "${COZY_TLS_CERT_FILE:-}"` does not
  // accidentally half-configure TLS.
  const certFile = nonEmpty(env["COZY_TLS_CERT_FILE"]);
  const keyFile = nonEmpty(env["COZY_TLS_KEY_FILE"]);
  if (certFile !== undefined || keyFile !== undefined) {
    const resolvedCert = certFile ?? next.tls?.certFile;
    const resolvedKey = keyFile ?? next.tls?.keyFile;
    // Half-configured is refused rather than dropped back to plaintext: an operator who set one
    // half meant to serve TLS, and a silent fallback would put an unencrypted listener on the port
    // they believed was encrypted.
    if (resolvedCert === undefined || resolvedKey === undefined) {
      throw new Error(
        "TLS is half-configured: set BOTH COZY_TLS_CERT_FILE and COZY_TLS_KEY_FILE (or neither, " +
          "to serve plain HTTP behind a reverse proxy)",
      );
    }
    next.tls = { certFile: resolvedCert, keyFile: resolvedKey };
  }
  return next;
}
