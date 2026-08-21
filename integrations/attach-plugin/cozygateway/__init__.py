"""Live-session platform adapter for the gateway attach protocol.

Public surface:

* ``register(ctx)`` -- the plugin entry point the loader calls.
* ``AttachV1Client`` / ``AttachV1ClientConfig`` -- the durable outbound
  ``/attach/v1`` transport.
* ``normalize_text_to_blocks`` -- the markdown to typed-blocks normalizer.
* ``ToolChipTracker`` -- the per-turn tool-chip tracker.

The loader imports this module and looks up ``register`` on it. ``register`` lives
in :mod:`.adapter`, which imports the harness tree only lazily inside its methods,
so importing it here (and thus this package) does not require the harness to be on
the path.
"""

from .adapter import register
from .attach_client_v1 import AttachV1Client, AttachV1ClientConfig
from .text_blocks import normalize_text_to_blocks
from .tool_chips import ToolChipTracker

__all__ = [
    "register",
    "AttachV1Client",
    "AttachV1ClientConfig",
    "normalize_text_to_blocks",
    "ToolChipTracker",
]
