"""Stand-in for Hermes' ``gateway.control_socket`` client (hermes-agent gateway/control_socket.py).

The scripts under test import the real module from Hermes' venv; these tests put this one first on
PYTHONPATH instead, so the scripts' own answer handling runs for real against scripted answers.

Every call is recorded in $COZY_TEST_CONTROL_LOG. $COZY_TEST_CONTROL_ANSWERS is a JSON object of
verb -> list of answers, used in order (the last one repeats); null means "no gateway answered".
Without one, each verb answers the way a running multiplexer does on success.
"""
import json
import os
from pathlib import Path


def _next_answer(verb, default):
    answers = json.loads(os.environ.get("COZY_TEST_CONTROL_ANSWERS") or "{}").get(verb)
    if answers is None:
        return default
    state = Path(os.environ["COZY_TEST_CONTROL_STATE"]) / verb
    used = int(state.read_text()) if state.exists() else 0
    state.parent.mkdir(parents=True, exist_ok=True)
    state.write_text(str(used + 1))
    return answers[min(used, len(answers) - 1)]


def _record(line):
    log = os.environ.get("COZY_TEST_CONTROL_LOG")
    if log:
        with open(log, "a") as handle:
            handle.write(line + "\n")


def _served(home):
    root = Path(home) / "profiles"
    return ["default"] + sorted(p.name for p in root.iterdir() if p.is_dir()) if root.is_dir() else ["default"]


def reload_gateway_plugins(home, *, profile_home=None, timeout=30.0):
    profile_home = Path(profile_home or home)
    env = profile_home / ".env"
    scoped = env.exists() and f"COZYGATEWAY_SPOOL_PATH={profile_home}/" in env.read_text()
    _record(f"reload-plugins {profile_home.name} env-scoped={int(scoped)}")
    return _next_answer("reload-plugins", {"reloaded": True, "home": str(profile_home)})


def rescan_gateway_profiles(home, *, timeout=8.0):
    _record("rescan-profiles")
    return _next_answer("rescan-profiles", {"multiplex": True, "added": [], "removed": [], "rescanned": [],
                                            "served_profiles": _served(home)})


def request_unserve_profile(home, name):
    _record(f"unserve-profile {name} dir-present={int((Path(home) / 'profiles' / name).is_dir())}")
    return _next_answer("unserve-profile", {"unserved": name, "served_profiles": _served(home)})
