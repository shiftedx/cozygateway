"""Per-turn tool-chip tracker.

The harness's tool-lifecycle hook payload carries a tool name (and maybe an
argument or result preview) plus, when the harness assigns one, a real per-call
id (see the adapter's ``TOOL_CALL_ID_KEY``). When that id is present on BOTH the
start and completion legs of a call, it pairs them exactly: the completion
closes the chip opened under the same id, regardless of finish order. When it is
absent from either leg, pairing falls back to a synthesized per-turn, per-name
occurrence counter plus recency: the first ``search`` call is ``search#1``, the
next is ``search#2``, and a completion closes the MOST RECENT still-open chip of
that name. That name-and-recency fallback is what the harness id exists to
correct: it mispairs two overlapping (or out-of-order-completing) calls to the
same tool, since "most recently opened" is not always "the one that just
finished".

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
        # Running chips indexed by harness call id, only for chips opened with
        # one. Popped on close (by id or by the name-recency fallback), so a
        # call id is never matched against a chip that already closed.
        self._open_by_call_id: Dict[str, ToolChip] = {}

    def _next_synthesized_id(self, name: str) -> str:
        occurrence = self._counts.get(name, 0) + 1
        self._counts[name] = occurrence
        return f"{name}#{occurrence}"

    def _find_running_by_name(self, name: str) -> Optional[ToolChip]:
        for chip in reversed(self._chips):
            if chip.name == name and chip.status == "running":
                return chip
        return None

    def open(
        self, name: str, detail: Optional[str] = None, call_id: Optional[str] = None
    ) -> None:
        """Start a new chip for ``name`` in the ``running`` state.

        ``call_id`` is the harness's real per-call id when the hook payload
        carried one; it becomes the chip's wire id. Absent that, the id falls
        back to the synthesized ``name#n`` scheme.
        """
        chip_id = call_id if call_id else self._next_synthesized_id(name)
        chip = ToolChip(id=chip_id, name=name, status="running", detail=_clip(detail))
        self._chips.append(chip)
        if call_id:
            self._open_by_call_id[call_id] = chip

    def close(
        self,
        name: str,
        ok: bool,
        detail: Optional[str] = None,
        call_id: Optional[str] = None,
    ) -> None:
        """Close the chip that opened this call, moving it to ``ok`` or ``error``.

        When ``call_id`` is given and matches a still-open chip, that exact chip
        closes regardless of finish order (this is what lets overlapping calls to
        the same tool pair correctly). Otherwise pairing falls back to the most
        recent still-open chip of ``name`` -- including when a given ``call_id``
        matches no open chip (a lost start event or a garbled id must degrade
        gracefully, not crash or mispair). If no matching open chip exists
        either way (a completion with no observed start), a closed chip is
        created so the outcome is never silently dropped.
        """
        status = "ok" if ok else "error"
        clipped = _clip(detail)
        chip = self._open_by_call_id.pop(call_id, None) if call_id else None
        if chip is None:
            chip = self._find_running_by_name(name)
        if chip is not None:
            # The chip may have been indexed under a DIFFERENT call id than the
            # one this close carries (open had an id, this close didn't, or the
            # ids simply didn't match) -- drop that stale mapping too.
            if self._open_by_call_id.get(chip.id) is chip:
                del self._open_by_call_id[chip.id]
            chip.status = status
            if clipped is not None:
                chip.detail = clipped
            return
        chip_id = call_id if call_id else self._next_synthesized_id(name)
        self._chips.append(ToolChip(id=chip_id, name=name, status=status, detail=clipped))

    def chips(self) -> List[ToolChip]:
        """The current chip list, in first-seen order."""
        return list(self._chips)

    def __bool__(self) -> bool:
        return bool(self._chips)
