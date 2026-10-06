"""Equivalence + cost tests for incremental block normalization (issue #6).

The reference attach plugin re-normalizes the ENTIRE accumulated reply on every
draft flush (``cozygateway.adapter.send_draft`` calling
``normalize_text_to_blocks(content)`` with the full accumulated text each time),
which costs O(n^2) total over a long streaming reply. ``IncrementalNormalizer``
caches the stable already-normalized prefix and re-normalizes only the tail that
can still change.

The equivalence bar is strict: for ANY chunk sequence, the block list produced by
``IncrementalNormalizer.update`` at every single flush must be IDENTICAL to what
``normalize_text_to_blocks`` (full re-normalization) produces on the same
accumulated text -- including the case where a trailing block changes kind as
more text arrives (e.g. a "|"-line that is only recognized as a table header once
its separator row shows up, or an unterminated code fence that later closes).

Run with:
    cd integrations/attach-plugin && python3 -m unittest discover -s tests -v
"""

import random
import unittest
from typing import List

from cozygateway import text_blocks
from cozygateway.text_blocks import IncrementalNormalizer, normalize_text_to_blocks

# ---------------------------------------------------------------------------
# Fixture transcripts. Each exercises a different construct, including the
# "trailing block changes kind" edge cases called out in the brief: a
# table-header line that is ambiguous until its separator row arrives, an
# unterminated code fence that later closes, an unterminated fence that never
# closes, unterminated display math, a near-fence-marker ("``" not yet "```"),
# and a lone "|"-row that never actually becomes a table.
# ---------------------------------------------------------------------------

FIXTURES = {
    "table_header_becomes_table": (
        "Intro line.\n\n"
        "| a | b |\n"
        "|---|---|\n"
        "| 1 | 2 |\n\n"
        "After table text.\n"
    ),
    "mixed_everything": (
        "# Heading\n\n"
        "Some paragraph text\n"
        "spanning two lines.\n\n"
        "- item one\n"
        "- item two\n\n"
        "1. first\n"
        "2. second\n\n"
        "```python\n"
        "print(1)\n"
        "```\n\n"
        "After code.\n\n"
        "| x | y |\n"
        "|---|---|\n"
        "| 1 | 2 |\n\n"
        "## Second heading\n\n"
        "Final paragraph.\n"
    ),
    "fence_closes_later": (
        "before fence\n\n"
        "```python\n"
        "def f():\n"
        "    pass\n"
        "```\n\n"
        "after fence\n"
    ),
    "fence_never_closes": (
        "unterminated fence:\n\n"
        "```python\n"
        "def f():\n"
        "    pass\n"
    ),
    "math_block": (
        "$$\n"
        "a^2 + b^2 = c^2\n"
        "$$\n\n"
        "After math.\n"
    ),
    "math_never_closes": (
        "before math\n\n"
        "$$\n"
        "a^2 + b^2\n"
    ),
    "list_then_paragraph": (
        "para one\n\n"
        "para two continues\n"
        "across lines\n\n"
        "- [ ] todo\n"
        "- [x] done\n\n"
        "trailing paragraph\n"
    ),
    "near_fence_marker_not_a_fence": "Almost a fence ``, not quite.\n\nMore text.\n",
    "lone_pipe_row_never_a_table": "trailing partial table row: | a | b\n\nMore text after.\n",
    "no_blank_lines_at_all": "one giant paragraph with no breaks anywhere in it at all",
    "ends_mid_word_no_trailing_newline": "para one\n\npara two starts and cuts off mid-w",
    "ordered_list_task_items": (
        "1. [ ] first\n"
        "2. [x] second\n"
        "3. plain third\n\n"
        "done\n"
    ),
}


def _assert_streaming_equivalence(
    case: unittest.TestCase, text: str, chunks: List[str]
) -> None:
    """Feed ``chunks`` into a fresh ``IncrementalNormalizer`` and assert every
    single flush matches full re-normalization of the accumulated text so far."""
    normalizer = IncrementalNormalizer()
    accumulated = ""
    for chunk in chunks:
        accumulated += chunk
        incremental = normalizer.update(accumulated)
        full = normalize_text_to_blocks(accumulated)
        case.assertEqual(
            incremental,
            full,
            msg=f"mismatch at accumulated={accumulated!r} (full text={text!r})",
        )
    # The reassembled text must equal the original (chunking sanity check).
    case.assertEqual(accumulated, text)


def _every_two_way_split(text: str) -> List[List[str]]:
    """Every possible single split point: [text[:i], text[i:]] for all i."""
    return [[text[:i], text[i:]] for i in range(len(text) + 1)]


def _char_by_char(text: str) -> List[str]:
    return list(text)


def _fixed_chunks(text: str, size: int) -> List[str]:
    return [text[i : i + size] for i in range(0, len(text), size)] or [""]


def _random_chunks(text: str, seed: int) -> List[str]:
    rng = random.Random(seed)
    chunks = []
    i = 0
    n = len(text)
    while i < n:
        size = rng.randint(1, 7)
        chunks.append(text[i : i + size])
        i += size
    return chunks


class EquivalenceAcrossAdversarialChunkingsTests(unittest.TestCase):
    """(a) Equivalence property test: incremental vs full re-normalization,
    flush-by-flush, across many fixture transcripts and adversarial chunkings,
    including split boundaries at every character position."""

    def test_every_two_way_split_of_every_fixture(self):
        for name, text in FIXTURES.items():
            for chunks in _every_two_way_split(text):
                with self.subTest(fixture=name, split=len(chunks[0])):
                    _assert_streaming_equivalence(self, text, chunks)

    def test_char_by_char_streaming_of_every_fixture(self):
        for name, text in FIXTURES.items():
            with self.subTest(fixture=name):
                _assert_streaming_equivalence(self, text, _char_by_char(text))

    def test_fixed_size_chunkings_of_every_fixture(self):
        for name, text in FIXTURES.items():
            for size in (2, 3, 5, 8, 13):
                with self.subTest(fixture=name, size=size):
                    _assert_streaming_equivalence(self, text, _fixed_chunks(text, size))

    def test_random_chunkings_of_every_fixture(self):
        for name, text in FIXTURES.items():
            for seed in range(10):
                with self.subTest(fixture=name, seed=seed):
                    _assert_streaming_equivalence(self, text, _random_chunks(text, seed))

    def test_single_flush_of_the_whole_text_at_once(self):
        # The degenerate one-flush case: no incremental advantage, but must
        # still match exactly (equivalent to calling normalize_text_to_blocks
        # once).
        for name, text in FIXTURES.items():
            with self.subTest(fixture=name):
                _assert_streaming_equivalence(self, text, [text])

    def test_empty_text_never_crashes_and_matches(self):
        normalizer = IncrementalNormalizer()
        self.assertEqual(normalizer.update(""), normalize_text_to_blocks(""))


class NonAppendFallbackTests(unittest.TestCase):
    """The terminal ``send()`` path may hand the normalizer a final_text that is
    not a pure append of the last streamed buffer (e.g. the harness rewrites the
    tail). The cache must detect this and fall back to a correct full
    re-normalization rather than silently trusting a stale prefix."""

    def test_shrinking_text_falls_back_correctly(self):
        normalizer = IncrementalNormalizer()
        long_text = "para one\n\npara two\n\npara three\n"
        normalizer.update(long_text)
        shorter = "totally different, shorter text\n"
        result = normalizer.update(shorter)
        self.assertEqual(result, normalize_text_to_blocks(shorter))

    def test_diverging_text_falls_back_correctly(self):
        normalizer = IncrementalNormalizer()
        normalizer.update("para one\n\npara two\n")
        diverged = "para one\n\nBUT THIS PARAGRAPH IS DIFFERENT NOW\n"
        result = normalizer.update(diverged)
        self.assertEqual(result, normalize_text_to_blocks(diverged))

    def test_repeated_identical_flush_is_a_cheap_no_op(self):
        normalizer = IncrementalNormalizer()
        text = "para one\n\npara two\n"
        first = normalizer.update(text)
        second = normalizer.update(text)  # duplicate flush, nothing new
        self.assertEqual(first, second)
        self.assertEqual(second, normalize_text_to_blocks(text))


class CostDoesNotScaleWithTotalLengthTests(unittest.TestCase):
    """(b) Cost evidence: per-flush normalization work stays proportional to
    newly arrived content, not to the total accumulated length.

    Instruments ``text_blocks._normalize_lines`` (the single shared dispatch
    loop every code path funnels through -- both the plain full-normalize
    function and every internal call ``IncrementalNormalizer`` makes) and sums
    the total input size processed across an entire long synthetic stream. The
    old O(n^2) behavior (re-normalizing the full accumulated text on every
    flush) would make that sum scale with n^2; the incremental cache keeps it
    within a small constant multiple of n.
    """

    def _run_stream(self, text: str, chunk_size: int):
        """Stream ``text`` in fixed-size chunks through a fresh
        IncrementalNormalizer, counting total characters handed to
        ``_normalize_lines`` across the whole run."""
        original = text_blocks._normalize_lines
        processed_chars = {"total": 0, "max_call": 0}

        def counting_normalize_lines(lines):
            size = sum(len(line) for line in lines)
            processed_chars["total"] += size
            processed_chars["max_call"] = max(processed_chars["max_call"], size)
            return original(lines)

        normalizer = IncrementalNormalizer()
        accumulated = ""
        text_blocks._normalize_lines = counting_normalize_lines
        try:
            for i in range(0, len(text), chunk_size):
                accumulated += text[i : i + chunk_size]
                blocks = normalizer.update(accumulated)
                # Correctness must hold at every flush along the way too.
                self.assertEqual(blocks, original(accumulated.split("\n"))[0])
        finally:
            text_blocks._normalize_lines = original
        return processed_chars["total"], processed_chars["max_call"], len(accumulated)

    def test_total_processed_chars_is_linear_not_quadratic(self):
        # 400 short paragraphs separated by blank lines: a realistic long
        # streaming reply shape with periodic stability points.
        paragraph = "This is one streamed paragraph of a reply, several words long."
        text = ("\n\n".join(paragraph for _ in range(400))) + "\n"
        n = len(text)
        self.assertGreater(n, 20_000)  # sanity: this is a genuinely long reply

        total_processed, max_call, streamed_len = self._run_stream(text, chunk_size=17)
        self.assertEqual(streamed_len, n)

        # The old O(n^2) implementation re-normalizes the FULL accumulated text
        # on every flush: for m flushes of a length-n text, total processed
        # chars is on the order of m * n / 2. With chunk_size=17 there are
        # roughly n/17 flushes, so the old behavior would process on the
        # order of (n/17) * (n/2) chars -- tens of millions for this fixture.
        # The incremental cache should stay within a small constant multiple
        # of n itself (each character is touched O(1) times on average).
        quadratic_floor = (n // 17) * (n // 2)
        self.assertLess(total_processed, 20 * n)
        self.assertLess(total_processed, quadratic_floor // 100)

    def test_no_single_flush_processes_the_whole_accumulated_text(self):
        # Once the stream is well underway, no single flush's underlying
        # normalization work should be anywhere near the total length so far --
        # that would indicate a full re-normalization snuck back in.
        paragraph = "Another short paragraph, streamed one small piece at a time."
        text = ("\n\n".join(paragraph for _ in range(300))) + "\n"
        _total, max_call, streamed_len = self._run_stream(text, chunk_size=11)
        self.assertLess(max_call, streamed_len // 4)

    def test_repeated_no_op_flushes_cost_nothing(self):
        # A trailing blank line seals the final paragraph too (its own blank
        # line is not the text's last line), so the whole text becomes stable
        # and the tail is empty after the first call.
        original = text_blocks._normalize_lines
        text = "para one\n\npara two\n\npara three\n\n"
        normalizer = IncrementalNormalizer()
        first = normalizer.update(text)  # prime the cache
        self.assertEqual(normalizer._stable_len, len(text))  # fully stabilized

        processed_chars = {"total": 0}

        def counting_normalize_lines(lines):
            processed_chars["total"] += sum(len(line) for line in lines)
            return original(lines)

        text_blocks._normalize_lines = counting_normalize_lines
        try:
            for _ in range(50):
                repeat = normalizer.update(text)
                self.assertEqual(repeat, first)
        finally:
            text_blocks._normalize_lines = original

        # The tail is empty on every one of the 50 repeats, so none of them
        # should call into the dispatch loop at all.
        self.assertEqual(processed_chars["total"], 0)

    def test_repeated_flush_with_an_open_tail_stays_bounded_by_tail_size(self):
        # When the trailing content is NOT yet sealed by a blank line (the
        # realistic in-progress-paragraph case), repeated identical flushes
        # still cost something (the tail must be re-checked), but that cost is
        # bounded by the tail's own size, not the whole accumulated text -- and
        # it must not grow across repeats since the text is not growing.
        original = text_blocks._normalize_lines
        paragraphs = [f"paragraph number {i} with some words in it" for i in range(200)]
        text = (
            "\n\n".join(paragraphs)
            + "\n\nfinal unsealed line without a trailing blank, still open"
        )
        normalizer = IncrementalNormalizer()
        normalizer.update(text)  # prime the cache
        tail_len_after_priming = len(text) - normalizer._stable_len

        processed_chars = {"total": 0}

        def counting_normalize_lines(lines):
            processed_chars["total"] += sum(len(line) for line in lines)
            return original(lines)

        text_blocks._normalize_lines = counting_normalize_lines
        try:
            for _ in range(20):
                normalizer.update(text)
        finally:
            text_blocks._normalize_lines = original

        # Per repeat, cost is a small constant multiple of the unstable tail
        # (not of the whole accumulated text, which is far larger here).
        self.assertLess(processed_chars["total"], 20 * tail_len_after_priming * 4)
        self.assertLess(tail_len_after_priming, len(text) // 4)


class StableBoundaryHelpersTests(unittest.TestCase):
    """Direct unit coverage of the shared dispatch's boundary reporting."""

    def test_normalize_lines_reports_top_level_blank_boundaries(self):
        lines = "a\n\nb\nc\n\nd".split("\n")
        blocks, boundaries = text_blocks._normalize_lines(lines)
        # lines = ["a", "", "b", "c", "", "d"]; blanks at index 1 and 4.
        self.assertEqual(boundaries, [1, 4])
        self.assertEqual(
            [getattr(b, "text", None) for b in blocks], ["a", "b\nc", "d"]
        )

    def test_blank_line_inside_open_fence_is_not_a_boundary(self):
        lines = "```\ncode line one\n\ncode line two\n```\n\nafter\n".split("\n")
        _blocks, boundaries = text_blocks._normalize_lines(lines)
        # The only top-level blank is the one AFTER the fence closes.
        # lines: 0 "```" 1 "code line one" 2 "" (inside fence body) 3 "code line two"
        #        4 "```" 5 "" (top level, after fence) 6 "after" 7 ""
        self.assertNotIn(2, boundaries)
        self.assertIn(5, boundaries)

    def test_blank_line_inside_open_math_is_not_a_boundary(self):
        lines = "$$\na\n\nb\n$$\n\nafter\n".split("\n")
        _blocks, boundaries = text_blocks._normalize_lines(lines)
        self.assertNotIn(2, boundaries)
        self.assertIn(5, boundaries)


if __name__ == "__main__":
    unittest.main()
