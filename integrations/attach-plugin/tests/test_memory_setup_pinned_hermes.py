"""Installed-Hermes integration proof for capability-42 Holographic setup.

Run with the pinned Hermes interpreter so this exercises its real config writer,
bundled Holographic provider, and SQLite store while making NumPy unavailable:

    cd integrations/attach-plugin
    ~/.hermes/hermes-agent/venv/bin/python -m unittest \
      tests.test_memory_setup_pinned_hermes -v
"""
from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


try:
    HERMES_AVAILABLE = importlib.util.find_spec("hermes_cli.config") is not None
except ModuleNotFoundError:
    HERMES_AVAILABLE = False
PLUGIN_ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(HERMES_AVAILABLE, "requires the pinned Hermes environment")
class PinnedHermesMemorySetupTests(unittest.TestCase):
    def test_holographic_setup_projects_available_without_numpy(self):
        script = textwrap.dedent(
            """
            import importlib.abc
            import sys

            class BlockNumpy(importlib.abc.MetaPathFinder):
                def find_spec(self, fullname, path=None, target=None):
                    if fullname == "numpy" or fullname.startswith("numpy."):
                        raise ModuleNotFoundError("blocked for CozyGateway integration", name=fullname)
                    return None

            sys.modules.pop("numpy", None)
            sys.meta_path.insert(0, BlockNumpy())

            from cozygateway.memory import MemoryManager

            result = MemoryManager({}, None).setup({
                "memoryEnabled": False,
                "userProfileEnabled": False,
                "holographicEnabled": True,
            })
            source = next(row for row in result["sources"] if row["id"] == "holographic")
            assert source["status"] == "available", source
            assert source["capabilities"]["create"] is True, source
            assert source["capabilities"]["relationships"] is True, source
            """
        )
        with tempfile.TemporaryDirectory() as home:
            env = dict(os.environ)
            env["HERMES_HOME"] = home
            env["PYTHONPATH"] = os.pathsep.join(
                [str(PLUGIN_ROOT), value]
                if (value := env.get("PYTHONPATH"))
                else [str(PLUGIN_ROOT)]
            )
            completed = subprocess.run(
                [sys.executable, "-c", script],
                env=env,
                text=True,
                capture_output=True,
                timeout=20,
                check=False,
            )
        self.assertEqual(completed.returncode, 0, completed.stderr or completed.stdout)


if __name__ == "__main__":
    unittest.main()
