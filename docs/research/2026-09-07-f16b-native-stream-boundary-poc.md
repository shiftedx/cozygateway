# F16b native stream boundary probe

## Decision

Native streaming remains off by default. The installed Hermes consumer at
`a6e10e693fa62f1077fd2b4365edcd9d9919302f` does not pass a boundary or
turn-final discriminator to the plugin extension point. A plugin cannot safely
choose whether its `finalize=True` frame should commit and seal a turn.

No heuristic was added and no Hermes source was changed. The existing
`COZYGATEWAY_NATIVE_STREAMING` switch remains an explicit opt-in only.

## Deterministic isolated probe

The probe imported the installed `GatewayStreamConsumer` with an empty isolated
Hermes home and a recording adapter. It made no profile, gateway, or model
request. The recording adapter returned success for every frame so the result
shows the actual consumer-to-plugin contract, rather than a fallback path.

| Case | Observed adapter frame | Relevant consumer state after the frame |
| --- | --- | --- |
| Approval boundary with text | `text="before approval", finalize=True, chat_id="chat", reply_to="reply", turn_id="turn"` | Native mode is degraded for the post-approval response. |
| Clarify boundary with text | `text="before clarify", finalize=True, chat_id="chat", reply_to="reply", turn_id="turn"` | Native mode remains eligible to reopen, but only after the indistinguishable finalized frame. |
| Empty boundary | `text="", finalize=True, chat_id="chat", reply_to="reply", turn_id="turn"` | Same terminal frame shape as approval. |
| Terminal control | `text="control", finalize=True, chat_id="chat", reply_to="reply", turn_id="turn"` | Same frame shape as every boundary above. |
| Interim control | `text="control", finalize=False, chat_id="chat", reply_to="reply", turn_id="turn"` | The only adapter-visible nonterminal form. |

`_handle_approval_boundary` calls `_finalize_boundary_stream(_reason)`, but
`_finalize_boundary_stream` uses `_reason` only in its debug log. It calls
`_send_frame(finalize_text, finalize=True)`. `_send_frame` forwards only text,
`finalize`, chat id, reply id, and turn id to `send_stream_frame`. A terminal
frame takes that same path. The clarify reopen state is recorded only after the
frame and is not an adapter argument.

This covers the approval, clarify, empty-boundary, terminal control, and
interim frame shapes deterministically. It is not a live burner soak: no live
approval card, tool-only agent turn, or interim `send_message` agent event was
created. That omission does not justify enabling the capability because the
blocking ambiguity exists at the installed consumer boundary before platform
delivery.

## Existing plugin guard evidence

The focused Hermes-venv command below passed 15 tests:

```text
PYTHONPATH=integrations/attach-plugin <Hermes venv python> -m unittest \
  integrations/attach-plugin/tests/test_native_stream_cadence.py \
  integrations/attach-plugin/tests/test_draft_stream_contract.py
```

The cadence suite keeps the concrete adapter class attribute and the runtime
probe false without the explicit environment switch. It also proves that an
interim native frame is a draft, a terminal native frame commits once, and the
empty native placeholder follows the existing failed-empty-reply path. The
draft contract suite keeps an interim `send()` from committing the active turn.

## Required upstream signal

The smallest safe upstream contract is a boundary-specific value forwarded from
`_finalize_boundary_stream` through `_send_frame` to `send_stream_frame`, with
an unambiguous value for a real turn final. The adapter can then preserve a
boundary stream without committing its turn. Until that value exists, a plugin
cannot infer the distinction from text, ids, frame order, or `finalize=True`.
