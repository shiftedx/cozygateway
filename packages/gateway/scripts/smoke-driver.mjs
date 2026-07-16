import { WebSocket } from "ws";

const baseUrl = process.env.SMOKE_GATEWAY_URL ?? "http://127.0.0.1:8787";
const setupCode = process.env.SMOKE_SETUP_CODE;
if (!setupCode) {
  console.error("SMOKE_SETUP_CODE is required");
  process.exit(1);
}

const deadline = Date.now() + 15000;
const until = async (predicate, label) => {
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

async function main() {
  const pairRes = await fetch(`${baseUrl}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCode, deviceName: "smoke" }),
  });
  if (pairRes.status !== 200) throw new Error(`pair failed: HTTP ${pairRes.status}`);
  const { deviceToken } = await pairRes.json();
  const authed = { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" };

  const threadRes = await fetch(`${baseUrl}/threads`, {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ agentId: "echo" }),
  });
  if (threadRes.status !== 200) throw new Error(`create thread failed: HTTP ${threadRes.status}`);
  const { id: threadId } = await threadRes.json();

  const frames = [];
  const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/ws`);
  ws.on("message", (d) => frames.push(JSON.parse(String(d))));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ type: "auth", token: deviceToken }));
  await until(() => frames.some((f) => f.type === "ready"), "ready");

  const sendRes = await fetch(`${baseUrl}/threads/${threadId}/messages`, {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ blocks: [{ type: "paragraph", text: "hello" }] }),
  });
  if (sendRes.status !== 200) throw new Error(`send failed: HTTP ${sendRes.status}`);

  await until(() => frames.some((f) => f.type === "done"), "done");
  const draft = frames.find((f) => f.type === "draft");
  if (!draft) throw new Error("no draft frame observed");
  const agentCommit = frames.find((f) => f.type === "committed" && f.message.role === "agent");
  const text = agentCommit?.message?.blocks?.[0]?.text;
  if (text !== "Echo: hello") throw new Error(`unexpected agent reply: ${JSON.stringify(agentCommit)}`);

  ws.close();
  console.log("SMOKE OK: draft observed, agent committed 'Echo: hello'");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`SMOKE FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
