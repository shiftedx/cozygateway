import { readFileSync } from "node:fs";

import { type Static, Type } from "@sinclair/typebox";
import { ContractViolation, assertValid } from "cozygateway-contract";

/** Hermes is the only supported runtime. Each profile is configured once and the same attach-v1
 * identity powers both the frozen core thread surface and Bot Mode. */
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
  /** Profile names this gateway keeps off its roster. They remain REAL profiles Hermes-side, and
   *  every by-name `/bots/:name` route still addresses them; they are only left out of `GET /bots`
   *  and the `bot_roster` frames. This is for a box whose Hermes also runs automation or service
   *  profiles that are not bots anybody should chat with. Matched case-insensitively, since Hermes
   *  stores profile ids lowercase. */
  hiddenProfiles: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  /** The Hermes profile this bridge's own link runs on. It scopes Dashboard configuration reads
   *  used by the routine and profile-control surfaces. Optional because Hermes does not expose the
   *  profile a gateway process was launched under. */
  profile: Type.Optional(Type.String({ minLength: 1 })),
  /** Whether `POST /bots` seeds a newly created profile as a BLANK SLATE: the `file` + `terminal`
   *  toolset floor on the `cozygateway` and `cli` platforms, and `approvals.mode: manual` so the
   *  bot has to ask before it earns anything else. Default true. Set false to leave created
   *  profiles on Hermes' broad per-platform defaults. Only ever seeds keys the profile does not
   *  already have, so it cannot walk back a bot the user has since armed. */
  seedBlankSlateBots: Type.Optional(Type.Boolean()),
  /** Skill names a blank-slate bot keeps ON. Default `[]`: skills are gated by a per-profile
   *  `skills.disabled` OFF-list with no enabled allowlist behind it, so a fresh profile with no
   *  such list has every installed skill on. The seed writes the profile's own skill catalog minus
   *  this floor. Autonomy comes from the `file` + `terminal` toolsets, not from playbooks, and a
   *  skill is one approval (or one tap in the app's skills picker) away. Only read when
   *  `seedBlankSlateBots` is true, and only written onto a profile that carries no OFF-list yet. */
  blankSlateSkillsOn: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  /** The opener an EMPTY bot chat offers a client (capability 11, issue #59). Defaults to the line
   *  this gateway used to submit by itself, "Hey, tell me about yourself!".
   *
   *  It is a SUGGESTION and nothing else: the gateway never submits it, and it enters the
   *  conversation only if the user chooses to send it as their own message. Set it to the empty
   *  string to offer nothing at all, which leaves a fresh chat completely bare. */
  chatSuggestion: Type.Optional(Type.String()),
  /** Profile id -> one attach identity. Token values live only in the named environment variables. */
  profiles: Type.Record(
    Type.String({ minLength: 1 }),
    Type.Object({
      tokenEnv: Type.String({ minLength: 1 }),
      name: Type.Optional(Type.String({ minLength: 1 })),
      avatar: Type.Optional(Type.String({ minLength: 1 })),
    }),
    { minProperties: 1 },
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
  /** Optional operator-enforced wall-clock bound in seconds. The default is disabled because
   *  active agent turns can legitimately run longer than ten minutes while using tools or
   *  compacting context. A positive value interrupts through the same path as a manual stop.
   *  Config-file only; not env-driven (see applyEnvOverrides). */
  turnTimeoutSeconds: Type.Integer({ minimum: 0, default: 0 }),
  /** Stale-turn reaper. A native Bot Mode turn is durable, so a turn nothing ever terminalizes
   *  shows as "thinking" on every device until an operator repairs the row by hand. These bound
   *  that: the sweep interval, the silence allowed after an ACKED interrupt, and the hard ceiling
   *  of total silence (no drafts, no tool steps, no interim commits -- a working turn is never
   *  silent). 0 disables the sweep or either reading; omitted leaves the data plane's own
   *  defaults in force. Config-file only. */
  staleTurnSweepSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
  staleTurnInterruptGraceSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
  staleTurnCeilingSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
  /** Capability id -> integer version, surfaced verbatim as GatewayInfo.capabilities (contract
   *  v1.md section 5). Optional; a gateway with nothing to advertise omits it and gets an empty
   *  map (see server.ts). Ids under com.cozylabs.* are vendor extensions. */
  capabilities: Type.Optional(Type.Record(Type.String(), Type.Integer({ minimum: 1 }))),
  /** Private push relay origin used by the authenticated `/push` proxy. The gateway and relay may
   *  share a Docker network without exposing the relay listener on the public host. */
  pushRelayUrl: Type.Optional(Type.String({ minLength: 1 })),
  hermes: HermesBridgeConfigSchema,
  tls: Type.Optional(TlsConfigSchema),
});
export type GatewayConfig = Static<typeof GatewayConfigSchema>;

export function loadConfig(path: string): GatewayConfig {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const withDefaults =
    typeof raw === "object" && raw !== null
      ? { port: 8787, dbPath: "cozygateway.db", turnTimeoutSeconds: 0, ...raw }
      : raw;
  const config = assertValid(GatewayConfigSchema, withDefaults);
  const seen = new Set<string>();
  for (const rawProfile of Object.keys(config.hermes.profiles)) {
    const profile = rawProfile.trim().toLowerCase();
    if (profile.length === 0) {
      throw new ContractViolation("Hermes profile ids must not be blank", "/hermes/profiles");
    }
    if (seen.has(profile)) {
      throw new ContractViolation(`duplicate Hermes profile id "${profile}"`, "/hermes/profiles");
    }
    seen.add(profile);
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
