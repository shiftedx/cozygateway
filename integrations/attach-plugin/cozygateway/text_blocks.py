"""Line-oriented markdown to typed-blocks normalization.

Converts a run of accumulated model text (markdown) into the closed
:data:`RichBlock` union before the gateway or the client sees it. The renderer runs
NO markdown parser: it renders only the typed blocks this produces.

This is deliberately NOT a general CommonMark engine. It emits only the closed set,
never HTML, never resolves links or images, and treats inline emphasis / links /
inline code as inert literal text carried in a block's plain ``text`` (the renderer
escapes it), so nothing structural can be injected across the boundary.

Supported, line-oriented:
  - ATX headings ``#`` / ``##`` / ``###`` (deeper input clamps to level 3)
  - fenced code (body verbatim; an unterminated trailing fence, i.e. the still
    streaming case, is emitted as a code block so a live draft previews code as
    code rather than as a half-open paragraph)
  - display math delimited by ``$$`` on its own line
  - bullet (``-`` / ``*`` / ``+``) and ordered (``1.`` / ``1)``) lists, including
    ``[x]`` / ``[ ]`` task items
  - pipe tables (a header row, a ``---`` separator, then body rows)
  - everything else: blank-line-delimited paragraphs (newlines within a run kept)
"""

from __future__ import annotations

import re
from typing import List, Optional, Tuple

from .attach_client import (
    CodeBlock,
    HeadingBlock,
    ListBlock,
    ListItemBlock,
    MathBlock,
    ParagraphBlock,
    RichBlock,
    TableBlock,
)

_FENCE_RE = re.compile(r"^```(.*)$")
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")
_BULLET_RE = re.compile(r"^\s*[-*+]\s+(.*)$")
_ORDERED_RE = re.compile(r"^\s*\d+[.)]\s+(.*)$")
_TASK_RE = re.compile(r"^\[([ xX])\]\s+(.*)$")
_TABLE_SEP_RE = re.compile(r"^\|?[\s:|-]+\|?$")


def normalize_text_to_blocks(text: str) -> List[RichBlock]:
    """Parse running assistant ``text`` (markdown) into the closed block union.

    Dispatch order per line: blank, fence, math, heading, table, list, paragraph.

    A thin wrapper over :func:`_normalize_lines`, which is the single dispatch
    implementation shared with :class:`IncrementalNormalizer` (it also reports the
    top-level blank-line boundaries that make incremental caching safe). Kept
    unchanged in shape and behavior so every existing caller and fixture is
    byte-identical to before that class existed.
    """
    if not text:
        return []
    blocks, _boundaries = _normalize_lines(re.sub(r"\r\n?", "\n", text).split("\n"))
    return blocks


def _normalize_lines(lines: List[str]) -> Tuple[List[RichBlock], List[int]]:
    """Core dispatch loop over an already-split, already ``\\n``-normalized ``lines``.

    Returns ``(blocks, boundaries)``. ``boundaries`` are the line indices of every
    blank line processed at the TOP level of the dispatch loop (i.e. one this
    function's own blank-line branch handled directly, as opposed to one swallowed
    verbatim inside an open fenced-code or display-math body). Immediately after
    such a line the loop holds no residual state: ``para`` is empty and no
    fence/math/table/list is open, so blocks built from ``lines[: i + 1]`` can
    never change no matter what lines are appended afterward -- this is exactly
    the stability invariant :class:`IncrementalNormalizer` caches on.
    """
    blocks: List[RichBlock] = []
    boundaries: List[int] = []
    para: List[str] = []

    def flush_paragraph() -> None:
        joined = "\n".join(para).strip()
        if joined:
            blocks.append(ParagraphBlock(text=joined))
        para.clear()

    index = 0
    total = len(lines)
    while index < total:
        line = lines[index]

        # Blank line: paragraph boundary, and (at this, the outer loop's own
        # dispatch) a top-level stability boundary.
        if line.strip() == "":
            flush_paragraph()
            boundaries.append(index)
            index += 1
            continue

        # Fenced code: capture verbatim to the closing fence (or to EOF, for a
        # still-streaming draft).
        fence = _FENCE_RE.match(line)
        if fence:
            flush_paragraph()
            language = fence.group(1).strip()
            body: List[str] = []
            index += 1
            while index < total and not lines[index].startswith("```"):
                body.append(lines[index])
                index += 1
            # index now sits on the closing fence (or past EOF); step over it.
            blocks.append(CodeBlock(code="\n".join(body), language=language or None))
            index += 1
            continue

        # Display math.
        if line.strip() == "$$":
            flush_paragraph()
            math_body: List[str] = []
            index += 1
            while index < total and lines[index].strip() != "$$":
                math_body.append(lines[index])
                index += 1
            blocks.append(MathBlock(latex="\n".join(math_body).strip()))
            index += 1
            continue

        # ATX heading (deeper than 3 clamps to 3).
        heading = _HEADING_RE.match(line)
        if heading:
            flush_paragraph()
            level = min(len(heading.group(1)), 3)
            blocks.append(HeadingBlock(level=level, text=heading.group(2).strip()))
            index += 1
            continue

        # Pipe table: a header row followed immediately by a separator row.
        if (
            _is_table_row(line)
            and index + 1 < total
            and _is_table_separator(lines[index + 1])
        ):
            flush_paragraph()
            header = _split_table_row(line)
            rows: List[List[str]] = []
            index += 2  # skip the header and the separator
            while index < total and _is_table_row(lines[index]):
                rows.append(_split_table_row(lines[index]))
                index += 1
            # index now sits on the first non-row line; it is handled next.
            blocks.append(TableBlock(header=header, rows=rows))
            continue

        # List: a run of consecutive bullet / ordered items (task items included).
        if _list_marker(line) is not None:
            flush_paragraph()
            items: List[ListItemBlock] = []
            ordered = False
            while index < total:
                marker = _list_marker(lines[index])
                if marker is None:
                    break
                ordered = marker[0]
                items.append(_parse_item(marker[1]))
                index += 1
            # index now sits on the first non-list line; it is handled next.
            blocks.append(ListBlock(items=items, ordered=ordered))
            continue

        # Otherwise accumulate into the current paragraph.
        para.append(line)
        index += 1

    flush_paragraph()
    return blocks, boundaries


def _list_marker(line: str) -> Optional[Tuple[bool, str]]:
    """Match a single list line as ``(ordered, content)``, or None."""
    bullet = _BULLET_RE.match(line)
    if bullet:
        return (False, bullet.group(1))
    ordered = _ORDERED_RE.match(line)
    if ordered:
        return (True, ordered.group(1))
    return None


def _parse_item(content: str) -> ListItemBlock:
    """Lift a ``[x]`` / ``[ ]`` task prefix into ``checked`` (absent means a plain bullet)."""
    task = _TASK_RE.match(content)
    if task:
        return ListItemBlock(text=task.group(2).strip(), checked=task.group(1).lower() == "x")
    return ListItemBlock(text=content.strip())


def _is_table_row(line: str) -> bool:
    """A line that contains a pipe and is not blank."""
    return "|" in line and line.strip() != ""


def _is_table_separator(line: str) -> bool:
    """A separator row: only pipes, dashes, colons and spaces, with at least one dash."""
    trimmed = line.strip()
    return ("-" in trimmed) and bool(_TABLE_SEP_RE.match(trimmed))


def _split_table_row(line: str) -> List[str]:
    """Split a ``| a | b |`` row into trimmed cells, dropping the outer pipes' empties."""
    stripped = line.strip()
    stripped = re.sub(r"^\|", "", stripped)
    stripped = re.sub(r"\|$", "", stripped)
    return [cell.strip() for cell in stripped.split("|")]


class IncrementalNormalizer:
    """Per-turn cache that makes repeated draft-flush normalization proportional to
    newly arrived text instead of the whole accumulated reply.

    A draft flush hands this the FULL accumulated text every time (full-replace
    wire semantics; see ``adapter.send_draft`` and ``contract/attach-v0.md`` --
    unchanged by this cache). Calling :func:`normalize_text_to_blocks` on that
    whole string on every flush is what makes a reply of n chunks cost O(n^2)
    total: this class instead remembers the already-normalized STABLE prefix (the
    text and blocks) and only re-normalizes the still-changeable tail.

    Stability rule (conservative by design; see the module docstring's dispatch
    order): given append-only growth, splitting ``text`` by ``\\n`` leaves every
    line but the last permanently fixed (only the last line can still grow, by
    more characters or by the arrival of a ``\\n`` that finalizes it and starts a
    new one). Of those fixed lines, one that ``_normalize_lines`` processes as a
    blank line AT THE TOP of its dispatch loop (not swallowed verbatim inside an
    open fenced-code or math body) is a point where the parser holds no residual
    state at all -- no open paragraph, fence, math, table, or list. Blocks built
    from everything up to and including that line can never change no matter what
    is appended afterward, so they are cached; anything after it (including an
    unclosed fence/table/list, or a line the parser still needs a lookahead line
    to classify, e.g. a table header awaiting its separator row) stays in the
    unstable tail and is re-normalized on every flush until its own later
    top-level blank line seals it. A reply with no blank lines at all (a single
    huge paragraph or one giant unclosed fence) has no stable prefix and falls
    back to full re-normalization every flush, exactly like before this class
    existed -- the same degenerate case the original implementation already had.

    Also defends against a non-append update (the terminal ``send()`` path may
    hand this a ``final_text`` that is not simply the last drafted text extended):
    if the new text does not start with the previously seen text, the cache
    resets to empty and this call falls back to a full re-normalization, which is
    always correct, just not accelerated.
    """

    __slots__ = ("_prev_norm", "_stable_len", "_stable_blocks")

    def __init__(self) -> None:
        self._prev_norm: str = ""
        self._stable_len: int = 0
        self._stable_blocks: List[RichBlock] = []

    def update(self, text: str) -> List[RichBlock]:
        """Return the full block list for ``text`` (byte-identical to
        ``normalize_text_to_blocks(text)``), doing work proportional only to the
        text that changed since the last call."""
        norm = re.sub(r"\r\n?", "\n", text) if text else ""

        if self._stable_len > len(norm) or not norm.startswith(self._prev_norm):
            # Not a pure append (shrunk, replaced, or otherwise diverged): the
            # cached prefix is no longer provably a prefix of this text at all.
            self._stable_len = 0
            self._stable_blocks = []
        self._prev_norm = norm

        self._advance_stable_prefix(norm)

        tail = norm[self._stable_len :]
        tail_blocks, _ = _normalize_lines(tail.split("\n")) if tail else ([], [])
        return self._stable_blocks + tail_blocks

    def _advance_stable_prefix(self, norm: str) -> None:
        """Grow ``self._stable_len`` / ``self._stable_blocks`` as far as the
        newly-known tail allows, scanning only the tail (not the whole text)."""
        tail = norm[self._stable_len :]
        if not tail:
            return
        lines = tail.split("\n")
        if len(lines) <= 1:
            return  # tail is one partial line; it IS the volatile last line
        # The whole text's last line is always volatile (more characters may
        # still land on it); drop it before looking for a stability boundary.
        fixed_lines = lines[:-1]
        _, boundaries = _normalize_lines(fixed_lines)
        if not boundaries:
            return
        boundary_line = boundaries[-1]
        promoted_len = sum(len(line) + 1 for line in fixed_lines[: boundary_line + 1])
        if promoted_len <= 0:
            return
        promoted_text = tail[:promoted_len]
        promoted_blocks, _ = _normalize_lines(promoted_text.split("\n"))
        self._stable_blocks = self._stable_blocks + promoted_blocks
        self._stable_len += promoted_len
