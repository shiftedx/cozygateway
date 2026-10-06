"""Live-session platform adapter for the gateway attach protocol.

Public surface:

* ``register(ctx)`` -- the plugin entry point the loader calls.
* ``AttachV1Client`` / ``AttachV1ClientConfig`` -- the durable outbound
  ``/attach/v1`` transport.
* ``normalize_text_to_blocks`` -- the markdown to typed-blocks normalizer.
* ``ToolChipTracker`` -- the per-turn tool-chip tracker.

The loader imports this module and looks up ``register`` on it. Public exports are
resolved lazily so importing a harness-free sibling such as :mod:`.attach_spool`
does not also require the transport's ``websockets`` dependency.
"""

from typing import Any

__all__ = [
    "register",
    "AttachV1Client",
    "AttachV1ClientConfig",
    "normalize_text_to_blocks",
    "ToolChipTracker",
]


def __getattr__(name: str) -> Any:
    if name == "register":
        from .adapter import register

        value = register
    elif name in {"AttachV1Client", "AttachV1ClientConfig"}:
        from .attach_client_v1 import AttachV1Client, AttachV1ClientConfig

        value = {
            "AttachV1Client": AttachV1Client,
            "AttachV1ClientConfig": AttachV1ClientConfig,
        }[name]
    elif name == "normalize_text_to_blocks":
        from .text_blocks import normalize_text_to_blocks

        value = normalize_text_to_blocks
    elif name == "ToolChipTracker":
        from .tool_chips import ToolChipTracker

        value = ToolChipTracker
    else:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

    globals()[name] = value
    return value
