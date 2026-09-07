# attach-plugin tests

Standard library only (`unittest`); no pytest, no new dependencies. The plugin's
harness imports are all lazy (inside methods, see `adapter.py`'s module docstring),
so the package under test imports cleanly with no harness and no `websockets`
installed.

The one host requirement is an interpreter that has `websockets`, which the plugin's client
imports at module load. Hermes' own venv python always does; a bare system python3 collects
13 import errors instead. Run the whole suite from `integrations/attach-plugin/` with that
interpreter:

    <hermes root>/hermes-agent/venv/bin/python -m unittest discover -s tests -v

Run a single file:

    python3 -m unittest tests.test_seen_turns_bounded -v
