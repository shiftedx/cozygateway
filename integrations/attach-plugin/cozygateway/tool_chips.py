"""Per-turn tool-chip tracker.

The harness's tool-lifecycle hooks carry a tool name (and maybe an argument or
result preview) but NO stable per-call id. So chip ids are synthesized here from a
per-turn, per-name occurrence counter: the first ``search`` call is ``search#1``,
the next is ``search#2``, and so on.

A start event opens a chip in the ``running`` state. A completion event closes the
MOST RECENT still-open chip of that name, moving it to ``ok`` or ``error``. This
name-and-recency pairing is what lets a start and its completion line up without a
shared id.

This module holds NO harness imports; the adapter feeds it already-extracted
fields.
"""

from __future__ import annotations

from typing import Dict, List, Optional

from .attach_client import ToolChip

# Detail previews are clamped so a chip stays compact on the wire.
_DETAIL_LIMIT = 200


def _clip(detail: Optional[str]) -> Optional[str]:
    """Truncate a detail preview to a compact length, or pass through None."""
    if detail is None:
        return None
    text = detail if isinstance(detail, str) else str(detail)
    if len(text) <= _DETAIL_LIMIT:
        return text
    return text[:_DETAIL_LIMIT]


class ToolChipTracker:
    """Accumulates a turn's tool events into the materialized chip list.

    One instance per in-flight turn. ``open`` / ``close`` mutate the per-name state;
    ``chips()`` returns the current list in first-seen order, which is the exact
    array the adapter folds into each draft.
    """

    def __init__(self) -> None:
        self._chips: List[ToolChip] = []
        self._counts: Dict[str, int] = {}

    def open(self, name: str, detail: Optional[str] = None) -> None:
        """Start a new chip for ``name`` in the ``running`` state."""
        occurrence = self._counts.get(name, 0) + 1
        self._counts[name] = occurrence
        self._chips.append(
            ToolChip(
                id=f"{name}#{occurrence}",
                name=name,
                status="running",
                detail=_clip(detail),
            )
        )

    def close(self, name: str, ok: bool, detail: Optional[str] = None) -> None:
        """Close the most recent open chip of ``name`` as ``ok`` or ``error``.

        If no matching open chip exists (a completion with no observed start), a
        closed chip is created so the outcome is never silently dropped.
        """
        status = "ok" if ok else "error"
        clipped = _clip(detail)
        for chip in reversed(self._chips):
            if chip.name == name and chip.status == "running":
                chip.status = status
                if clipped is not None:
                    chip.detail = clipped
                return
        occurrence = self._counts.get(name, 0) + 1
        self._counts[name] = occurrence
        self._chips.append(
            ToolChip(id=f"{name}#{occurrence}", name=name, status=status, detail=clipped)
        )

    def chips(self) -> List[ToolChip]:
        """The current chip list, in first-seen order."""
        return list(self._chips)

    def __bool__(self) -> bool:
        return bool(self._chips)
