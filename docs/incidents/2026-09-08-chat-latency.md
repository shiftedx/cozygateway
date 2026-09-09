# Chat latency and missing reasoning — September 8, 2026

## Observed symptoms

The user reported chat loading delays, messages remaining in “sending,” and missing live
thought updates compared with Sunday. This followed the separate interim-commit spool incident
recorded in `2026-09-08-interim-commit-delivery.md`.

## Evidence

- Production gateway v0.8.1 repeatedly logged `profiles.list` RPC timeouts at 30 seconds,
  including 21:46–21:49 and 21:52–21:54 CDT. Transport health still reported the Hermes
  control connection online with zero reconnect attempts.
- Native chat canonical/history/send paths awaited automatic latest-session reconciliation.
  Its desktop-session index lookup first requested `profiles.list`, then `session.list`.
  Its enhancement-only error fallback ran only after the remote timeout.
- A new authenticated control client from the production gateway answered profile-list probes
  in 193 ms without session enrichment and 1,010 ms with it at approximately 21:59 CDT.
  Three later enriched probes took 2,696, 1,020, and 1,088 ms. Calling the installed handler
  directly took approximately 0.49 seconds with sessions. This establishes transient control
  latency; it does not prove a permanently broken socket.
- The control client had no application heartbeat. An RPC timeout rejected its caller but
  left connection liveness unchanged. Hermes dispatches profile-list work to a shared worker
  pool, so a responsive application ping can distinguish queued work from an unresponsive link.
- Cleo's model server timed out twice around 21:57 CDT. The call completed at 21:58:06 with
  185.4 seconds logged including retries; its tool callbacks followed about 0.2 seconds later.
  Subsequent model calls took approximately 11–15 seconds.
- The gateway received recent text drafts at approximately 100 ms intervals during generation.
  The 21:59 reply had 23 draft updates over 2.35 seconds before final commit. These observations
  establish delivery to the gateway, not rendering on the user's phone.
- Production's last recorded reasoning event was September 6 at 18:27:50 UTC. Corresponding
  local model logs identify Codex reasoning models. Qwen activity begins later that Sunday,
  approximately 21:30 CDT. The active Qwen provider explicitly sets
  `chat_template_kwargs.enable_thinking: false`; the plugin reasoning observer is enabled.
  This explains the missing model thoughts independently of the gateway latency.

## Repair boundaries

Automatic desktop-session discovery must not hold ordinary chat behind a 30-second RPC.
Deadline-expired remote reads must remain inert and coalesced until they settle. Once an exact
resume command is queued, its existing bounded confirmation protocol remains authoritative.

A control-connection watchdog must reconnect on a missed lightweight application probe,
not on arbitrary long-operation timeouts. A healthy ping during a slow profile lookup must
preserve the connection. Profile-existence checks need names only and can skip session enrichment.

The user subsequently requested Astra with light reasoning and Luna subagents. Cleo's supported
profile settings API saved `openai-codex:gpt-6-astra`, effort `low`, and
`openai-codex:gpt-5.6-luna`. Readback confirmed the stale delegation endpoint was cleared,
reasoning was enabled, and the existing Luna effort remained `high`. Neither the current
gateway chat nor Hermes routing record had a model override. The previous profile configuration
was backed up privately; no restart was required for this next-turn configuration change.

## Operational notes

Local Xcode compilation was stopped around 21:54 CDT to reduce contention on the Hermes host.
No causal claim is made from the subsequent lack of profile timeouts. Cleo continued active
work; no additional bot or dashboard restart was used for this latency investigation.
