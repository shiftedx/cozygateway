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
    """
    if not text:
        return []

    lines = re.sub(r"\r\n?", "\n", text).split("\n")
    blocks: List[RichBlock] = []
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

        # Blank line: paragraph boundary.
        if line.strip() == "":
            flush_paragraph()
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
    return blocks


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
