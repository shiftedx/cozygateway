"""Export the reference normalizer's fixture outputs as cross-language parity vectors.

Serializes ``{name: {"text": text, "blocks": [block-as-dict, ...]}}`` for every fixture in
``tests.test_text_blocks_incremental.FIXTURES`` to
``packages/gateway/test/fixtures/markdown-blocks-vectors.json``, so the TypeScript port
(``packages/gateway/src/markdown-blocks.ts``) can assert byte-identical parity with the Python
reference (``cozygateway.text_blocks.normalize_text_to_blocks``).

Run with ``--write`` to regenerate the vectors file after a fixture or normalizer change:
    python3 -m tests.test_export_vectors --write

Without ``--write``, running under ``unittest`` asserts the on-disk file is still in sync (the
gate that catches vector drift).
"""

import json
import sys
import pathlib
import unittest

from cozygateway.text_blocks import normalize_text_to_blocks
from tests.test_text_blocks_incremental import FIXTURES

VECTORS = (
    pathlib.Path(__file__).resolve().parents[3] / "packages/gateway/test/fixtures/markdown-blocks-vectors.json"
)


def block_to_dict(b):
    """Each reference block dataclass already carries a ``to_wire()`` that produces exactly
    the contract JSON shape (``type`` plus its fields, optional fields omitted when absent).
    Delegate to it rather than re-transcribing the mapping a second time here."""
    return b.to_wire()


def build():
    return {
        name: {"text": text, "blocks": [block_to_dict(b) for b in normalize_text_to_blocks(text)]}
        for name, text in sorted(FIXTURES.items())
    }


class VectorsInSyncTests(unittest.TestCase):
    def test_vectors_in_sync(self):
        current = json.loads(VECTORS.read_text())
        self.assertEqual(current, build(), "vectors drifted; run: python3 -m tests.test_export_vectors --write")


if __name__ == "__main__":
    if "--write" in sys.argv:
        VECTORS.parent.mkdir(parents=True, exist_ok=True)
        VECTORS.write_text(json.dumps(build(), indent=2, ensure_ascii=False) + "\n")
    else:
        unittest.main()
