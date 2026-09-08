# CozyGateway Observe

## Register

product

## Users and purpose

People operating their own CozyGateway use the paired, read-only dashboard to understand bot
health, turn latency, pending human decisions, deliveries, and CozyAgents internals. Actions remain
in CozyChat. The page runs on the gateway, including through its tunnel, with no remote assets.

## Design authority

Observe is an extension of CozyChat. The September 7, 2026 user direction supersedes the earlier
observability concept's green brand accents and display typography. The current CozyChat
`CozyKit/Sources/CozyUI/CozyColor.swift`, `CozyFont.swift`, `TactileButton.swift`, and `CozyField.swift`
define the visual roles. The existing observability design still governs data, scope, and behavior.

Use CozyChat's graphite and rust palette in both appearances: neutral canvas, raised grouped
surfaces, quiet opaque boundaries, rust primary actions and selection. Green indicates success or
health; it is not the brand action color. Preserve authored status distinctions with text or icons
so color never carries the entire meaning.

Everyday titles, navigation, labels and controls use native system typography. Monospaced type is
reserved for technical values. Controls use familiar rounded shapes, visible focus, explicit
loading/disabled/error states, and at least 44-pixel targets. Pairing and authenticated views share
one visual vocabulary. Avoid fake avatar shapes, decorative display fonts, or marketing layouts.

Retain all Gateway and CozyAgents observations. Sparse, stale, unavailable and disconnected states
must remain explicit; never fabricate telemetry to make a panel look full. Verify the actual
rendered pairing flow and both dashboard views in light and dark, at desktop and phone widths,
with keyboard interaction, readable contrast, and reduced motion. Assets remain same-origin and
embedded; authentication and read-only scope must not change for presentation work.
