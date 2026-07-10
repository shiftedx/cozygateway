# cozygateway-conformance

A black-box conformance suite for the cozygateway wire contract v1. Point it at any gateway
implementation and it proves, over HTTP and WebSocket alone, that the implementation speaks
the wire the contract describes.

## What conformance means

A gateway is conformant when this suite passes against it while the gateway exposes the
reference echo backend. Every assertion is authored from the frozen spec (`contract/v1.md`)
and the `cozygateway-contract` schemas, never from any gateway's source code. The suite reads
and writes only the public REST and WebSocket surface, so a green run is evidence the
implementation matches the contract, not that it shares the reference code.

The suite covers twelve groups: health, capabilities, pairing, the auth wall, device lifecycle,
agents, thread lifecycle, message round trip and seq discipline, WebSocket lifecycle, streaming
order, reconnect dedup, and turn failure.

The capabilities group checks the additive `GatewayInfo.capabilities` block (contract v1.md
section 5, issue #16) generically: that it agrees across `GET /health`, the pair response, and
the `ready` frame when present, and that the wire schema tolerates it being entirely absent
(older gateways) or carrying capability ids the suite has never heard of. It never pins a
specific capability id, so it stays portable across any gateway under test, including one that
advertises no capabilities at all. This repo's own reference-gateway runner additionally proves
one fake `com.cozylabs.*` vendor capability travels end to end (see "Running the reference
gateway's own conformance" below); that check is specific to the reference gateway's fixture and
intentionally lives outside the portable suite.

## The reference echo backend

The suite drives the reference echo backend, whose semantics are frozen in section 7 of the
contract. An agent whose reply to a message whose first block is
`{ "type": "paragraph", "text": T }` produces:

1. exactly two draft frames, then
2. a commit of `[{ "type": "paragraph", "text": "Echo: " + T }]`.

A value of `T` that contains the substring `[[fail]]` fails the turn: the gateway completes it
as a `turn.failed` system message rather than an echo commit (a committed `role: "system"`
message carrying `marker: "turn.failed"`, plus a `turn_failed` error frame, and no `done`
frame).

## Wiring it into your own vitest run

The package exports one function:

```ts
import { registerConformanceSuite } from "cozygateway-conformance";
```

`registerConformanceSuite(env)` calls vitest's `describe`/`it` to register the whole suite, so
call it at the top level of a test file in your own vitest project. You supply a
`ConformanceEnv` that reaches your gateway under test:

```ts
export interface ConformanceEnv {
  /** Base HTTP URL of the gateway under test, no trailing slash. */
  baseUrl: () => string;
  /** Mint a fresh single-use setup code on the gateway under test. */
  issueSetupCode: () => Promise<string>;
  /** Agent id of the reference echo backend on the gateway under test. */
  echoAgentId: string;
}
```

A minimal runner that boots the gateway, registers the suite, and tears it down:

```ts
import { afterAll, beforeAll } from "vitest";

import { registerConformanceSuite } from "cozygateway-conformance";
import { startYourGateway } from "./your-gateway.ts";

let gateway;

beforeAll(async () => {
  gateway = await startYourGateway({ echoAgentId: "conformance-echo" });
});

afterAll(async () => {
  await gateway.close();
});

registerConformanceSuite({
  baseUrl: () => gateway.url,
  issueSetupCode: () => Promise.resolve(gateway.issueSetupCode()),
  echoAgentId: "conformance-echo",
});
```

Your gateway must expose the reference echo backend under the `echoAgentId` you pass. Boot it
on an ephemeral port with an in-memory or temp-dir database so the run stays isolated. Peer
dependency: `vitest >= 3`.

## Running the reference gateway's own conformance

This repo ships a runner (`test/reference-gateway.test.ts`) that starts the reference gateway
with the mock echo adapter and runs the suite against it:

```bash
pnpm --filter cozygateway-conformance test
```
