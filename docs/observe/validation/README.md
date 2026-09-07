# D4 visual validation

2026-09-07. Chromium headless, 1440x1000 desktop and 390x844 mobile, OS light/dark and
reduced-motion settings. The isolated localhost Hono gateway used D3's actual read routes,
in-memory storage, and one D5-valid payload from the lane test fixture accepted through the
snapshot writer. These are validation fixtures, never dashboard runtime data. A separate empty
storage pass verified the Hermes/general Gateway surface with no CozyAgents tab.

No page JavaScript errors or CSP violations. The only console error was an unrelated favicon
404. Both tabs had document scrollWidth 390 at viewport width 390. The mock websocket sent a
ready frame and an observe_gap; the dashboard refreshed and returned to Live. Browser offline
then online returned to Live after socket reconnect. Reduced motion suppressed animations.

The turn instrument shows ordered reported steps, not a fabricated timeline. Missing internals
and sparse model samples stay labeled. New optional D3 cost/peer/device comparison fields are
covered by defensive rendering and must be checked again after the integration rebase.
