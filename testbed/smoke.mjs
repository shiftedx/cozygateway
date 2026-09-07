// TB1 burner smoke: watch the device live stream while driving one bot or one room.
// usage: node smoke.mjs dm <bot> "<text>"      |  node smoke.mjs room <roomName> "<text>"
import { WebSocket } from "ws";

const GW = process.env.TB1_GATEWAY ?? "http://192.168.99.120:8795";
const TOKEN = process.env.TB1_DEVICE_TOKEN;
if (!TOKEN) { console.error("set TB1_DEVICE_TOKEN"); process.exit(2); }
const [mode, target, text] = process.argv.slice(2);
const WAIT_MS = Number(process.env.TB1_WAIT_MS ?? 180000);

const deltas = new Map();      // turnId -> count of draft frames
const commits = [];            // committed assistant rows
const ws = new WebSocket(GW.replace(/^http/, "ws") + "/ws");

const done = (code) => { try { ws.close(); } catch {} 
  console.log(JSON.stringify({ mode, target,
    deltaFrames: Object.fromEntries(deltas),
    streamed: [...deltas.values()].some((n) => n > 0),
    commits }, null, 2));
  process.exit(code); };

ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token: TOKEN })));
ws.on("message", async (raw) => {
  let f; try { f = JSON.parse(String(raw)); } catch { return; }
  if (f.type === "ready") { await drive(); return; }
  if (f.type === "bot_chat_delta") deltas.set(f.turnId, (deltas.get(f.turnId) ?? 0) + 1);
  if (f.type === "bot_chat")
    for (const m of f.messages ?? [])
      if (m.role === "assistant")
        commits.push({ bot: f.bot ?? f.name, room: f.room ?? m.room, text: String(m.text ?? "").slice(0, 160) });
  if (f.type === "bot_chat_state" && f.state === "idle" && commits.length) setTimeout(() => done(0), 1500);
});
ws.on("error", (e) => { console.error("ws error", e.message); process.exit(1); });

async function post(path, body) {
  const r = await fetch(GW + path, { method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body) });
  const t = await r.text();
  console.error(`POST ${path} -> ${r.status} ${t.slice(0, 200)}`);
  return r;
}
async function drive() {
  if (mode === "dm") await post(`/bots/${target}/chat/messages`, { text });
  else if (mode === "room") await post(`/bots/groups/${target}/messages`, { text });
  else { console.error("mode must be dm or room"); process.exit(2); }
}
setTimeout(() => done(commits.length ? 0 : 1), WAIT_MS);
