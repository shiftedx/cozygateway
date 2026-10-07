"""Pure policy checks for Darwin OS aliases; no native symlink coverage is implied."""
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from cozygateway.private_files import _is_darwin_system_alias


class DarwinSystemAliasPolicyTests(unittest.TestCase):
    def _allowed(self, candidate, target, *, leaf=None, owner=0, platform="darwin"):
        candidate = Path(candidate)
        leaf = Path(leaf) if leaf is not None else candidate / "child"
        with patch("cozygateway.private_files.sys.platform", platform), patch.object(Path, "resolve", return_value=Path(target)):
            return _is_darwin_system_alias(candidate, SimpleNamespace(st_uid=owner), leaf)

    def test_only_exact_root_owned_darwin_ancestor_aliases_are_allowed(self):
        for name in ("var", "tmp", "etc"):
            with self.subTest(name=name):
                self.assertTrue(self._allowed("/" + name, "/private/" + name))

    def test_selected_leaf_user_owner_and_wrong_target_are_rejected(self):
        self.assertFalse(self._allowed("/var", "/private/var", leaf="/var"))
        self.assertFalse(self._allowed("/var", "/private/var", owner=501))
        self.assertFalse(self._allowed("/var", "/private/other"))
        self.assertFalse(self._allowed("/home/var", "/private/var"))
        self.assertFalse(self._allowed("/private", "/private/private"))

    def test_same_alias_observations_are_rejected_outside_darwin(self):
        for platform in ("win32", "linux"):
            with self.subTest(platform=platform):
                self.assertFalse(self._allowed("/var", "/private/var", platform=platform))


if __name__ == "__main__":
    unittest.main()
