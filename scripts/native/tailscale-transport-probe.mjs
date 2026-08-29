#!/usr/bin/env node

import { randomBytes, createHash, X509Certificate } from "node:crypto";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";

function fail(message) {
  throw new Error(message);
}

function option(argv, name, fallback) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) fail(`missing value for ${name}`);
  return value;
}

function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    fail(`${name} must be an integer from 1 through ${maximum}`);
  }
  return parsed;
}

function websocketAccept(key) {
  return createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function websocketFrame(payload) {
  const body = Buffer.from(payload);
  if (body.length > 125) fail("probe WebSocket payload is too large");
  return Buffer.concat([Buffer.from([0x81, body.length]), body]);
}

function decodeClientFrame(buffer) {
  if (buffer.length < 6) return undefined;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  const length = buffer[1] & 0x7f;
  if (opcode !== 1 || !masked || length > 125 || buffer.length < 6 + length) {
    fail("invalid probe WebSocket frame");
  }
  const mask = buffer.subarray(2, 6);
  const payload = Buffer.from(buffer.subarray(6, 6 + length));
  for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  return { payload: payload.toString("utf8"), consumed: 6 + length };
}

async function serve(argv) {
  const port = positiveInteger(option(argv, "--port"), "--port", 65535);
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end('{"ok":true,"probe":"cozygateway-tailscale-transport"}\n');
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found\n");
  });

  server.on("upgrade", (request, socket) => {
    try {
      const key = request.headers["sec-websocket-key"];
      if (
        request.url !== "/ws" ||
        request.headers.upgrade?.toLowerCase() !== "websocket" ||
        typeof key !== "string"
      ) {
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        return;
      }
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${websocketAccept(key)}\r\n\r\n`,
      );
      let pending = Buffer.alloc(0);
      socket.on("data", (buffer) => {
        try {
          pending = Buffer.concat([pending, buffer]);
          const frame = decodeClientFrame(pending);
          if (frame !== undefined) {
            pending = pending.subarray(frame.consumed);
            socket.write(websocketFrame(frame.payload));
          }
        } catch {
          socket.destroy();
        }
      });
    } catch {
      socket.destroy();
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  process.stdout.write(`${JSON.stringify({ ready: true, host: "127.0.0.1", port })}\n`);

  const close = () => server.close(() => process.exit(0));
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

function withTimeout(timeoutMs, label, operation) {
  return new Promise((resolve, reject) => {
    let cancel = () => {};
    const timer = setTimeout(() => {
      cancel();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    cancel =
      operation(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      ) ?? cancel;
  });
}

async function inspectTls(origin, expectedHost, connectHost, timeoutMs) {
  return withTimeout(timeoutMs, "TLS probe", (resolve, reject) => {
    const socket = tlsConnect({
      host: connectHost,
      port: Number(origin.port || 443),
      servername: expectedHost,
      rejectUnauthorized: true,
      ALPNProtocols: ["h2", "http/1.1"],
    });
    socket.once("secureConnect", () => {
      try {
        if (!socket.authorized) fail(`TLS certificate is not trusted: ${socket.authorizationError}`);
        const certificate = socket.getPeerCertificate();
        if (certificate === undefined || certificate.raw === undefined) {
          fail("TLS certificate has no subjectAltName");
        }
        const x509 = new X509Certificate(certificate.raw);
        const exactDnsSan = x509.checkHost(expectedHost, {
          subject: "never",
          wildcards: false,
          partialWildcards: false,
          multiLabelWildcards: false,
          singleLabelSubdomains: false,
        });
        if (exactDnsSan !== expectedHost) {
          fail(`TLS certificate does not contain an exact DNS SAN for ${expectedHost}`);
        }
        const alpn = socket.alpnProtocol || false;
        if (alpn === "h2") fail("TLS-terminated TCP unexpectedly negotiated h2");
        if (alpn !== false && alpn !== "http/1.1") fail(`unexpected ALPN protocol: ${alpn}`);
        socket.end();
        resolve({ authorized: true, san: x509.subjectAltName, alpn });
      } catch (error) {
        socket.destroy();
        reject(error);
      }
    });
    socket.once("error", reject);
    return () => socket.destroy();
  });
}

async function checkHealth(origin, expectedHost, connectHost, timeoutMs) {
  return withTimeout(timeoutMs, "HTTPS health probe", (resolve, reject) => {
    const request = httpsRequest(
      {
        host: connectHost,
        port: Number(origin.port || 443),
        servername: expectedHost,
        path: "/health",
        method: "GET",
        headers: { accept: "application/json", host: origin.host },
        rejectUnauthorized: true,
      },
      (response) => {
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 64 * 1024) {
            request.destroy(new Error("HTTPS health response exceeded 64 KiB"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(new Error(`HTTPS health returned ${response.statusCode}`));
            return;
          }
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
      },
    );
    request.once("error", reject);
    request.end();
    return () => request.destroy();
  });
}

function maskedClientFrame(payload) {
  const body = Buffer.from(payload);
  if (body.length > 125) fail("probe WebSocket payload is too large");
  const mask = randomBytes(4);
  const masked = Buffer.from(body);
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4];
  return Buffer.concat([Buffer.from([0x81, 0x80 | body.length]), mask, masked]);
}

function decodeServerFrame(buffer) {
  if (buffer.length < 2) return undefined;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  const length = buffer[1] & 0x7f;
  if (masked || length > 125 || buffer.length < 2 + length) return undefined;
  if (opcode === 8) fail("WSS peer closed before the probe completed");
  if (opcode !== 1) fail(`unexpected WSS frame opcode ${opcode}`);
  return { payload: buffer.subarray(2, 2 + length).toString("utf8"), consumed: 2 + length };
}

function headerValue(lines, name) {
  const prefix = `${name.toLowerCase()}:`;
  const line = lines.find((candidate) => candidate.toLowerCase().startsWith(prefix));
  return line?.slice(line.indexOf(":") + 1).trim();
}

function roundTripWebSocket(origin, expectedHost, connectHost, timeoutMs, soakSeconds) {
  return withTimeout(timeoutMs + soakSeconds * 1000, "WSS probe", (resolve, reject) => {
    const socket = tlsConnect({
      host: connectHost,
      port: Number(origin.port || 443),
      servername: expectedHost,
      rejectUnauthorized: true,
      ALPNProtocols: ["http/1.1"],
    });
    let timer;
    let sent = 0;
    let received = 0;
    let expected;
    let soakUntil;
    let handshakeComplete = false;
    let complete = false;
    let pending = Buffer.alloc(0);
    const handshakeKey = randomBytes(16).toString("base64");
    const expectedAccept = websocketAccept(handshakeKey);
    const finish = () => {
      clearTimeout(timer);
      complete = true;
      socket.end();
      resolve({ sent, received, soakSeconds });
    };
    const send = () => {
      expected = randomBytes(18).toString("base64url");
      sent += 1;
      socket.write(maskedClientFrame(expected));
    };
    socket.once("secureConnect", () => {
      soakUntil = Date.now() + soakSeconds * 1000;
      socket.write(
        `GET /ws HTTP/1.1\r\n` +
          `Host: ${origin.host}\r\n` +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Key: ${handshakeKey}\r\n` +
          "Sec-WebSocket-Version: 13\r\n\r\n",
      );
    });
    socket.on("data", (chunk) => {
      try {
        pending = Buffer.concat([pending, chunk]);
        if (!handshakeComplete) {
          const headerEnd = pending.indexOf("\r\n\r\n");
          if (headerEnd === -1) {
            if (pending.length > 16 * 1024) fail("WSS handshake headers exceeded 16 KiB");
            return;
          }
          const lines = pending.subarray(0, headerEnd).toString("latin1").split("\r\n");
          if (lines[0] !== "HTTP/1.1 101 Switching Protocols") fail(`WSS handshake failed: ${lines[0]}`);
          if (headerValue(lines, "upgrade")?.toLowerCase() !== "websocket") fail("WSS handshake omitted Upgrade: websocket");
          if (headerValue(lines, "sec-websocket-accept") !== expectedAccept) fail("WSS handshake accept value is invalid");
          pending = pending.subarray(headerEnd + 4);
          handshakeComplete = true;
          send();
        }
        const frame = decodeServerFrame(pending);
        if (frame === undefined) return;
        pending = pending.subarray(frame.consumed);
        if (frame.payload !== expected) fail("WSS echo payload mismatch");
        received += 1;
        if (soakSeconds === 0 || Date.now() >= soakUntil) finish();
        else timer = setTimeout(send, Math.min(1000, Math.max(1, soakUntil - Date.now())));
      } catch (error) {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      if (!complete) reject(new Error(`WSS connection failed: ${error.message}`));
    });
    socket.on("close", () => {
      if (!complete) reject(new Error("WSS closed early"));
    });
    return () => {
      clearTimeout(timer);
      socket.destroy();
    };
  });
}

async function verify(argv) {
  const rawOrigin = option(argv, "--origin");
  const expectedHost = option(argv, "--expected-host");
  const timeoutMs = positiveInteger(option(argv, "--timeout-ms", "5000"), "--timeout-ms", 60_000);
  const soakSeconds = positiveInteger(option(argv, "--soak-seconds", "10"), "--soak-seconds", 3600);
  const origin = new URL(rawOrigin);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    fail("--origin must be a credential-free HTTPS origin");
  }
  if (origin.hostname !== expectedHost) fail("--expected-host must exactly match the origin hostname");
  const connectHost = option(argv, "--connect-host", origin.hostname);

  const tls = await inspectTls(origin, expectedHost, connectHost, timeoutMs);
  await checkHealth(origin, expectedHost, connectHost, timeoutMs);
  const wss = await roundTripWebSocket(origin, expectedHost, connectHost, timeoutMs, soakSeconds);
  process.stdout.write(`${JSON.stringify({ ok: true, tls, health: true, wss })}\n`);
}

const [command, ...argv] = process.argv.slice(2);
try {
  if (command === "serve") await serve(argv);
  else if (command === "verify") await verify(argv);
  else fail("usage: tailscale-transport-probe.mjs <serve|verify> [options]");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
