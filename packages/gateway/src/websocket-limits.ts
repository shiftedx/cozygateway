/**
 * Bounds for every public WebSocket ingress. Attach events move references and
 * metadata; file bytes use authenticated HTTP media routes, so this leaves
 * published protocols room without letting an anonymous upgrade reserve an
 * unbounded buffer.
 */
export const PUBLIC_WEBSOCKET_MAX_PAYLOAD_BYTES = 1 * 1024 * 1024;

/** Sockets that upgraded but have not yet proved an app, runner, or attach identity. */
export const PUBLIC_WEBSOCKET_MAX_PENDING_CONNECTIONS = 32;
