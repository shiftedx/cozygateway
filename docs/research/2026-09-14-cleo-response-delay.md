# Cleo response delay, September 13–14, 2026

The reported silent wait was dominated by Hermes preflight context compression, not an attach backlog. The request completed without restarting either service. The gateway batching work was not deployed during this incident: production ran image `cozygateway-gateway:perf-18939c2` with zero container restarts since 03:45:30 UTC.

All times below are September 14 UTC; subtract five hours for September 13 CDT.

| Boundary | Time | Evidence |
| --- | --- | --- |
| Gateway admitted the user request | 04:18:48.765 | Native message and durable command rows |
| Hermes acknowledged the command | 04:18:48.786 | 21 ms after admission |
| Hermes started context compression | 04:18:50.954 | Cleo `agent.log`; approximately 203,750 tokens exceeded the 203,347 threshold |
| Compression committed | 04:20:44.391 | Telemetry duration 113,439 ms; 163 messages became 31, approximately 35,736 tokens; no fallback |
| First normal model call completed | 04:20:49.256 | `gpt-5.6-luna` through `openai-codex`, logged latency 4.8 s |
| First tool activity reached the gateway | 04:20:49.908 | Native turn transition |
| Final commit reached the gateway | 04:21:22.534 | Attach event 127998 |
| Final commit applied | 04:21:22.563 | 29 ms after receipt, terminal completed, no projection retry |
| App display report recorded | 04:22:40.595 | Durable message receipts |

The 38 attach events for this turn were accepted and applied without projection retries. Cleo's service stayed running, and no execution remained active after completion. Gateway readiness showed all seven peers online, with zero pending/dead-letter events. The request-to-final interval was about 154 seconds; approximately 113 seconds of that was explicitly measured context compression. No provider rate-limit, retry, or timeout evidence was found for the interval.

The display timestamp is not a phone receive timestamp. CozyChat reports assistant rows from SwiftUI `onAppear`, batches reports for two seconds, and the gateway stores the time the POST is handled. Leaving Cleo's chat cancels that chat's subscription; returning reloads history. The user initially recalled the chat staying visible, then said they may have switched to another bot. Therefore the additional 78 seconds cannot be assigned to transport or rendering latency from these receipts. No historical iPhone receive/render trace was available. The shared app socket reconnected at 04:19:46 and remained open through the final commit.

The gateway also logged repeated `profiles.list` roster-refresh timeouts. They are a separate observed issue; these logs do not establish that they caused the chat delay. The native attach path continued to admit and project events promptly.

Evidence sources: Cleo's local `agent.log`, `gateway.error.log`, timestamped gateway traces, and read-only queries of the native message, turn terminal, receipt, command, and attach inbox tables. A private, content-free database extract is retained at `/tmp/cozygateway-group-commit-20260914/incident-cleo-evidence.json`. Raw private logs remain outside the repository.

No restart, test chat message, or production configuration change was needed. A useful separate improvement is conveying the existing Hermes compaction progress to the app; gateway storage retention alone does not shorten the model's live conversation context.
