# cozygateway-contract

The wire contract v1 for cozygateway, as code. This package publishes the
[TypeBox](https://github.com/sinclairzx81/typebox) schemas and the TypeScript types derived
from them for the whole surface a client talks to:

- the REST request and response bodies,
- the WebSocket client and server frames,
- the RichBlock content model,
- the shared resource shapes (Device, Agent, Thread, Message, and friends),
- the frozen error-code list.

The human-readable spec these schemas mirror lives at
[`contract/v1.md`](../../contract/v1.md) in the repo root. That prose is the authority; this
package is its machine artifact. When you need to know what a field means, read the spec. When
you need to validate a value on the wire, use the schemas here.

## Install

```bash
npm i cozygateway-contract
```

Requires Node.js >= 24.

## Usage

Two helpers wrap TypeBox validation:

- `check(schema, value)` is a type guard. It returns a boolean and narrows the value when true.
- `assertValid(schema, value)` returns the typed value or throws a `ContractViolation` (which
  carries the JSON pointer `path` of the first failing location).

Narrow an incoming server frame, then switch on its `type`:

```ts
import { check, ServerFrameSchema, type ServerFrame } from "cozygateway-contract";

function handleFrame(raw: unknown) {
  if (!check(ServerFrameSchema, raw)) {
    // Not a frame we recognize. Per the contract, ignore unknown server frames.
    return;
  }

  const frame: ServerFrame = raw; // narrowed by check()

  switch (frame.type) {
    case "ready":
      console.log("connected as", frame.deviceId);
      break;
    case "committed":
      applyCommitted(frame.threadId, frame.seq, frame.message);
      break;
    case "draft":
      renderDraft(frame.turnId, frame.blocks, frame.toolCalls);
      break;
    // ... synced, done, presence, error
  }
}
```

Validate a request body before you send it and throw early on your own bugs:

```ts
import { assertValid, SendMessageRequestSchema } from "cozygateway-contract";

const body = assertValid(SendMessageRequestSchema, {
  blocks: [{ type: "paragraph", text: "hello" }],
});
// body is typed as SendMessageRequest here.
```

Every exported schema has a matching exported type (for example `ServerFrameSchema` and
`ServerFrame`, `MessageSchema` and `Message`), plus the constant `CONTRACT_VERSION` (`"v1"`).

## Versioning

The package tracks the wire contract. Within v1.x, changes are additive only: new optional
fields, new endpoints, new server frame types, and new error codes. Receivers ignore object
fields and server frame types they do not recognize, so a client built against an earlier v1.x
keeps working against a later v1.x gateway. Unknown RichBlock types are the one exception: the
block-type union is closed, and a client must treat an unrecognized block `type` as invalid.

A breaking change is a new contract version, signalled by a new value of the `contract` field
in `GatewayInfo`. See section 8 of [`contract/v1.md`](../../contract/v1.md) for the full
evolution policy.

## License

MIT
