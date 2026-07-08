# attach-plugin tests

Standard library only (`unittest`); no pytest, no new dependencies. The plugin's
harness imports are all lazy (inside methods, see `adapter.py`'s module docstring),
so the package under test imports cleanly with no harness and no `websockets`
installed.

Run the whole suite from `integrations/attach-plugin/`:

    python3 -m unittest discover -s tests -v

Run a single file:

    python3 -m unittest tests.test_seen_turns_bounded -v
