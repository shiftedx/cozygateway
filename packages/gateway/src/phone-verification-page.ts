import { createHash } from "node:crypto";

export interface PhoneProofDeps {
  health(): Promise<void>;
  openProbe(): Promise<void>;
  confirm(): Promise<{ phrase: string }>;
  showPhrase(phrase: string): void;
}

/** The browser proof is deliberately linear. In particular, confirm is reached once and only
 * after both network legs have completed. Server-side state makes a reload/replay inert. */
export async function runPhoneProof(deps: PhoneProofDeps): Promise<"confirmed" | "failed"> {
  try {
    await deps.health();
    await deps.openProbe();
    const { phrase } = await deps.confirm();
    deps.showPhrase(phrase);
    return "confirmed";
  } catch {
    return "failed";
  }
}

const SCRIPT = String.raw`(() => {
  const proofPath = location.pathname;
  history.replaceState(null, "", "/");
  const status = document.getElementById("status");
  const phrase = document.getElementById("phrase");
  const health = async () => {
    const response = await fetch("/health", { cache: "no-store", credentials: "omit" });
    if (!response.ok) throw new Error("health");
  };
  const openProbe = () => new Promise((resolve, reject) => {
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(scheme + "//" + location.host + proofPath + "/probe");
    const challenge = '{"type":"cozy_onboarding_probe"}';
    const fail = () => { try { socket.close(); } catch {} reject(new Error("probe")); };
    const timer = setTimeout(fail, 5000);
    socket.addEventListener("open", () => socket.send(challenge), { once: true });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string" || new TextEncoder().encode(event.data).length > 256) return fail();
      if (event.data !== challenge) return fail();
      clearTimeout(timer); socket.close(); resolve();
    });
    socket.addEventListener("error", fail, { once: true });
  });
  const confirm = async () => {
    const response = await fetch(proofPath + "/confirm", {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: '{"type":"confirm"}'
    });
    if (!response.ok) throw new Error("confirm");
    const body = await response.json();
    if (typeof body.phrase !== "string") throw new Error("phrase");
    return body;
  };
  const showPhrase = (value) => {
    phrase.textContent = value; phrase.hidden = false;
    status.textContent = "Return to your PC and confirm this phrase.";
  };
  (async () => {
    try { await health(); await openProbe(); showPhrase((await confirm()).phrase); }
    catch { status.textContent = "Phone connection check failed. Return to your PC to try again."; }
  })();
})();`;

const SCRIPT_HASH = createHash("sha256").update(SCRIPT).digest("base64");
const STYLE = "body{font:18px system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;color:#252525}#phrase{font-size:2rem;font-weight:700;letter-spacing:.04em}";
const STYLE_HASH = createHash("sha256").update(STYLE).digest("base64");

export const PHONE_VERIFICATION_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy": `default-src 'none'; script-src 'sha256-${SCRIPT_HASH}'; connect-src 'self'; style-src 'sha256-${STYLE_HASH}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
});

export const PHONE_VERIFICATION_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CozyGateway phone connection check</title><style>${STYLE}</style></head>
<body><main><h1>Phone connection check</h1><p id="status">Checking this connection…</p><p id="phrase" hidden></p></main><script>${SCRIPT}</script></body></html>`;
