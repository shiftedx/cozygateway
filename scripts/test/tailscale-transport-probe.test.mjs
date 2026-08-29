import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT: ${message}`);
}

function opensslExecutable() {
  const explicit = process.env.OPENSSL_BIN?.trim();
  if (explicit) return explicit;
  if (process.platform === "win32") {
    const candidate = join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "usr", "bin", "openssl.exe");
    if (existsSync(candidate)) return candidate;
  }
  return "openssl";
}

function generateCertificate(directory, name, san, commonName = san) {
  const key = join(directory, `${name}.key.pem`);
  const cert = join(directory, `${name}.cert.pem`);
  const args = [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      `/CN=${commonName}`,
    ];
  if (san !== undefined) args.push("-addext", `subjectAltName=DNS:${san}`);
  execFileSync(opensslExecutable(), args, { stdio: "pipe" });
  return { key: readFileSync(key), cert: readFileSync(cert), certPath: cert };
}

function websocketAccept(key) {
  return createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function decodeClientPayload(frame) {
  const length = frame[1] & 0x7f;
  const mask = frame.subarray(2, 6);
  const body = Buffer.from(frame.subarray(6, 6 + length));
  for (let index = 0; index < body.length; index += 1) body[index] ^= mask[index % 4];
  return body;
}

function serverFrame(payload) {
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

async function startFixture(certificate, options = {}) {
  const server = createServer(
    {
      key: certificate.key,
      cert: certificate.cert,
      ALPNProtocols: options.alpnProtocols ?? ["http/1.1"],
    },
    (request, response) => {
      if (request.url !== "/health") {
        response.writeHead(404).end();
        return;
      }
      const body = options.healthBody ?? '{"ok":true}';
      response.writeHead(200, { "content-type": "application/json" });
      response.end(body);
    },
  );
  server.on("upgrade", (request, socket) => {
    if (options.websocket === "reject") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    const key = request.headers["sec-websocket-key"];
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        `Connection: ${options.websocketConnection ?? "Upgrade"}\r\n` +
        `Sec-WebSocket-Accept: ${websocketAccept(key)}\r\n\r\n`,
    );
    if (options.websocket === "early-close") {
      setTimeout(() => socket.destroy(), 10);
      return;
    }
    socket.on("data", (frame) => socket.write(serverFrame(decodeClientPayload(frame))));
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  return server;
}

async function closeServer(server) {
  await new Promise((resolveClose) => server.close(resolveClose));
}

async function withFixture(certificate, options, callback) {
  const server = await startFixture(certificate, options);
  try {
    const address = server.address();
    assert(address && typeof address === "object", "TLS fixture must listen");
    return await callback(address.port);
  } finally {
    await closeServer(server);
  }
}

function runProbe(probe, port, expectedHost, certificatePath) {
  return new Promise((resolveRun) => {
    const env = { ...process.env };
    if (certificatePath === undefined) delete env.NODE_EXTRA_CA_CERTS;
    else env.NODE_EXTRA_CA_CERTS = certificatePath;
    const child = spawn(
      process.execPath,
      [
        probe,
        "verify",
        "--origin",
        `https://${expectedHost}:${port}`,
        "--expected-host",
        expectedHost,
        "--connect-host",
        "127.0.0.1",
        "--timeout-ms",
        "1000",
        "--soak-seconds",
        "1",
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

const repoRoot = resolve(import.meta.dirname, "..", "..");
const probe = join(repoRoot, "scripts", "native", "tailscale-transport-probe.mjs");
const directory = mkdtempSync(join(tmpdir(), "cozygateway-transport-tls-"));

try {
  const exact = generateCertificate(directory, "exact", "probe.transport.test");
  await withFixture(exact, {}, async (port) => {
    const result = await runProbe(probe, port, "probe.transport.test", exact.certPath);
    assert(result.code === 0, `exact DNS SAN must pass: ${result.stderr}`);
    assert(result.stdout.includes('"ok":true'), "exact DNS SAN must emit successful verification JSON");
  });

  const wildcard = generateCertificate(directory, "wildcard", "*.transport.test");
  await withFixture(wildcard, {}, async (port) => {
    const result = await runProbe(probe, port, "probe.transport.test", wildcard.certPath);
    assert(result.code !== 0, "wildcard-only DNS SAN must fail exact-host verification");
    assert(/exact DNS SAN/i.test(result.stderr), `wildcard failure must identify exact SAN: ${result.stderr}`);
  });

  const commonNameOnly = generateCertificate(directory, "common-name-only", undefined, "probe.transport.test");
  await withFixture(commonNameOnly, {}, async (port) => {
    const result = await runProbe(probe, port, "probe.transport.test", commonNameOnly.certPath);
    assert(result.code !== 0, "matching common name without a DNS SAN must fail exact-SAN verification");
    assert(/exact DNS SAN/i.test(result.stderr), `common-name-only failure must identify exact SAN: ${result.stderr}`);
  });

  const mismatched = generateCertificate(directory, "mismatched", "other.transport.test");
  await withFixture(mismatched, {}, async (port) => {
    const result = await runProbe(probe, port, "probe.transport.test", mismatched.certPath);
    assert(result.code !== 0, "mismatched DNS SAN must fail hostname verification");
  });

  await withFixture(exact, {}, async (port) => {
    const result = await runProbe(probe, port, "probe.transport.test", undefined);
    assert(result.code !== 0, "untrusted exact-SAN certificate must fail normal trust verification");
  });

  await withFixture(exact, { alpnProtocols: ["h2", "http/1.1"] }, async (port) => {
    const result = await runProbe(probe, port, "probe.transport.test", exact.certPath);
    assert(result.code !== 0, "h2 negotiation must fail the transport gate");
    assert(/h2/i.test(result.stderr), `h2 failure must identify negotiated h2: ${result.stderr}`);
  });

  await withFixture(exact, { healthBody: "x".repeat(64 * 1024 + 1) }, async (port) => {
    const result = await runProbe(probe, port, "probe.transport.test", exact.certPath);
    assert(result.code !== 0, "oversized health response must fail the bounded probe");
    assert(/64 KiB/i.test(result.stderr), `oversized health failure must identify the bound: ${result.stderr}`);
  });

  await withFixture(exact, { websocket: "reject" }, async (port) => {
    const result = await runProbe(probe, port, "probe.transport.test", exact.certPath);
    assert(result.code !== 0, "failed WSS handshake must fail verification");
    assert(/WSS handshake failed/i.test(result.stderr), `failed WSS must be actionable: ${result.stderr}`);
  });

  await withFixture(exact, { websocketConnection: "keep-alive" }, async (port) => {
    const result = await runProbe(probe, port, "probe.transport.test", exact.certPath);
    assert(result.code !== 0, "101 response without an Upgrade connection token must fail verification");
    assert(/Connection.*Upgrade/i.test(result.stderr), `missing connection token must be actionable: ${result.stderr}`);
  });

  await withFixture(exact, { websocketConnection: "keep-alive, UpGrAdE" }, async (port) => {
    const result = await runProbe(probe, port, "probe.transport.test", exact.certPath);
    assert(result.code === 0, `comma-separated case-insensitive Upgrade token must pass: ${result.stderr}`);
  });

  await withFixture(exact, { websocket: "early-close" }, async (port) => {
    const result = await runProbe(probe, port, "probe.transport.test", exact.certPath);
    assert(result.code !== 0, "early-close WSS must fail verification");
    assert(/WSS closed early/i.test(result.stderr), `early-close WSS must be actionable: ${result.stderr}`);
  });

  process.stdout.write("Tailscale transport TLS behavior tests passed\n");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
