# Observe dashboard

Enable `observability.enabled` in the gateway configuration. Open `/observe/pair` on the gateway's
origin and use an observer setup code (`cozygateway pair --kind observer`). The dashboard reads
records only. Decisions, configuration, and revocation stay in CozyChat.

Pairing uses the existing `/pair` endpoint. The browser retains its scoped device token in local
storage for read API headers and websocket authentication. `GET /observe/session` exchanges that
bearer for an HttpOnly, SameSite=Strict cookie restricted to `/observe`, enabling authenticated
HTML, script, stylesheet and font navigation. HTTPS cookies are Secure. Each static request checks
the device record, so revocation immediately denies subsequent requests. Cookies do not authorize
ordinary API routes or writes. Clear browser site data to remove browser credentials.

The Gateway tab supports all runtimes. The CozyAgents tab appears when the read API reports an
attached snapshot subject. The selected time window and bot filter apply to windowed read APIs;
agent internals and the ordered step instrument are explicitly latest-snapshot views. Missing
measurements are labeled, and model speeds require 20 samples independently per cache prefix.
Current snapshots lack turn span timestamps, so the instrument shows ordered measured rows and
explains the unavailable chronology. No turn spans or context limits are fabricated.

The browser reloads affected read surfaces after observation frames and gap signals, and retries
its socket with bounded backoff. Offline state retains labeled last-received data. Remote assets
are never loaded. Reduced-motion settings disable animation.

Edit source assets in `packages/gateway/src/observe/dashboard/`. `pnpm build` regenerates
`assets.generated.ts`; `pnpm bundle` embeds those bytes and font licenses in the release file.
Font URLs stay same-origin to satisfy `font-src 'self'`. A shared content version invalidates
private immutable asset caches; the HTML and pairing response are not cached.
