import { createHash, randomUUID } from "node:crypto";

import { Hono } from "hono";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import {
  type ErrorBody,
  type ErrorCode,
  type GatewayInfo,
  type AttachHealthSummary,
  type Message,
  type PresenceState,
  type RichBlock,
  ContractViolation,
  CreateThreadRequestSchema,
  PairRequestSchema,
  RunnerPatchRequestSchema,
  RunnerDeleteResponseSchema,
  type RunnerDeleteResponse,
  PushRegisterRequestSchema,
  RenameThreadRequestSchema,
  SendMessageRequestSchema,
  assertValid,
  GatewaySettingsSchema,
  HarnessUpdateStartRequestSchema,
  HERMES_SESSION_LIST_MAX,
  HERMES_SESSION_MESSAGES_MAX,
  HERMES_SESSION_OFFSET_MAX,
  HERMES_SESSION_QUERY_MAX_LENGTH,
  HERMES_SESSION_SEARCH_MAX,
  HermesSessionPatchSchema,
  CozyAppRenameRequestSchema,
  CozyAppReplaceTreeRequestSchema,
  CozyAppActionRequestSchema,
  assertValidCozyAppTree,
  ModelProviderFieldUpdateSchema,
  ModelProviderOAuthCodeSchema,
  GatewayMaintenanceRestartRequestSchema,
  GatewayMaintenanceUpdateRequestSchema,
} from "cozygateway-contract";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { GatewayConfig } from "./config.ts";
import { GatewaySettingsPersistenceError } from "./gateway-settings.ts";
import { GatewayMaintenance, GatewayMaintenanceFailure, GatewayMaintenanceNotFound } from "./gateway-maintenance.ts";
import type { Storage, ThreadRow } from "./storage.ts";
import { SETUP_CODE_TTL_MS, hashToken, mintDeviceToken, newSetupCode } from "./auth.ts";
import { listenerOrigin } from "./configure.ts";
import { primaryLanAddress } from "./lan.ts";
import { gatewayScheme } from "./tls.ts";
import {
  LEGACY_RUNNER_ID,
  effectiveRunnerName,
  legacyRunnerRow,
  runnerToWire,
  type RunnerRoster,
} from "./runner/roster.ts";
import { BackendUnavailable } from "./errors.ts";
import { HermesUnavailable } from "./hermes-bridge/client.ts";
import { GatewayHarnessSettings, HarnessSettingsInvalid } from "./harness-settings.ts";
import type { BotControlSurface, BotsSurface } from "./hermes-bridge/bridge.ts";
import { ProviderSetupInvalid } from "./hermes-bridge/provider-setup.ts";
import {
  GatewayHermesGlobalSkills,
  GlobalSkillsBusy,
  GlobalSkillsInvalid,
  GlobalSkillsNoProfiles,
  GlobalSkillsNotFound,
  GlobalSkillsPersistenceFailed,
  GlobalSkillsStale,
} from "./hermes-bridge/global-skills.ts";
import type { MemorySurface } from "./hermes-bridge/memory.ts";
import type { HistorySurface } from "./hermes-bridge/bot-history.ts";
import type { RunRoutineSurface } from "./hermes-bridge/native-data-plane.ts";
import { registerBotRoutes } from "./hermes-bridge/routes.ts";
import { resolveByteRange } from "./hermes-bridge/routes.ts";
import type {
  MediaFetch,
  MediaLimiter,
  MediaLookup,
} from "./hermes-bridge/media.ts";
import { fetchMedia, resolveMediaSource, MediaBusy, MediaRefused, MediaTimedOut, MediaUpstreamFailed, MEDIA_CACHE_CONTROL } from "./hermes-bridge/media.ts";
import {
  ATTACH_MEDIA_TTL_MS,
  PhotoRefused,
  readCappedBody,
  sniffImageType,
  type PhotoRateLimiter,
} from "./hermes-bridge/photos.ts";
import {
  ASSISTANT_MEDIA_TYPES,
  acceptAssistantMediaBytes,
} from "./hermes-bridge/assistant-media.ts";

import { attachmentDisposition, safeFilename } from "./hermes-bridge/documents.ts";
import {
  GatewayHarnessWorkspace,
  WorkspaceBusy,
  WorkspaceForbidden,
  WorkspaceInvalid,
  WorkspaceNotFound,
  WorkspaceRangeInvalid,
  WorkspaceRateLimited,
  WorkspaceTooLarge,
  WorkspaceUnavailable,
} from "./hermes-bridge/workspace.ts";
import {
  GatewayHarnessUpdates,
  HarnessUpdateBlocked,
  HarnessUpdateStale,
  HarnessUpdateUnavailable,
} from "./hermes-bridge/update.ts";
import {
  GatewayHermesSessionManagement,
  HermesSessionInvalid,
  HermesSessionMutationAmbiguous,
  HermesSessionNotFound,
  HermesSessionTooLarge,
  HermesSessionUnavailable,
} from "./hermes-bridge/session-management.ts";
import type { AttachV1MediaDescriptor } from "./adapters/attach/protocol-v1.ts";
import { resolveAttachBearer } from "./adapters/attach/token-auth.ts";
import type { MobileNodeMediaDescriptor } from "./mobile-node.ts";
import { PAIR_REQUEST_MAX_BYTES, PairingAdmission, readPairBody, type PairingAttemptLimiter } from "./pairing-admission.ts";

const LIVE_ACTIVITY_DELETION_DRAIN_LIMIT = 50;
// The relay is private-network adjacent and its ordinary request deadline is ten seconds. A
// shorter deadline risks duplicate retries during transient APNs work; no deadline wedges the
// durable single-flight drain forever when a transport never settles.
const LIVE_ACTIVITY_RELAY_DELETE_TIMEOUT_MS = 10_000;

/** The relay's register body, mirrored here rather than imported: the gateway's docker image
 *  bundles only its own package, so a runtime import of cozygateway-relay crashes the container
 *  (proven in production, 2026-08-20). Kept structurally identical to
 *  packages/relay/src/schemas.ts RegisterRequestSchema; the relay still authoritatively validates
 *  every forwarded body, so drift here can only over- or under-eagerly 400, never corrupt. */
const RelayRegisterRequestSchema = Type.Object({
  platform: Type.Union([
    Type.Literal("webhook"),
    Type.Literal("apns"),
    Type.Literal("apns-liveactivity"),
  ]),
  token: Type.String({ minLength: 1, maxLength: 2048 }),
  environment: Type.Optional(
    Type.Union([Type.Literal("development"), Type.Literal("production")]),
  ),
});

const LiveActivityRegisterRequestSchema = Type.Object(
  {
    activityId: Type.String({ minLength: 1, maxLength: 128 }),
    runId: Type.String({ minLength: 1, maxLength: 128 }),
    conversationId: Type.String({ minLength: 1, maxLength: 160 }),
    bot: Type.String({ minLength: 1, maxLength: 120 }),
    token: Type.String({
      minLength: 32,
      maxLength: 512,
      pattern: "^[0-9a-f]+$",
    }),
    environment: Type.Union([
      Type.Literal("development"),
      Type.Literal("production"),
    ]),
  },
  { additionalProperties: false },
);

/** Where a phone or an installer should dial this gateway, from configuration alone. A public
 *  origin wins; otherwise a wildcard listener advertises the LAN address rather than loopback,
 *  because the machine that will use a runner code is usually not this one. Mirrors the rule
 *  `cozygateway pair` prints, so one code means one URL wherever it was minted. */
function configuredOrigin(config: GatewayConfig): string {
  if (config.publicUrl !== undefined) return config.publicUrl;
  const host = config.host;
  const advertised =
    host !== undefined && host !== "0.0.0.0" && host !== "::"
      ? host
      : primaryLanAddress() ?? "127.0.0.1";
  return listenerOrigin(advertised, config.port, gatewayScheme(config));
}

export interface AppDeps {
  storage: Storage;
  /** Test-only override for the gateway-wide `/pair` bucket. Production leaves this absent and
   *  builds its limiter from `now`; a long-lived black-box harness supplies one with virtual time. */
  pairingAdmission?: PairingAttemptLimiter;
  /** The bots bridge, present only when a hermes bridge is configured. When absent the `/bots`
   *  routes are not registered at all and the capability is not advertised, so an app probing
   *  `GatewayInfo.capabilities` sees the truth. */
  bots?: BotControlSurface | BotsSurface;
  /** Profile-local memory travels only over the attached plugin's bounded management lane. */
  memory?: MemorySurface;
  /** Capability 50. A runtime bot's own checkpointed workspace history, over the attached peer's
   * bounded `bot_history` lane. Absent leaves the five history routes unregistered. */
  history?: HistorySurface;
  /** Capability 53. Forces a runtime bot's routine to run now, over the existing capability-48
   * `bot_config` lane. Absent leaves `POST /bots/:name/routines/:id/run` unregistered. */
  runRoutine?: RunRoutineSurface;
  /** attach-v1 bearer token → authenticated agent. Enables only the media side channel; device
   * routes never accept this credential. */
  attachTokens?: ReadonlyMap<string, string>;
  /** Per-agent media rollout gate, evaluated after constant-time attach authentication. */
  attachMediaAllowed?: (agentId: string) => boolean;
  /** A device-authenticated lease claim for one phone-selected binary payload. */
  beginMobileMediaUpload?: (deviceId: string, requestId: string, lease: string) =>
    | { agentId: string; complete: (media: MobileNodeMediaDescriptor | undefined, reason?: "media_validation_failed" | "media_storage_failed") => boolean }
    | undefined;
  /** Test seam for `GET /bots/:name/media`. Left undefined in production, where the proxy uses the
   *  global `fetch`; a test supplies its own so the media rules can be exercised without a socket. */
  mediaFetch?: MediaFetch;
  /** Test seams alongside `mediaFetch`, for the same reason: the resolved-address rule and the
   *  concurrency cap are as much a part of what the proxy will dial as the literal rules are, and a
   *  rule that can only be exercised against real DNS is a rule that does not get tested. Left
   *  undefined in production, where the proxy uses `dns.lookup` and the one process-wide limiter. */
  mediaLookup?: MediaLookup;
  mediaLimiter?: MediaLimiter;
  mediaQueueWaitMs?: number;
  /** Test seams for `POST /bots/:name/chat/photos` (capability 9), for the same reason the media
   *  ones exist: the in-flight bound and the per-device rate limit are as much a part of what the
   *  route will do as the sniffing rules are, and neither can be exercised at production values
   *  inside a test. Left undefined in production, where the route builds its own. */
  photoLimiter?: MediaLimiter;
  photoQueueWaitMs?: number;
  photoRateLimiter?: PhotoRateLimiter;
  /** Test seam for the private relay boundary. Production uses the global fetch. */
  pushRelayFetch?: typeof fetch;
  /** Sink for durable Live Activity relay cleanup failures. */
  pushRelayLog?: (message: string) => void;
  /** Test-only override for the per-DELETE outbox deadline. */
  pushRelayDeleteTimeoutMs?: number;
  config: GatewayConfig;
  gatewayInfo: GatewayInfo;
  gatewaySettings?: {
    read(): unknown;
    update(input: unknown): unknown;
  };
  gatewaySettingsLog?: (message: string) => void;
  /** Paired maintenance is registered only after a host-owned supervisor has passed discovery. */
  maintenance?: GatewayMaintenance;
  /** Gateway-owned inventory of agent harnesses and their harness-native model settings. */
  harnessSettings?: GatewayHarnessSettings;
  /** Present only after Hermes proved a non-null immutable managed-files root. */
  harnessWorkspace?: GatewayHarnessWorkspace;
  /** Harness-level Hermes update normalization. Never exposes action logs or full receipts. */
  harnessUpdates?: GatewayHarnessUpdates;
  /** Privacy-projected Hermes-owned session administration, scoped by visible harness/profile. */
  hermesSessions?: GatewayHermesSessionManagement;
  /** Paired-device projection of `skills.disabled` across every configured Hermes profile. */
  hermesGlobalSkills?: GatewayHermesGlobalSkills;
  /** Privacy-safe audit sink for global skill changes. */
  hermesGlobalSkillsLog?: (line: string) => void;
  /** Synchronous, aggregate attach-v1 state for operator health routes only. */
  attachHealth?: () => AttachHealthSummary;
  /** Separate attach-v1 app-action lane; it never injects hidden chat content. */
  sendCozyAppAction?: (action: { id: string; appId: string; creatorBot: string; actionId: string }, deviceId: string) => boolean;
  cozyAppsChanged?: () => void;
  /** Operator surface for attach-v1 projection dead letters (issue #193). A dead letter blocks
   *  every later event for its agent, so it must be listable and releasable without DB surgery. */
  attachDeadLetters?: () => Array<{
    agentId: string; sequence: number; eventId: string; kind: string;
    attempts: number; error: string | null; deadLetteredAt: number; receivedAt: number;
  }>;
  /** Releases the FIRST dead letter for an agent and immediately retries projection. */
  releaseAttachDeadLetter?: (agentId: string, eventId: string) => boolean;
  presenceOf: (agentId: string) => PresenceState;
  submitUserMessage: (threadId: string, blocks: RichBlock[]) => Message;
  interruptThread: (threadId: string) => "interrupting" | "idle";
  /** Resolve one pending approval (contract v1.md section 5a). The gateway derives everything
   *  that matters -- the turn, the backend session, whether the approval is still pending --
   *  from its own record of the correlation id inside this thread; the request supplies no
   *  profile, agent, or turn reference of its own. `deviceId` is the authenticated principal,
   *  carried through only so the audit line can name who decided. */
  resolveApproval: (input: {
    threadId: string;
    toolCallId: string;
    decision: "approve" | "deny";
    deviceId: string;
  }) => Promise<
    | "approved"
    | "denied"
    | "unknown"
    | "not_pending"
    | "expired"
    | "unsupported"
  >;
  onDeviceRevoked: (deviceId: string) => void;
  /** Capability 52. The paired runners. Absent leaves `POST /pair {kind: "runner"}` refusing and
   *  the three `/runners` routes unregistered, which is the honest answer for a host that assembled
   *  no roster rather than a route that answers about nothing. */
  runners?: RunnerRoster;
  /** Live socket state for the roster projection, from the runner lane. */
  runnerPresence?: {
    online: (runnerId: string) => boolean;
    lastContactAt: (runnerId: string) => number | null;
    /** Version from this runner's current authenticated hello only; a stored last-reported value
     *  cannot prove that an offline runner is running an installed update. */
    agentVersion: (runnerId: string) => string | undefined;
  };
  /** Whether the legacy shared `COZYGATEWAY_RUNNER_TOKEN` is configured, which the roster shows as
   *  one row so the list and the lane never disagree about who exists. */
  legacyRunnerConfigured?: boolean;
  /** Closes a revoked runner's socket. The row is gone, so the socket it authenticated must not
   *  outlive it. */
  onRunnerRevoked?: (runnerId: string) => void;
  /** The origin a freshly minted pairing code should be dialed at, which is the LISTENING port
   *  rather than the configured one when the host bound port 0. Absent falls back to the config,
   *  which is what a host that assembled its own app without a listener can honestly say. */
  pairingUrl?: () => string;
  /** Capability 52. True when this gateway has no Hermes endpoint at all, which makes the bridge
   *  `absent` on `/health` and `/ready` rather than an offline bridge to alarm on. */
  hermesBridgeAbsent?: boolean;
  now: () => number;
}

export function errorBody(code: ErrorCode, message: string): ErrorBody {
  return { error: { code, message } };
}

/** Capability 55. Matches the C0 and C1 control character ranges (built from character codes
 *  rather than a literal escape, so no NUL or other control byte ever sits in this source file),
 *  plus every Unicode "Format" (Cf) code point: zero-width space and joiners, the bidi override
 *  and isolate controls, and the byte-order mark among them. A name built entirely from these is
 *  invisible or reorders the text around it, which is worse than the box a lone control character
 *  renders as, so both families are refused the same way. */
const RUNNER_NAME_CONTROL_CHARS = new RegExp(
  "["
    + String.fromCharCode(0) + "-" + String.fromCharCode(31)
    + String.fromCharCode(127) + "-" + String.fromCharCode(159)
    + "\\p{Cf}"
    + "]",
  "u",
);

/** A 415 that does not say what arrived is a 415 the producer has to guess about, so the received
 *  `Content-Type` is echoed. It is an attacker-controlled header, so only MIME token characters
 *  survive and the result is truncated: nothing here can carry markup, a newline, or a slice of the
 *  uploaded payload back out in the response body. */
function sanitizedContentType(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9!#$&^_.+/-]/g, "").slice(0, 80);
  return cleaned.length === 0 ? "(absent)" : cleaned;
}

type Env = { Variables: { deviceId: string } };

export function createApp(deps: AppDeps): Hono<Env> {
  const app = new Hono<Env>();
  const pairingAdmission = deps.pairingAdmission ?? new PairingAdmission(deps.now);
  const relayFetch = deps.pushRelayFetch ?? fetch;
  const relayLog = deps.pushRelayLog ?? ((message: string) => process.stderr.write(`${message}\n`));
  const gatewaySettingsLog = deps.gatewaySettingsLog
    ?? ((message: string) => process.stderr.write(`${message}\n`));
  const globalSkillsLog = deps.hermesGlobalSkillsLog
    ?? ((message: string) => process.stderr.write(`${message}\n`));
  const relayBase = deps.config.pushRelayUrl?.replace(/\/+$/, "");
  const requestLiveActivityDeletionDrain = (() => {
    let draining = false;
    let requested = false;
    const drainSnapshot = async () => {
      if (relayBase === undefined) return;
      const highWater = deps.storage.liveActivityRelayDeletionHighWater();
      if (highWater === undefined) return;
      let cursor = 0;
      while (cursor < highWater) {
        const page = deps.storage.liveActivityRelayDeletionPage(
          cursor,
          highWater,
          LIVE_ACTIVITY_DELETION_DRAIN_LIMIT,
        );
        if (page.length === 0) return;
        for (const { pushId } of page) {
          try {
            const response = await relayFetch(
              `${relayBase}/register/${encodeURIComponent(pushId)}`,
              {
                method: "DELETE",
                signal: AbortSignal.timeout(
                  Math.max(1, deps.pushRelayDeleteTimeoutMs
                    ?? LIVE_ACTIVITY_RELAY_DELETE_TIMEOUT_MS),
                ),
              },
            );
            if (response.ok) {
              deps.storage.completeLiveActivityRelayDeletion(pushId);
            } else {
              relayLog(`live activity relay cleanup: DELETE returned HTTP ${response.status}`);
            }
          } catch {
            relayLog("live activity relay cleanup: DELETE failed with a network error");
          }
        }
        cursor = page.at(-1)!.sequence;
      }
    };
    return () => {
      requested = true;
      if (draining) return;
      draining = true;
      void (async () => {
        try {
          while (requested) {
            requested = false;
            await drainSnapshot();
          }
        } catch {
          relayLog("live activity relay cleanup: outbox drain failed");
        } finally {
          draining = false;
          if (requested) requestLiveActivityDeletionDrain();
        }
      })();
    };
  })();
  requestLiveActivityDeletionDrain();

  const requireDevice = createMiddleware<Env>(async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ")
      ? header.slice("Bearer ".length)
      : "";
    const device =
      token === ""
        ? undefined
        : deps.storage.deviceByTokenHash(hashToken(token));
    if (device === undefined) {
      return c.json(
        errorBody("unauthorized", "missing or unknown device token"),
        401,
      );
    }
    deps.storage.touchDevice(device.id, deps.now());
    c.set("deviceId", device.id);
    await next();
  });

  const requireAttach = createMiddleware<Env>(async (c, next) => {
    const agentId =
      deps.attachTokens === undefined
        ? undefined
        : resolveAttachBearer(deps.attachTokens, c.req.header("authorization"));
    if (agentId === undefined)
      return c.json(
        errorBody("unauthorized", "missing or unknown attach token"),
        401,
      );
    await next();
  });
  /** Media is an optional rollout; attach-authenticated receipt reads must remain available even
   * when uploads are disabled for this profile. */
  const requireAttachMedia = createMiddleware<Env>(async (c, next) => {
    const agentId =
      deps.attachTokens === undefined
        ? undefined
        : resolveAttachBearer(deps.attachTokens, c.req.header("authorization"));
    if (agentId === undefined)
      return c.json(
        errorBody("unauthorized", "missing or unknown attach token"),
        401,
      );
    if (deps.attachMediaAllowed?.(agentId) === false) {
      return c.json(
        errorBody("invalid_request", "attach media is disabled for this agent"),
        403,
      );
    }
    await next();
  });
  const attachAgent = (c: Context<Env>): string => {
    return resolveAttachBearer(
      deps.attachTokens!,
      c.req.header("authorization"),
    )!;
  };

  const readBody = async (c: Context<Env>): Promise<unknown> => {
    try {
      return await c.req.json();
    } catch {
      return undefined;
    }
  };

  app.get("/gateway/settings", requireDevice, (c) => {
    if (deps.gatewaySettings === undefined)
      return c.json(errorBody("invalid_request", "gateway settings are not editable: no writable source config path"), 409);
    return c.json(deps.gatewaySettings.read());
  });

  app.put("/gateway/settings", requireDevice, async (c) => {
    if (deps.gatewaySettings === undefined)
      return c.json(errorBody("invalid_request", "gateway settings are not editable: no writable source config path"), 409);
    try {
      const input = assertValid(GatewaySettingsSchema, await readBody(c));
      return c.json(deps.gatewaySettings.update(input));
    } catch (error) {
      if (error instanceof ContractViolation)
        return c.json(errorBody("invalid_request", error.message), 400);
      if (error instanceof GatewaySettingsPersistenceError) {
        gatewaySettingsLog(JSON.stringify({
          component: "gateway-settings",
          event: "persistence-failed",
          configPath: error.configPath,
          code: error.code,
        }));
        return c.json(errorBody(
          "invalid_request",
          "Gateway settings cannot be saved because the source configuration is not writable. Check the CozyGateway config mount or file permissions.",
        ), 409);
      }
      throw error;
    }
  });

  const maintenanceFailure = (c: Context<Env>, error: unknown) => {
    if (error instanceof GatewayMaintenanceFailure) {
      const messages: Record<GatewayMaintenanceFailure["code"], string> = {
        stale_version: "Gateway version or update target changed. Refresh and try again.",
        operation_in_progress: "Another gateway maintenance operation is already in progress.",
        restart_unavailable: "This gateway host cannot restart safely.",
        update_unavailable: "No verified gateway update can be installed on this host.",
        insufficient_storage: "The gateway host does not have enough space to stage this update.",
        maintenance_failed: "Gateway maintenance could not be handed to the host supervisor.",
      };
      return c.json({ error: { code: error.code, message: messages[error.code] } }, error.status);
    }
    if (error instanceof ContractViolation)
      return c.json({ error: { code: "invalid_request", message: "Gateway maintenance request is invalid." } }, 400);
    throw error;
  };

  if (deps.maintenance !== undefined) {
    app.get("/gateway/maintenance", requireDevice, (c) => c.json(deps.maintenance!.status()));
    app.get("/gateway/maintenance/operations/:operationId", requireDevice, (c) => {
      try {
        return c.json(deps.maintenance!.operation(c.req.param("operationId")));
      } catch (error) {
        if (error instanceof GatewayMaintenanceNotFound) return c.json({
          error: {
            code: "operation_not_found",
            message: "Gateway maintenance operation was not found.",
          },
        }, 404);
        throw error;
      }
    });
    app.post("/gateway/maintenance/restart", requireDevice, async (c) => {
      try {
        const input = assertValid(GatewayMaintenanceRestartRequestSchema, await readBody(c));
        return c.json(await deps.maintenance!.restart(input.requestId), 202);
      } catch (error) { return maintenanceFailure(c, error); }
    });
    app.post("/gateway/maintenance/update", requireDevice, async (c) => {
      try {
        const input = assertValid(GatewayMaintenanceUpdateRequestSchema, await readBody(c));
        return c.json(await deps.maintenance!.update(
          input.requestId,
          input.expectedCurrentVersion,
          input.expectedTargetVersion,
        ), 202);
      } catch (error) { return maintenanceFailure(c, error); }
    });
  }

  app.get("/gateway/harnesses", requireDevice, (c) => {
    if (deps.harnessSettings === undefined)
      return c.json(errorBody("invalid_request", "agent harness settings are unavailable"), 404);
    return c.json(deps.harnessSettings.catalog());
  });

  const harnessUpdateFailure = (c: Context<Env>, error: unknown) => {
    if (error instanceof HarnessUpdateStale)
      return c.json({
        ...errorBody("invalid_request", error.message),
        currentVersion: error.currentVersion,
      }, 409);
    if (error instanceof HarnessUpdateBlocked)
      return c.json({
        ...errorBody("invalid_request", error.message),
        guidance: error.guidance,
      }, 409);
    if (error instanceof HarnessSettingsInvalid)
      return c.json(errorBody("invalid_request", error.message), 404);
    if (error instanceof HarnessUpdateUnavailable)
      return c.json(errorBody("backend_unavailable", error.message), 503);
    if (error instanceof ContractViolation)
      return c.json(errorBody("invalid_request", error.message), 400);
    throw error;
  };

  app.get("/gateway/harnesses/:harnessId/update/check", requireDevice, async (c) => {
    try {
      if (deps.harnessUpdates === undefined) throw new HarnessSettingsInvalid("agent harness updates are unavailable");
      return c.json(await deps.harnessUpdates.adapter(c.req.param("harnessId")).check());
    } catch (error) { return harnessUpdateFailure(c, error); }
  });

  app.post("/gateway/harnesses/:harnessId/update/start", requireDevice, async (c) => {
    try {
      if (deps.harnessUpdates === undefined) throw new HarnessSettingsInvalid("agent harness updates are unavailable");
      const input = assertValid(HarnessUpdateStartRequestSchema, await readBody(c));
      const body = await deps.harnessUpdates.adapter(c.req.param("harnessId"))
        .start(input.expectedCurrentVersion);
      return c.json(body, 202);
    } catch (error) { return harnessUpdateFailure(c, error); }
  });

  app.get("/gateway/harnesses/:harnessId/update/status", requireDevice, async (c) => {
    try {
      if (deps.harnessUpdates === undefined) throw new HarnessSettingsInvalid("agent harness updates are unavailable");
      return c.json(await deps.harnessUpdates.adapter(c.req.param("harnessId")).status());
    } catch (error) { return harnessUpdateFailure(c, error); }
  });

  const workspaceFailure = (c: Context<Env>, error: unknown) => {
    if (error instanceof WorkspaceRangeInvalid)
      return new Response(null, {
        status: 416,
        headers: {
          "accept-ranges": "bytes",
          ...(error.size === undefined ? {} : { "content-range": `bytes */${error.size}` }),
        },
      });
    if (error instanceof WorkspaceInvalid)
      return c.json(errorBody("invalid_request", "workspace path or request is invalid"), 400);
    if (error instanceof WorkspaceForbidden)
      return c.json(errorBody("not_found", "workspace item is not available"), 403);
    if (error instanceof WorkspaceNotFound)
      return c.json(errorBody("not_found", "workspace item was not found"), 404);
    if (error instanceof WorkspaceTooLarge)
      return c.json(errorBody("invalid_request", "workspace result is over its configured bound"), 413);
    if (error instanceof WorkspaceRateLimited)
      return c.json(
        errorBody("invalid_request", "too many workspace requests; try again later"),
        429,
        { "retry-after": String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))) },
      );
    if (error instanceof WorkspaceBusy)
      return c.json(
        errorBody("backend_unavailable", "workspace downloads are busy; try again later"),
        503,
        { "retry-after": "1" },
      );
    if (error instanceof WorkspaceUnavailable)
      return c.json(errorBody("backend_unavailable", "workspace upstream is unavailable"), 503);
    throw error;
  };

  app.get("/gateway/harnesses/:harnessId/scopes/:scopeId/workspace", requireDevice, async (c) => {
    try {
      if (deps.harnessWorkspace === undefined)
        throw new WorkspaceNotFound("workspace capability unavailable");
      return c.json(await deps.harnessWorkspace.list(
        c.req.param("harnessId"),
        c.req.param("scopeId"),
        c.req.query("path"),
        c.get("deviceId"),
        c.req.raw.signal,
      ));
    } catch (error) { return workspaceFailure(c, error); }
  });

  app.get("/gateway/harnesses/:harnessId/scopes/:scopeId/workspace/download", requireDevice, async (c) => {
    try {
      if (deps.harnessWorkspace === undefined)
        throw new WorkspaceNotFound("workspace capability unavailable");
      const download = await deps.harnessWorkspace.download(
        c.req.param("harnessId"),
        c.req.param("scopeId"),
        c.req.query("path"),
        c.req.header("range"),
        c.get("deviceId"),
        c.req.raw.signal,
      );
      const length = download.size === 0 ? 0 : download.end - download.start + 1;
      return new Response(download.body, {
        status: download.status,
        headers: {
          "content-type": download.mimeType,
          "content-length": String(length),
          "accept-ranges": "bytes",
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
          "content-disposition": attachmentDisposition(download.filename),
          ...(download.status === 206
            ? { "content-range": `bytes ${download.start}-${download.end}/${download.size}` }
            : {}),
        },
      });
    } catch (error) { return workspaceFailure(c, error); }
  });

  const sessionFailure = (c: Context<Env>, error: unknown) => {
    if (error instanceof ContractViolation || error instanceof HermesSessionInvalid)
      return c.json(errorBody("invalid_request", "Hermes session request is invalid"), 400);
    if (error instanceof HermesSessionNotFound)
      return c.json(errorBody("not_found", "Hermes session, harness, or profile was not found"), 404);
    if (error instanceof HermesSessionTooLarge)
      return c.json(errorBody("invalid_request", "Hermes session result is over its configured bound"), 413);
    if (error instanceof HermesSessionMutationAmbiguous)
      return c.json({
        ...errorBody("backend_unavailable", "Hermes session state is uncertain; refresh before another change"),
        refreshRequired: true as const,
      }, 503);
    if (error instanceof HermesSessionUnavailable)
      return c.json(errorBody("backend_unavailable", "Hermes session upstream is unavailable"), 503);
    throw error;
  };
  const boundedInteger = (
    raw: string | undefined,
    fallback: number,
    min: number,
    max: number,
  ): number => {
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw)) throw new HermesSessionInvalid("invalid integer query");
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new HermesSessionInvalid("integer query is out of bounds");
    return value;
  };
  const hermesSessionId = (raw: string | undefined): string => {
    const value = raw ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value))
      throw new HermesSessionInvalid("Hermes session id is invalid");
    return value;
  };
  const sessionAdapter = (c: Context<Env>) => {
    if (deps.hermesSessions === undefined)
      throw new HermesSessionNotFound("Hermes session management is unavailable");
    return deps.hermesSessions.adapter(c.req.param("harnessId") ?? "");
  };

  app.get("/gateway/harnesses/:harnessId/scopes/:scopeId/sessions", requireDevice, async (c) => {
    try {
      const archived = c.req.query("archived") ?? "exclude";
      if (archived !== "exclude" && archived !== "include" && archived !== "only")
        throw new HermesSessionInvalid("archived query is invalid");
      return c.json(await sessionAdapter(c).list(c.req.param("scopeId"), {
        limit: boundedInteger(c.req.query("limit"), 50, 1, HERMES_SESSION_LIST_MAX),
        offset: boundedInteger(c.req.query("offset"), 0, 0, HERMES_SESSION_OFFSET_MAX),
        archived,
      }, c.req.raw.signal));
    } catch (error) { return sessionFailure(c, error); }
  });

  app.get("/gateway/harnesses/:harnessId/scopes/:scopeId/sessions/search", requireDevice, async (c) => {
    try {
      const query = (c.req.query("q") ?? "").trim();
      if (!query || query.length > HERMES_SESSION_QUERY_MAX_LENGTH)
        throw new HermesSessionInvalid("search query is invalid");
      return c.json(await sessionAdapter(c).search(
        c.req.param("scopeId"),
        query,
        boundedInteger(c.req.query("limit"), 20, 1, HERMES_SESSION_SEARCH_MAX),
        c.req.raw.signal,
      ));
    } catch (error) { return sessionFailure(c, error); }
  });

  app.get("/gateway/harnesses/:harnessId/scopes/:scopeId/sessions/:sessionId", requireDevice, async (c) => {
    try {
      return c.json(await sessionAdapter(c).detail(
        c.req.param("scopeId"),
        hermesSessionId(c.req.param("sessionId")),
        c.req.raw.signal,
      ));
    } catch (error) { return sessionFailure(c, error); }
  });

  app.get("/gateway/harnesses/:harnessId/scopes/:scopeId/sessions/:sessionId/messages", requireDevice, async (c) => {
    try {
      const order = c.req.query("order") ?? "latest";
      if (order !== "oldest" && order !== "latest")
        throw new HermesSessionInvalid("message order is invalid");
      return c.json(await sessionAdapter(c).messages(
        c.req.param("scopeId"),
        hermesSessionId(c.req.param("sessionId")),
        {
          limit: boundedInteger(c.req.query("limit"), 100, 1, HERMES_SESSION_MESSAGES_MAX),
          offset: boundedInteger(c.req.query("offset"), 0, 0, HERMES_SESSION_OFFSET_MAX),
          order,
        },
        c.req.raw.signal,
      ));
    } catch (error) { return sessionFailure(c, error); }
  });

  app.get("/gateway/harnesses/:harnessId/scopes/:scopeId/sessions/:sessionId/export", requireDevice, async (c) => {
    try {
      const sessionId = hermesSessionId(c.req.param("sessionId"));
      const exported = await sessionAdapter(c).export(
        c.req.param("scopeId"), sessionId, c.req.raw.signal,
      );
      return new Response(exported.body, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": attachmentDisposition(exported.filename),
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
        },
      });
    } catch (error) { return sessionFailure(c, error); }
  });

  app.patch("/gateway/harnesses/:harnessId/scopes/:scopeId/sessions/:sessionId", requireDevice, async (c) => {
    try {
      const patch = assertValid(HermesSessionPatchSchema, await readBody(c));
      if (patch.title === undefined && patch.archived === undefined && patch.pinned === undefined)
        throw new HermesSessionInvalid("session patch is empty");
      return c.json(await sessionAdapter(c).patch(
        c.req.param("scopeId"), hermesSessionId(c.req.param("sessionId")), patch,
      ));
    } catch (error) { return sessionFailure(c, error); }
  });

  app.delete("/gateway/harnesses/:harnessId/scopes/:scopeId/sessions/:sessionId", requireDevice, async (c) => {
    try {
      await sessionAdapter(c).delete(
        c.req.param("scopeId"), hermesSessionId(c.req.param("sessionId")),
      );
      return c.body(null, 204);
    } catch (error) { return sessionFailure(c, error); }
  });

  const harnessFailure = (c: Context<Env>, error: unknown) => {
    if (error instanceof HarnessSettingsInvalid)
      return c.json(errorBody("invalid_request", error.message), 404);
    if (error instanceof ProviderSetupInvalid || error instanceof ContractViolation)
      return c.json(errorBody("invalid_request", error.message), 400);
    throw error;
  };

  app.get("/gateway/harnesses/:harnessId/scopes/:scopeId/model-providers", requireDevice, async (c) => {
    try {
      if (deps.harnessSettings === undefined) throw new HarnessSettingsInvalid("agent harness settings are unavailable");
      return c.json(await deps.harnessSettings.adapter(c.req.param("harnessId")).modelProviders(c.req.param("scopeId")));
    } catch (error) { return harnessFailure(c, error); }
  });

  app.put("/gateway/harnesses/:harnessId/scopes/:scopeId/model-providers/:provider/fields/:field", requireDevice, async (c) => {
    try {
      if (deps.harnessSettings === undefined) throw new HarnessSettingsInvalid("agent harness settings are unavailable");
      const input = assertValid(ModelProviderFieldUpdateSchema, await readBody(c));
      const adapter = deps.harnessSettings.adapter(c.req.param("harnessId"));
      return c.json(await adapter.configureField(c.req.param("scopeId"), c.req.param("provider"), c.req.param("field"), input.value));
    } catch (error) { return harnessFailure(c, error); }
  });

  app.delete("/gateway/harnesses/:harnessId/scopes/:scopeId/model-providers/:provider/fields/:field", requireDevice, async (c) => {
    try {
      if (deps.harnessSettings === undefined) throw new HarnessSettingsInvalid("agent harness settings are unavailable");
      const adapter = deps.harnessSettings.adapter(c.req.param("harnessId"));
      return c.json(await adapter.clearField(c.req.param("scopeId"), c.req.param("provider"), c.req.param("field")));
    } catch (error) { return harnessFailure(c, error); }
  });

  app.post("/gateway/harnesses/:harnessId/scopes/:scopeId/model-providers/:provider/oauth", requireDevice, async (c) => {
    try {
      if (deps.harnessSettings === undefined) throw new HarnessSettingsInvalid("agent harness settings are unavailable");
      const adapter = deps.harnessSettings.adapter(c.req.param("harnessId"));
      return c.json(await adapter.startOAuth(c.req.param("scopeId"), c.req.param("provider")));
    } catch (error) { return harnessFailure(c, error); }
  });

  app.get("/gateway/harnesses/:harnessId/scopes/:scopeId/model-providers/:provider/oauth/:sessionId", requireDevice, async (c) => {
    try {
      if (deps.harnessSettings === undefined) throw new HarnessSettingsInvalid("agent harness settings are unavailable");
      const adapter = deps.harnessSettings.adapter(c.req.param("harnessId"));
      return c.json(await adapter.pollOAuth(c.req.param("scopeId"), c.req.param("provider"), c.req.param("sessionId")));
    } catch (error) { return harnessFailure(c, error); }
  });

  app.post("/gateway/harnesses/:harnessId/scopes/:scopeId/model-providers/:provider/oauth/:sessionId/code", requireDevice, async (c) => {
    try {
      if (deps.harnessSettings === undefined) throw new HarnessSettingsInvalid("agent harness settings are unavailable");
      const input = assertValid(ModelProviderOAuthCodeSchema, await readBody(c));
      const adapter = deps.harnessSettings.adapter(c.req.param("harnessId"));
      return c.json(await adapter.submitOAuthCode(c.req.param("scopeId"), c.req.param("provider"), c.req.param("sessionId"), input.code));
    } catch (error) { return harnessFailure(c, error); }
  });

  app.delete("/gateway/harnesses/:harnessId/scopes/:scopeId/model-providers/:provider/oauth/:sessionId", requireDevice, async (c) => {
    try {
      if (deps.harnessSettings === undefined) throw new HarnessSettingsInvalid("agent harness settings are unavailable");
      const adapter = deps.harnessSettings.adapter(c.req.param("harnessId"));
      await adapter.cancelOAuth(c.req.param("scopeId"), c.req.param("provider"), c.req.param("sessionId"));
      return c.body(null, 204);
    } catch (error) { return harnessFailure(c, error); }
  });

  // `deps.gatewayInfo` is a static snapshot taken once at server assembly (it also seeds `/pair`
  // and the `ready` frame), so it cannot carry live bridge state. `bridges` is computed fresh on
  // every call instead: it is the whole point of issue #63 that a monitor polling this route sees
  // the hermes link's CURRENT liveness, not whatever was true when the process started.
  app.get("/health", (c) =>
    c.json({
      // Capability 52: a gateway configured with no Hermes endpoint reports the bridge as ABSENT
      // rather than as an offline bridge. There is nothing to restart or de-route on, and a
      // configuration that could not exist before 52 is the only place this shape appears.
      ...(deps.bots === undefined
        ? deps.gatewayInfo
        : deps.hermesBridgeAbsent === true
          ? { ...deps.gatewayInfo, bridges: { hermes: "absent" } }
          : { ...deps.gatewayInfo, bridges: { hermes: deps.bots.health() } }),
      ...(deps.attachHealth === undefined ? {} : { attach: deps.attachHealth() }),
    }),
  );

  // Readiness (follow-up to issue #63, tracked separately): `/health` answers "is the process
  // alive", which is what a supervisor restarts on. `/ready` answers a different question, "will
  // a send actually deliver right now", which is what a router or monitor should alarm or
  // de-route on instead. The two must never be pointed at the same action: an offline hermes link
  // is not fixed by restarting the gateway process, so wiring a restart to this route would just
  // cycle a healthy process while the real fault -- a dead upstream bridge -- sits untouched.
  //
  // Same synchronous liveness snapshot `/health` reads (`deps.bots.health()`), no new I/O per
  // request, for the same reason `/health` does not: a readiness probe that has to make its own
  // network call to answer is itself a new way to go dark.
  app.get("/ready", (c) => {
    if (deps.bots === undefined) return c.json({ ready: true, ...(deps.attachHealth === undefined ? {} : { attach: deps.attachHealth() }) });
    // No Hermes endpoint configured at all: ready, with the bridge named absent. A CozyAgents-only
    // gateway serves its roster from runtime bots, and alarming on a bridge nobody configured would
    // de-route a gateway that is answering perfectly well.
    if (deps.hermesBridgeAbsent === true)
      return c.json({
        ready: true,
        bridges: { hermes: "absent" },
        ...(deps.attachHealth === undefined ? {} : { attach: deps.attachHealth() }),
      });
    const bridges = { hermes: deps.bots.health() };
    const allOnline = Object.values(bridges).every((bridge) => bridge.online);
    return c.json({ ready: allOnline, bridges, ...(deps.attachHealth === undefined ? {} : { attach: deps.attachHealth() }) }, allOnline ? 200 : 503);
  });

  app.post("/pair", async (c) => {
    const body = await readPairBody(c.req.raw);
    if (body.kind === "too_large") {
      return c.json(
        errorBody("invalid_request", `pairing request is over the ${PAIR_REQUEST_MAX_BYTES} byte cap`),
        413,
      );
    }
    const retryAfter = pairingAdmission.attempt();
    if (retryAfter !== undefined) {
      return c.json(
        errorBody("invalid_request", "too many pairing attempts; try again later"),
        429,
        { "retry-after": String(retryAfter) },
      );
    }
    let pairRequest;
    try {
      pairRequest = assertValid(PairRequestSchema, body.value);
    } catch (err) {
      const detail =
        err instanceof ContractViolation ? err.message : "malformed body";
      return c.json(errorBody("invalid_request", detail), 400);
    }
    // Capability 52. `deviceName` is required for a device pair and optional for a runner pair,
    // enforced here rather than in the schema so no existing device client's request, response or
    // error message changes shape.
    const kind = pairRequest.kind ?? "device";
    if (kind === "device" && pairRequest.deviceName === undefined) {
      return c.json(errorBody("invalid_request", "deviceName is required"), 400);
    }
    if (kind === "runner" && deps.runners === undefined) {
      return c.json(errorBody("invalid_request", "this gateway does not pair runners"), 400);
    }
    // The kind is checked as part of consuming the code, so a code minted for a runner and
    // presented as a device (or the reverse) answers exactly the 401 an expired code answers, with
    // no new detail to tell the two apart.
    if (
      deps.storage.consumeSetupCode(pairRequest.setupCode, deps.now(), kind) !== "ok"
    ) {
      return c.json(
        errorBody(
          "setup_code_invalid",
          "setup code is unknown, used, or expired",
        ),
        401,
      );
    }
    if (kind === "runner") {
      const paired = deps.runners!.pair(
        pairRequest.deviceName === undefined ? {} : { name: pairRequest.deviceName },
      );
      return c.json({
        runnerToken: paired.token,
        runner: runnerToWire(paired.runner, false),
        gateway: deps.gatewayInfo,
      });
    }
    const { token, tokenHash } = mintDeviceToken();
    const device = {
      id: randomUUID(),
      name: pairRequest.deviceName!,
      tokenHash,
      createdAt: deps.now(),
    };
    deps.storage.createDevice(device);
    return c.json({
      deviceToken: token,
      device: {
        id: device.id,
        name: device.name,
        createdAt: device.createdAt,
        lastSeenAt: null,
      },
      gateway: deps.gatewayInfo,
    });
  });

  app.get("/devices", requireDevice, (c) => c.json(deps.storage.listDevices()));

  // Capability 52. The paired computers that run bots, beside the paired phones and shaped like
  // them, including the 404 an unknown id gets.
  if (deps.runners !== undefined) {
    const roster = deps.runners;
    const online = (id: string) => deps.runnerPresence?.online(id) ?? false;
    const seenAt = (id: string, stored: number | null) =>
      deps.runnerPresence?.lastContactAt(id) ?? stored;
    // Capability 54. The bots this gateway placed on that computer, counted off the durable rows
    // rather than tracked, so it is the same answer before and after a restart.
    const botCount = (id: string) => deps.storage.countRuntimeBotsForRunner(id);
    app.get("/runners", requireDevice, (c) =>
      c.json({
        runners: [
          ...roster.list().map((row) =>
            runnerToWire(
              { ...row, lastSeenAt: seenAt(row.id, row.lastSeenAt) },
              online(row.id),
              botCount(row.id),
            ),
          ),
          // The legacy shared credential is one row too, so a gateway carrying both kinds answers
          // one list rather than hiding the runner an operator placed by hand.
          ...(deps.legacyRunnerConfigured === true
            ? [
                runnerToWire(
                  legacyRunnerRow({ lastSeenAt: seenAt(LEGACY_RUNNER_ID, null) }),
                  online(LEGACY_RUNNER_ID),
                  botCount(LEGACY_RUNNER_ID),
                ),
              ]
            : []),
        ],
      }),
    );
    // Authenticated by the runner's OWN token and nothing else. It is the only route a runner
    // credential opens: no chat, no device list, no bot creation, and no other runner's row.
    app.get("/runners/self", (c) => {
      const row = roster.resolve(c.req.header("authorization"));
      if (row === undefined)
        return c.json(errorBody("unauthorized", "missing or unknown runner token"), 401);
      const attached = online(row.id);
      return c.json({
        id: row.id,
        // Capability 55: the display name once a person has set one, exactly as GET /runners
        // renders it, with `renamed` below saying which is which.
        name: effectiveRunnerName(row),
        platform: row.platform,
        default: row.isDefault,
        lastSeenAt: seenAt(row.id, row.lastSeenAt),
        // What the INSTALLER polls: the row exists (it just paired) long before the service it
        // registered has dialed in, so "am I attached" is a different question from "do I exist".
        attached,
        // Released Agents updaters read `online`; keep it equal to live attachment so they can
        // verify the first upgrade to an Agents release that reads `attached` instead.
        online: attached,
        // An update verifier may accept this only alongside `attached`: it is read from the live
        // authenticated hello, never the durable roster observation left by an old connection.
        ...(deps.runnerPresence?.agentVersion(row.id) === undefined
          ? {}
          : { agentVersion: deps.runnerPresence.agentVersion(row.id) }),
        renamed: row.displayName !== null,
      });
    });
    // Minting a runner code from the app, with the same 10 minute TTL and the same gateway-wide
    // bucket the unauthenticated pairing route spends: a code is a credential in waiting, and it is
    // bounded here for the same reason it is bounded there.
    app.post("/runners/pair-code", requireDevice, (c) => {
      const retryAfter = pairingAdmission.attempt();
      if (retryAfter !== undefined) {
        return c.json(
          errorBody("invalid_request", "too many pairing attempts; try again later"),
          429,
          { "retry-after": String(retryAfter) },
        );
      }
      const setupCode = newSetupCode();
      const expiresAt = deps.now() + SETUP_CODE_TTL_MS;
      deps.storage.createSetupCode(setupCode, expiresAt, "runner");
      return c.json({ setupCode, expiresAt, gatewayUrl: deps.pairingUrl?.() ?? configuredOrigin(deps.config) });
    });
    app.patch("/runners/:id", requireDevice, async (c) => {
      const id = c.req.param("id");
      if (id === LEGACY_RUNNER_ID)
        return c.json(
          errorBody("invalid_request", "the legacy shared runner is placed by the operator and cannot be changed here"),
          400,
        );
      const parsed = parseOr400(c, RunnerPatchRequestSchema, await readBody(c));
      if (!parsed.ok) return parsed.response;
      const { default: moveDefault, name } = parsed.value;
      if (moveDefault === undefined && name === undefined) {
        return c.json(
          errorBody("invalid_request", "name a field to change: default or name"),
          400,
        );
      }
      if (moveDefault !== undefined && !moveDefault) {
        return c.json(
          errorBody("invalid_request", "default is moved by naming the runner that should hold it"),
          400,
        );
      }
      // Capability 55. `name` clears the display name ONLY on the literal "" or null; a
      // whitespace-only string is a client mistake, not a clear, and is refused rather than
      // silently treated as one. Otherwise it must be 1 to 64 CODE POINTS after trimming -- counted
      // with a spread, not `.length`, so a name built of astral characters (most emoji) is not
      // clipped at half a code point -- with no control or Unicode format character, the same shape
      // a display name is rendered in everywhere else, so a bad value is refused rather than stored
      // and shown ugly, invisible, or reordered.
      let displayName: string | null | undefined;
      if (name !== undefined) {
        if (name === null || name === "") {
          displayName = null;
        } else {
          const trimmed = name.trim();
          const codePoints = [...trimmed].length;
          if (
            codePoints === 0 || codePoints > 64 || RUNNER_NAME_CONTROL_CHARS.test(trimmed)
          ) {
            return c.json(
              errorBody(
                "invalid_request",
                "name must be 1 to 64 characters (code points) after trimming, with no control or format characters",
              ),
              400,
            );
          }
          displayName = trimmed;
        }
      }
      if (roster.get(id) === undefined)
        return c.json(errorBody("not_found", "no such runner"), 404);
      if (moveDefault === true && roster.setDefault(id) === undefined)
        return c.json(errorBody("not_found", "no such runner"), 404);
      if (displayName !== undefined && roster.setDisplayName(id, displayName) === undefined)
        return c.json(errorBody("not_found", "no such runner"), 404);
      const updated = roster.get(id)!;
      return c.json({ runner: runnerToWire({ ...updated, lastSeenAt: seenAt(updated.id, updated.lastSeenAt) }, online(updated.id)) });
    });
    app.delete("/runners/:id", requireDevice, (c) => {
      const id = c.req.param("id");
      if (id === LEGACY_RUNNER_ID)
        return c.json(
          errorBody("invalid_request", "the legacy shared runner is revoked by unsetting COZYGATEWAY_RUNNER_TOKEN"),
          400,
        );
      // Counted BEFORE the row goes, and the bots themselves are left exactly as they are:
      // revoking a computer strands its bots, it does not delete them, and the number is what the
      // app warns with.
      const stranded = botCount(id);
      if (!roster.remove(id)) return c.json(errorBody("not_found", "no such runner"), 404);
      // Capability 54. The work that machine had not been handed yet would otherwise be addressed
      // to a runner that can no longer authenticate, so it is re-addressed here: to the account
      // default when there is one, and to nobody when there is not, which is the unaddressed state
      // the default picks up as soon as one is set. Read AFTER the removal, so the revoked runner
      // is never its own successor.
      const successor = roster.defaultRunner()?.id ?? null;
      const reassignedOperations = deps.storage.readdressUnsentRunnerOperations(id, successor);
      deps.onRunnerRevoked?.(id);
      const body: RunnerDeleteResponse = {
        ok: true,
        botCount: stranded,
        reassignedOperations,
        ...(successor === null || reassignedOperations === 0 ? {} : { reassignedTo: successor }),
      };
      // The published schema against the real bytes, so a route that drifts from the contract fails
      // here rather than on a phone.
      return c.json(assertValid(RunnerDeleteResponseSchema, body));
    });
  }

  if (deps.hermesGlobalSkills !== undefined) {
    const globalSkillError = (code: string, message: string) => ({ error: { code, message } });
    const globalSkillsFailure = (c: Context<Env>, error: unknown) => {
      if (error instanceof GlobalSkillsInvalid)
        return c.json(globalSkillError("invalid_skill_name", "Skill name or update is invalid"), 400);
      if (error instanceof GlobalSkillsNotFound)
        return c.json(globalSkillError("skill_not_found", "This skill is not available on the managed Hermes profiles."), 404);
      if (error instanceof GlobalSkillsStale)
        return c.json({
          ...globalSkillError("stale_revision", "Global skill settings changed. Refresh and try again."),
          current: error.current,
        }, 409);
      if (error instanceof GlobalSkillsBusy)
        return c.json(globalSkillError("operation_in_progress", "Another global skill update is in progress. Try again shortly."), 409);
      if (error instanceof GlobalSkillsNoProfiles)
        return c.json(globalSkillError("no_managed_profiles", "No managed Hermes profiles are available."), 422);
      if (error instanceof HermesUnavailable)
        return c.json(globalSkillError("hermes_unavailable", "Hermes is unavailable. Try again shortly."), 503);
      if (error instanceof GlobalSkillsPersistenceFailed)
        return c.json(globalSkillError("persistence_failed", "Global skill settings could not be saved."), 500);
      return c.json(globalSkillError("persistence_failed", "Global skill settings could not be saved."), 500);
    };
    app.get("/hermes/skills", requireDevice, async (c) => {
      try { return c.json(await deps.hermesGlobalSkills!.read()); }
      catch (error) { return globalSkillsFailure(c, error); }
    });
    app.patch("/hermes/skills/:skillName", requireDevice, async (c) => {
      const body = await readBody(c);
      const skillName = c.req.param("skillName");
      const request = typeof body === "object" && body !== null && !Array.isArray(body)
        ? body as Record<string, unknown> : {};
      const audit = (outcome: string) => globalSkillsLog(JSON.stringify({
        component: "hermes-global-skills",
        deviceId: c.get("deviceId"),
        skillName: typeof skillName === "string" ? skillName.trim().slice(0, 256) : "",
        enabled: request["enabled"] === true,
        targetCount: deps.hermesGlobalSkills!.targetCount,
        requestId: typeof request["requestId"] === "string" ? request["requestId"].slice(0, 64) : "",
        outcome,
      }));
      try {
        const snapshot = await deps.hermesGlobalSkills!.mutate({
          skillName, enabled: request["enabled"], expectedRevision: request["expectedRevision"], requestId: request["requestId"],
        });
        audit("success");
        return c.json(snapshot);
      } catch (error) {
        audit(error instanceof Error ? error.constructor.name : "failed");
        // The device receives only a display-safe envelope below. Operators still need the
        // underlying Hermes/Dashboard exception (including a filesystem diagnostic when Hermes
        // supplied one) to repair a failed write, so retain it in the server-only trace.
        globalSkillsLog(JSON.stringify({
          component: "hermes-global-skills",
          event: "mutation-failed",
          deviceId: c.get("deviceId"),
          requestId: typeof request["requestId"] === "string" ? request["requestId"].slice(0, 64) : "",
          error: error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: "unknown", message: String(error) },
        }));
        return globalSkillsFailure(c, error);
      }
    });
  }
  // Durable user library. Bot-side upserts use the separate attach-v1 cozyapps lane; these are
  // deliberately the only device mutations (rename, explicit generated-tree replacement, delete).
  app.get("/cozyapps", requireDevice, (c) => c.json(deps.storage.listCozyApps()));
  app.get("/cozyapps/:id", requireDevice, (c) => {
    const app = deps.storage.cozyApp(c.req.param("id"));
    return app === undefined ? c.json(errorBody("not_found", "cozy app not found"), 404) : c.json(app);
  });
  app.patch("/cozyapps/:id", requireDevice, async (c) => {
    try {
      const input = assertValid(CozyAppRenameRequestSchema, await c.req.json());
      return deps.storage.renameCozyApp(c.req.param("id"), input.name, deps.now())
        ? (deps.cozyAppsChanged?.(), c.json(deps.storage.cozyApp(c.req.param("id"))!))
        : c.json(errorBody("not_found", "cozy app not found"), 404);
    } catch (err) { return c.json(errorBody("invalid_request", err instanceof Error ? err.message : "invalid request"), 400); }
  });
  app.put("/cozyapps/:id/tree", requireDevice, async (c) => {
    try {
      const input = assertValid(CozyAppReplaceTreeRequestSchema, await c.req.json());
      assertValidCozyAppTree(input.tree);
      const result = deps.storage.replaceCozyAppTree(c.req.param("id"), input.expectedRevision, input.tree, deps.now());
      if (result === "not_found") return c.json(errorBody("not_found", "cozy app not found"), 404);
      if (result === "conflict") return c.json({ error: { code: "conflict", message: "cozy app changed; refresh and retry" }, current: deps.storage.cozyApp(c.req.param("id")) }, 409);
      deps.cozyAppsChanged?.(); return c.json(deps.storage.cozyApp(c.req.param("id"))!);
    } catch (err) { return c.json(errorBody("invalid_request", err instanceof Error ? err.message : "invalid request"), 400); }
  });
  app.delete("/cozyapps/:id", requireDevice, (c) => deps.storage.deleteCozyApp(c.req.param("id")) ? (deps.cozyAppsChanged?.(), c.body(null, 204)) : c.json(errorBody("not_found", "cozy app not found"), 404));
  app.post("/cozyapps/:id/actions", requireDevice, async (c) => {
    try {
      const input = assertValid(CozyAppActionRequestSchema, await c.req.json());
      const app = deps.storage.cozyApp(c.req.param("id"));
      if (app === undefined) return c.json(errorBody("not_found", "cozy app not found"), 404);
      const hasAction = (node: any): boolean => (node.kind === "button" && node.actionId === input.actionId) || (node.children ?? []).some(hasAction);
      if (input.actionId !== "refresh" && !hasAction(app.tree.root)) return c.json(errorBody("invalid_request", "cozy app action not found"), 400);
      const { action, fresh } = deps.storage.createCozyAppAction({ id: randomUUID(), appId: app.id, creatorBot: app.creatorBot, actionId: input.actionId, idempotencyKey: input.idempotencyKey, now: deps.now() });
      if (fresh && deps.sendCozyAppAction !== undefined && !deps.sendCozyAppAction(action, c.get("deviceId")))
        deps.storage.settleCozyAppAction({ id: action.id, appId: action.appId, creatorBot: action.creatorBot, actionId: action.actionId, status: "failed", now: deps.now() });
      if (fresh) deps.cozyAppsChanged?.();
      return c.json(deps.storage.cozyAppsSnapshot().actions.find((item) => item.id === action.id) ?? action, 202);
    } catch (err) { return c.json(errorBody("invalid_request", err instanceof Error ? err.message : "invalid request"), 400); }
  });
  app.get("/cozyapps/:id/nodes/:nodeId/image", requireDevice, async (c) => {
    const app = deps.storage.cozyApp(c.req.param("id"));
    const findImage = (node: any): string | undefined => node.id === c.req.param("nodeId") && node.kind === "image" ? node.source : (node.children ?? []).map(findImage).find(Boolean);
    const source = app === undefined ? undefined : findImage(app.tree.root);
    if (source === undefined) return c.json(errorBody("not_found", "cozy app image not found"), 404);
    try {
      const media = await fetchMedia(resolveMediaSource(source), { ...(deps.mediaFetch === undefined ? {} : { fetchImpl: deps.mediaFetch }), ...(deps.mediaLookup === undefined ? {} : { lookup: deps.mediaLookup }), ...(deps.mediaLimiter === undefined ? {} : { limiter: deps.mediaLimiter }), ...(deps.mediaQueueWaitMs === undefined ? {} : { queueWaitMs: deps.mediaQueueWaitMs }) });
      return new Response(media.body, { headers: { "content-type": media.contentType, "cache-control": MEDIA_CACHE_CONTROL, ...(media.contentLength === undefined ? {} : { "content-length": String(media.contentLength) }) } });
    } catch (err) {
      if (err instanceof MediaRefused) return c.json({ ...errorBody("invalid_request", err.message), reason: err.reason }, 400);
      if (err instanceof MediaBusy) return c.json(errorBody("backend_unavailable", "image proxy is busy"), 503);
      if (err instanceof MediaTimedOut || err instanceof MediaUpstreamFailed) return c.json(errorBody("backend_unavailable", "image source unavailable"), 502);
      return c.json(errorBody("internal", "image proxy failed"), 500);
    }
  });

  // Issue #193's operator surface. A projection dead letter head-of-line blocks its agent's
  // whole event stream; before these routes the only remedies were DB surgery or a redeploy.
  app.get("/attach/deadletters", requireDevice, (c) =>
    c.json({ deadLetters: deps.attachDeadLetters?.() ?? [] }));

  app.post("/attach/deadletters/release", requireDevice, async (c) => {
    const body = (await c.req.json().catch(() => undefined)) as
      | { agentId?: unknown; eventId?: unknown }
      | undefined;
    if (body === undefined || typeof body.agentId !== "string" || typeof body.eventId !== "string")
      return c.json(errorBody("invalid_request", "agentId and eventId are required"), 400);
    if (deps.releaseAttachDeadLetter === undefined)
      return c.json(errorBody("not_found", "attach is not configured"), 404);
    if (!deps.releaseAttachDeadLetter(body.agentId, body.eventId))
      return c.json(errorBody("not_found", "not the first dead letter for that agent"), 404);
    return c.json({ released: true });
  });

  app.delete("/devices/:id", requireDevice, (c) => {
    const id = c.req.param("id");
    if (!deps.storage.deleteDevice(id)) {
      return c.json(errorBody("not_found", "no such device"), 404);
    }
    deps.onDeviceRevoked(id);
    return c.json({ ok: true });
  });

  const parseOr400 = <S extends Parameters<typeof assertValid>[0]>(
    c: Context<Env>,
    schema: S,
    body: unknown,
  ) => {
    try {
      return { ok: true as const, value: assertValid(schema, body) };
    } catch (err) {
      const detail =
        err instanceof ContractViolation ? err.message : "malformed body";
      return {
        ok: false as const,
        response: c.json(errorBody("invalid_request", detail), 400),
      };
    }
  };

  const threadToWire = (t: ThreadRow) => ({
    id: t.id,
    agentId: t.agentId,
    title: t.title,
    createdAt: t.createdAt,
    lastMessageAt: t.lastMessageAt,
  });

  app.get("/agents", requireDevice, (c) =>
    c.json(
      deps.storage.listAgents().map((a) => ({
        id: a.id,
        name: a.name,
        ...(a.avatar === null ? {} : { avatar: a.avatar }),
        backend: a.backend,
        presence: deps.presenceOf(a.id),
      })),
    ),
  );

  app.get("/threads", requireDevice, (c) =>
    c.json(deps.storage.listThreads().map(threadToWire)),
  );

  app.post("/threads", requireDevice, async (c) => {
    const parsed = parseOr400(c, CreateThreadRequestSchema, await readBody(c));
    if (!parsed.ok) return parsed.response;
    if (deps.storage.agentById(parsed.value.agentId) === undefined) {
      return c.json(errorBody("not_found", "no such agent"), 404);
    }
    const thread = {
      id: randomUUID(),
      agentId: parsed.value.agentId,
      title: parsed.value.title ?? "New thread",
      createdAt: deps.now(),
    };
    deps.storage.createThread(thread);
    return c.json({ ...thread, lastMessageAt: null });
  });

  app.patch("/threads/:id", requireDevice, async (c) => {
    const parsed = parseOr400(c, RenameThreadRequestSchema, await readBody(c));
    if (!parsed.ok) return parsed.response;
    if (!deps.storage.renameThread(c.req.param("id"), parsed.value.title)) {
      return c.json(errorBody("not_found", "no such thread"), 404);
    }
    const thread = deps.storage.threadById(c.req.param("id"));
    return thread === undefined
      ? c.json(errorBody("not_found", "no such thread"), 404)
      : c.json(threadToWire(thread));
  });

  app.delete("/threads/:id", requireDevice, (c) => {
    if (!deps.storage.archiveThread(c.req.param("id"))) {
      return c.json(
        errorBody("not_found", "no such thread or already archived"),
        404,
      );
    }
    return c.json({ ok: true });
  });

  app.get("/threads/:id/messages", requireDevice, (c) => {
    const thread = deps.storage.threadById(c.req.param("id"));
    if (thread === undefined)
      return c.json(errorBody("not_found", "no such thread"), 404);
    const beforeRaw = c.req.query("before");
    const limitRaw = c.req.query("limit");
    const before =
      beforeRaw === undefined ? null : Number.parseInt(beforeRaw, 10);
    const limit = Math.min(
      limitRaw === undefined ? 50 : Number.parseInt(limitRaw, 10),
      200,
    );
    if (
      (before !== null && (Number.isNaN(before) || before < 1)) ||
      Number.isNaN(limit) ||
      limit < 1
    ) {
      return c.json(errorBody("invalid_request", "bad before/limit"), 400);
    }
    return c.json({
      messages: deps.storage.messagesBefore(thread.id, before, limit),
    });
  });

  app.post("/threads/:id/messages", requireDevice, async (c) => {
    const thread = deps.storage.threadById(c.req.param("id"));
    if (thread === undefined)
      return c.json(errorBody("not_found", "no such thread"), 404);
    if (thread.archivedAt !== null) {
      return c.json(errorBody("thread_archived", "thread is archived"), 409);
    }
    const parsed = parseOr400(c, SendMessageRequestSchema, await readBody(c));
    if (!parsed.ok) return parsed.response;
    try {
      const message = deps.submitUserMessage(thread.id, parsed.value.blocks);
      return c.json({ message });
    } catch (err) {
      if (err instanceof BackendUnavailable) {
        return c.json(errorBody("backend_unavailable", err.message), 503);
      }
      throw err;
    }
  });

  app.post("/threads/:id/interrupt", requireDevice, (c) => {
    const thread = deps.storage.threadById(c.req.param("id"));
    if (thread === undefined)
      return c.json(errorBody("not_found", "no such thread"), 404);
    const outcome = deps.interruptThread(thread.id);
    if (outcome === "idle") return c.body(null, 204);
    return c.json({ status: "interrupting" }, 202);
  });

  // Approval verbs (contract v1.md section 5a). Two sibling routes rather than one route with a
  // decision in the body: the verb is the whole request, exactly as POST /threads/:id/interrupt
  // takes no body at all, and a notification action button maps to a URL with nothing to encode.
  // Only per-call scope exists on the wire, so there is nothing else for a client to say.
  const approvalRoute =
    (decision: "approve" | "deny") => async (c: Context<Env>) => {
      // Read through a generic Context (this handler is shared by two routes), so the params are
      // typed as possibly absent; the router only reaches here with both present.
      const thread = deps.storage.threadById(c.req.param("id") ?? "");
      if (thread === undefined)
        return c.json(errorBody("not_found", "no such thread"), 404);
      const outcome = await deps.resolveApproval({
        threadId: thread.id,
        toolCallId: c.req.param("toolCallId") ?? "",
        decision,
        deviceId: c.get("deviceId"),
      });
      switch (outcome) {
        case "approved":
        case "denied":
          return c.json({ status: outcome }, 202);
        case "unknown":
          return c.json(
            errorBody("not_found", "no such pending approval"),
            404,
          );
        case "expired":
          return c.json(
            errorBody(
              "approval_expired",
              "the approval expired before it was resolved",
            ),
            409,
          );
        case "not_pending":
          return c.json(
            errorBody(
              "approval_not_pending",
              "the approval is no longer pending",
            ),
            409,
          );
        case "unsupported":
          return c.json(
            errorBody(
              "backend_unavailable",
              "the agent backend cannot resolve approvals",
            ),
            503,
          );
      }
    };

  app.post(
    "/threads/:id/approvals/:toolCallId/approve",
    requireDevice,
    approvalRoute("approve"),
  );
  app.post(
    "/threads/:id/approvals/:toolCallId/deny",
    requireDevice,
    approvalRoute("deny"),
  );

  app.post("/push/register", requireDevice, async (c) => {
    const body = await c.req.text();
    let decoded: unknown;
    try {
      decoded = JSON.parse(body);
    } catch {
      decoded = undefined;
    }

    // The frozen v1 route predates the relay proxy and owns the same path. Its distinct body stays
    // local. A body in the RELAY's register shape is wire data and is forwarded byte for byte.
    // Anything matching neither shape keeps the frozen v1 answer, 400 invalid_request, whether or
    // not a relay is configured: garbage must never leave the gateway, and the conformance suite
    // pins that 400 on gateways with no relay at all.
    let registration;
    try {
      registration = assertValid(PushRegisterRequestSchema, decoded);
    } catch {
      registration = undefined;
    }
    if (registration !== undefined) {
      deps.storage.savePushRegistration(c.get("deviceId"), registration);
      return c.json({ ok: true });
    }
    if (!Value.Check(RelayRegisterRequestSchema, decoded)) {
      return c.json(
        errorBody("invalid_request", "malformed push registration body"),
        400,
      );
    }
    if (deps.config.pushRelayUrl === undefined) {
      return c.json(
        errorBody("not_found", "push relay proxy is not configured"),
        404,
      );
    }
    const upstream = await relayFetch(
      `${deps.config.pushRelayUrl.replace(/\/+$/, "")}/register`,
      {
        method: "POST",
        headers: {
          "content-type": c.req.header("content-type") ?? "application/json",
        },
        body,
      },
    );
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  });

  app.delete("/push/register/:pushId", requireDevice, async (c) => {
    if (deps.config.pushRelayUrl === undefined) {
      return c.json(
        errorBody("not_found", "push relay proxy is not configured"),
        404,
      );
    }
    const pushId = encodeURIComponent(c.req.param("pushId"));
    const upstream = await relayFetch(
      `${deps.config.pushRelayUrl.replace(/\/+$/, "")}/register/${pushId}`,
      { method: "DELETE" },
    );
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  });

  app.post("/push/live-activities/register", requireDevice, async (c) => {
    const decoded = await readBody(c);
    if (!Value.Check(LiveActivityRegisterRequestSchema, decoded)) {
      return c.json(
        errorBody("invalid_request", "malformed Live Activity registration"),
        400,
      );
    }
    if (deps.config.pushRelayUrl === undefined) {
      return c.json(
        errorBody("not_found", "push relay proxy is not configured"),
        404,
      );
    }
    const relayBase = deps.config.pushRelayUrl.replace(/\/+$/, "");
    const upstream = await relayFetch(`${relayBase}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        platform: "apns-liveactivity",
        token: decoded.token,
        environment: decoded.environment,
      }),
    });
    if (!upstream.ok) {
      return new Response(upstream.body, {
        status: upstream.status,
        headers: upstream.headers,
      });
    }
    const result = (await upstream.json()) as { pushId?: unknown };
    if (typeof result.pushId !== "string" || result.pushId.length === 0) {
      return c.json(errorBody("internal", "relay returned no push id"), 502);
    }
    deps.storage.saveLiveActivityRegistration({
      deviceId: c.get("deviceId"),
      activityId: decoded.activityId,
      runId: decoded.runId,
      conversationId: decoded.conversationId,
      bot: decoded.bot,
      pushId: result.pushId,
      createdAt: deps.now(),
    });
    requestLiveActivityDeletionDrain();
    return c.json({ ok: true });
  });

  app.delete("/push/live-activities/:activityId", requireDevice, async (c) => {
    deps.storage.deleteLiveActivityRegistration(
      c.get("deviceId"),
      c.req.param("activityId"),
      { queuedAt: deps.now() },
    );
    requestLiveActivityDeletionDrain();
    return c.body(null, 204);
  });

  // Vendor extension, registered last so it cannot shadow a core route (contract/ext-bots-v1.md).
  if (deps.bots !== undefined) {
    registerBotRoutes(
      app,
      requireDevice,
      deps.bots,
      {
        ...(deps.mediaFetch === undefined
          ? {}
          : { fetchImpl: deps.mediaFetch }),
        ...(deps.mediaLookup === undefined ? {} : { lookup: deps.mediaLookup }),
        ...(deps.mediaLimiter === undefined
          ? {}
          : { limiter: deps.mediaLimiter }),
        ...(deps.mediaQueueWaitMs === undefined
          ? {}
          : { queueWaitMs: deps.mediaQueueWaitMs }),
      },
      {
        ...(deps.photoLimiter === undefined
          ? {}
          : { limiter: deps.photoLimiter }),
        ...(deps.photoQueueWaitMs === undefined
          ? {}
          : { queueWaitMs: deps.photoQueueWaitMs }),
        ...(deps.photoRateLimiter === undefined
          ? {}
          : { rateLimiter: deps.photoRateLimiter }),
        now: deps.now,
      },
      deps.memory,
      {},
      deps.history,
      deps.runRoutine,
    );
  }

  /** The phone has no attach bearer. This is deliberately the same bounded attach_media store and
   * validation pipeline, but its authorization is the one live device/lease claim, never a spool. */
  app.post("/mobile-node/media/:requestId", requireDevice, async (c) => {
    const requestId = c.req.param("requestId");
    const lease = c.req.header("x-mobile-node-lease") ?? "";
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(requestId) || !/^[A-Za-z0-9_-]{43}$/.test(lease))
      return c.json(errorBody("invalid_request", "invalid mobile media request"), 400);
    const claim = deps.beginMobileMediaUpload?.(c.get("deviceId"), requestId, lease);
    if (claim === undefined)
      return c.json(errorBody("not_found", "mobile media request is not available"), 404);
    const fail = (status: 400 | 413 | 415 | 422, body: ErrorBody, reason: "media_validation_failed" | "media_storage_failed" = "media_validation_failed") => {
      claim.complete(undefined, reason);
      return c.json(body, status);
    };
    const receivedType = c.req.header("content-type") ?? "";
    const mimeType = receivedType.split(";")[0]!.trim().toLowerCase();
    const acceptedType = ASSISTANT_MEDIA_TYPES.get(mimeType);
    if (acceptedType === undefined)
      return fail(415, errorBody("invalid_request", "media type is not on the gateway allowlist"));
    const declared = Number(c.req.header("content-length") ?? "");
    if (Number.isFinite(declared) && declared > acceptedType.maxBytes)
      return fail(413, errorBody("invalid_request", "media is over the byte cap"));
    let bytes: Uint8Array;
    try {
      bytes = await readCappedBody(c.req.raw.body, acceptedType.maxBytes);
      acceptAssistantMediaBytes(mimeType, bytes, sniffImageType);
    } catch {
      return fail(415, errorBody("invalid_request", "media bytes did not match the declared type"));
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const filename = safeFilename(c.req.header("x-attach-filename") ?? "");
    if (filename === undefined)
      return fail(400, errorBody("invalid_request", "invalid attach media filename"));
    const descriptor: AttachV1MediaDescriptor = {
      mediaId: randomUUID().replaceAll("-", ""), mimeType, byteCount: bytes.byteLength, sha256, filename, family: acceptedType.kind,
      expiresAt: deps.now() + ATTACH_MEDIA_TTL_MS,
    };
    try {
      deps.storage.saveAttachMedia(claim.agentId, descriptor, bytes, deps.now());
    } catch {
      return fail(400, errorBody("invalid_request", "could not store mobile media"), "media_storage_failed");
    }
    const mobileDescriptor: MobileNodeMediaDescriptor = {
      mediaId: descriptor.mediaId,
      mimeType: descriptor.mimeType,
      byteCount: descriptor.byteCount,
      sha256: descriptor.sha256,
      filename: descriptor.filename,
      family: descriptor.family,
    };
    if (!claim.complete(mobileDescriptor)) {
      deps.storage.deleteUnreferencedAttachMedia(claim.agentId, descriptor.mediaId);
      return c.json(errorBody("invalid_request", "mobile media request expired or changed"), 409);
    }
    return c.json({ media: descriptor }, 201);
  });

  if (deps.attachTokens !== undefined && deps.attachTokens.size > 0) {
    app.get("/attach/v1/deliveries/:deliveryId", requireAttach, (c) => {
      const deliveryId = c.req.param("deliveryId");
      if (deliveryId.length === 0 || deliveryId.length > 256)
        return c.json(errorBody("invalid_request", "invalid delivery id"), 400);
      const receipt = deps.storage.attachScheduledDeliveryReceipt(
        attachAgent(c),
        deliveryId,
      );
      return receipt === undefined
        ? c.json(errorBody("not_found", "no such attach delivery"), 404)
        : c.json(receipt);
    });

    app.post("/attach/v1/media/:mediaId", requireAttachMedia, async (c) => {
      const mediaId = c.req.param("mediaId");
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(mediaId)) {
        return c.json(
          errorBody("invalid_request", "invalid attach media id"),
          400,
        );
      }
      const receivedType = c.req.header("content-type") ?? "";
      const received = sanitizedContentType(receivedType);
      const mimeType = receivedType.split(";")[0]!.trim().toLowerCase();
      // The allowlist is documented MIME by MIME in contract/ext-bots-v1.md; the plugin policy
      // table mirrors that document, and this map is the runtime copy of it.
      const acceptedType = ASSISTANT_MEDIA_TYPES.get(mimeType);
      if (acceptedType === undefined)
        return c.json(
          {
            ...errorBody("invalid_request", `media type ${received} is not on the gateway allowlist`),
            reason: "content_type",
            receivedContentType: received,
          },
          415,
        );
      /** 413 names the cap for the DECLARED type, not the largest cap in the table, so a producer
       *  can act on the number instead of guessing which limit it hit. */
      const overCap = () =>
        c.json(
          {
            ...errorBody(
              "invalid_request",
              `media is over the ${acceptedType.maxBytes} byte cap for ${mimeType}`,
            ),
            reason: "too_large",
            limitBytes: acceptedType.maxBytes,
          },
          413,
        );
      const declared = Number(c.req.header("content-length") ?? "");
      if (Number.isFinite(declared) && declared > acceptedType.maxBytes) return overCap();
      let bytes: Uint8Array;
      try {
        bytes = await readCappedBody(c.req.raw.body, acceptedType.maxBytes);
        acceptAssistantMediaBytes(mimeType, bytes, sniffImageType);
      } catch (err) {
        // Every branch answers with gateway-authored prose. No error string from a layer that
        // touched the payload reaches the body, so no uploaded byte can be reflected.
        const reason = err instanceof PhotoRefused ? err.reason : "content_type";
        if (reason === "too_large") return overCap();
        if (reason === "empty")
          return c.json({ ...errorBody("invalid_request", "media carried no bytes"), reason }, 400);
        return c.json(
          {
            ...errorBody("invalid_request", `media bytes did not match the declared type ${mimeType}`),
            reason,
            receivedContentType: received,
          },
          415,
        );
      }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const claimedHash = (c.req.header("x-attach-sha256") ?? "").toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(claimedHash) || claimedHash !== sha256) {
        return c.json(
          {
            ...errorBody("invalid_request", "media sha256 mismatch"),
            reason: "digest",
          },
          422,
        );
      }
      const filename = safeFilename(c.req.header("x-attach-filename") ?? "");
      if (filename === undefined) {
        return c.json(
          errorBody("invalid_request", "invalid attach media filename"),
          400,
        );
      }
      const expiresRaw = c.req.header("x-attach-expires-at");
      const expiresAt =
        expiresRaw === undefined ? undefined : Number(expiresRaw);
      if (
        expiresAt !== undefined &&
        (!Number.isSafeInteger(expiresAt) || expiresAt <= deps.now())
      ) {
        return c.json(
          errorBody("invalid_request", "invalid attach media expiry"),
          400,
        );
      }
      const descriptor: AttachV1MediaDescriptor = {
        mediaId,
        mimeType,
        byteCount: bytes.byteLength,
        sha256,
        filename,
        family: acceptedType.kind,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      };
      try {
        const created = deps.storage.saveAttachMedia(
          attachAgent(c),
          descriptor,
          bytes,
          deps.now(),
        );
        return c.json({ media: descriptor }, created ? 201 : 200);
      } catch {
        return c.json(
          errorBody("invalid_request", "attach media id already exists"),
          409,
        );
      }
    });

    /** Atomic producer rollback. An absent id is success so a retry after a crash between local
     * spool cleanup and this request stays convergent; a referenced id is never removed. */
    app.delete("/attach/v1/media/:mediaId", requireAttachMedia, (c) => {
      const mediaId = c.req.param("mediaId");
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(mediaId))
        return c.json(
          errorBody("invalid_request", "invalid attach media id"),
          400,
        );
      const result = deps.storage.deleteUnreferencedAttachMedia(
        attachAgent(c),
        mediaId,
      );
      if (result === "referenced")
        return c.json(
          errorBody("invalid_request", "attach media is already referenced"),
          409,
        );
      return c.body(null, 204);
    });

    app.get("/attach/v1/media/:mediaId", requireAttachMedia, (c) => {
      const mediaId = c.req.param("mediaId");
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(mediaId))
        return c.json(
          errorBody("invalid_request", "invalid attach media id"),
          400,
        );
      const agentId = attachAgent(c);
      const info = deps.storage.attachMediaInfo(agentId, mediaId, deps.now());
      if (info === undefined)
        return c.json(errorBody("not_found", "no such attach media"), 404);
      const range = resolveByteRange(c.req.header("range"), info.size);
      if (range === null)
        return new Response(null, {
          status: 416,
          headers: {
            "content-range": `bytes */${info.size}`,
            "accept-ranges": "bytes",
          },
        });
      const start = range?.start ?? 0;
      const end = range?.end ?? info.size - 1;
      const bytes = deps.storage.attachMediaSlice(
        agentId,
        mediaId,
        start,
        end - start + 1,
        deps.now(),
      );
      if (bytes === undefined)
        return c.json(errorBody("not_found", "no such attach media"), 404);
      return new Response(bytes.slice().buffer as ArrayBuffer, {
        status: range === undefined ? 200 : 206,
        headers: {
          "content-type": info.mime,
          "content-length": String(bytes.byteLength),
          "accept-ranges": "bytes",
          "cache-control": "private, max-age=86400",
          "x-content-type-options": "nosniff",
          "content-disposition": attachmentDisposition(info.descriptor.filename),
          ...(range === undefined
            ? {}
            : { "content-range": `bytes ${start}-${end}/${info.size}` }),
        },
      });
    });
  }

  app.notFound((c) => c.json(errorBody("not_found", "no such route"), 404));
  app.onError((err, c) =>
    c.json(errorBody("internal", "unexpected gateway fault"), 500),
  );

  return app;
}
