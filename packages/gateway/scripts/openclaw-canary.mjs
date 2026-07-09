// OpenClaw backend live canary (non-gating; NOT part of `pnpm check`).
//
// When OPENCLAW_CANARY_URL and the operator-token env are set, this dials a REAL OpenClaw gateway
// with the adapter's OWN client, completes the device-auth handshake, creates a session, sends a
// chat, and asserts a non-empty streamed reply. Prints PASS/FAIL and exits non-zero on failure.
// When the env is unset it SKIPs (exit 0), so it is safe to wire into a schedule or run manually.
//
//   OPENCLAW_CANARY_URL=wss://host:port \
//   OPENCLAW_CANARY_TOKEN_ENV=OPENCLAW_TOKEN OPENCLAW_TOKEN=... \
//   node packages/gateway/scripts/openclaw-canary.mjs
//
// Optional: OPENCLAW_CANARY_AGENT_ID (scope the session to one agent),
//           OPENCLAW_CANARY_TIMEOUT_MS (reply budget, default 120000).
import { randomUUID } from "node:crypto";

import { createOpenClawClient } from "../src/adapters/openclaw/client.ts";
import { generateDeviceIdentity } from "../src/adapters/openclaw/device-auth.ts";

const url = process.env.OPENCLAW_CANARY_URL;
const tokenEnv = process.env.OPENCLAW_CANARY_TOKEN_ENV ?? "OPENCLAW_TOKEN";
const token = process.env[tokenEnv];

if (!url || !token) {
  console.log(`SKIP: set OPENCLAW_CANARY_URL and ${tokenEnv} to run the OpenClaw live canary.`);
  process.exit(0);
}

const agentId = process.env.OPENCLAW_CANARY_AGENT_ID;
const replyTimeoutMs = Number(process.env.OPENCLAW_CANARY_TIMEOUT_MS ?? 120000);

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  fail(`timed out waiting for ${label} after ${timeoutMs}ms`);
}

const client = createOpenClawClient({ url, token, identity: generateDeviceIdentity() });
client.start();

try {
  await waitFor(() => client.state() === "online", 20000, "device-auth handshake (online)");
  console.log("OK: authenticated (hello-ok), client online.");

  const created = await client.request("sessions.create", agentId ? { agentId } : {});
  const sessionKey = created?.key ?? created?.sessionKey;
  if (typeof sessionKey !== "string" || sessionKey.length === 0) {
    fail(`sessions.create returned no session key: ${JSON.stringify(created)}`);
  }
  console.log(`OK: sessions.create -> ${sessionKey}`);

  let text = "";
  let done = false;
  let errored;
  client.subscribeSession(sessionKey, {
    onDelta: (snapshot) => {
      text = snapshot;
    },
    onDone: () => {
      done = true;
    },
    onError: (message) => {
      errored = message;
    },
    onToolCalls: () => {},
  });

  await client.request("chat.send", {
    sessionKey,
    message: "Reply with exactly the word PONG and nothing else.",
    idempotencyKey: randomUUID(),
  });
  console.log("OK: chat.send accepted; awaiting streamed reply...");

  await waitFor(() => done || errored !== undefined, replyTimeoutMs, "streamed reply to end");
  if (errored !== undefined) fail(`session errored before the reply ended: ${errored}`);
  if (text.trim().length === 0) fail("the streamed reply was empty");

  console.log(`PASS: non-empty streamed reply (${text.length} chars): ${JSON.stringify(text.slice(0, 200))}`);
  await client.close();
  process.exit(0);
} catch (err) {
  fail(err?.message ?? String(err));
}
