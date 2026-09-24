# shellcheck shell=bash
# Sourced by provision-bot.sh, bot-provisioner-watch.sh, deprovision-bot.sh and
# deploy-plugin-local.sh: is this Hermes ONE multiplexed host gateway, and how
# does a profile it serves get picked up?
#
# One Hermes gateway per host can serve every profile: the default profile's,
# with `gateway.multiplex_profiles: true` in the root config.yaml (the key
# Hermes itself writes once it multiplexes, hermes_cli/gateway_multiplex_mode.py
# `persist_resolved_default`). A profile it serves has no `ai.hermes.gateway-<p>`
# job, and Hermes refuses `hermes -p <p> gateway start|stop|restart|install` for
# it with exit 78. A profile whose own config.yaml says `gateway.standalone:
# true` opted out and keeps its own gateway exactly as before.
#
# The host picks a served profile up through Hermes' own control verbs on its
# socket (gateway/control_socket.py):
#   * `reload-plugins` for that profile's home forces the plugin rediscovery the
#     host's 30-second reconcile never does on its own, so it must come BEFORE the
#     profile's .env or config.yaml is written: the reconcile rebuilds a profile's
#     adapters only when one of those two files changed after it last looked;
#   * `rescan-profiles` then runs that reconcile now instead of within 30 s.
# A LIVE adapter keeps the plugin code it was built with, so new plugin code for
# a profile that is already attached needs the host restarted:
# `hermes -p default gateway restart`, the verb Hermes names for a served profile.
#
# Needs PYTHON (Hermes' venv interpreter where there is one), HERMES_HOME_ROOT
# and, for host_restart, HERMES_BIN.

HOST_PROFILE=default
_HOST_MULTIPLEXES=""

# Prints `true` or `false` for a boolean Hermes config key, or nothing when the
# key is unset or the file is not simple enough to be sure (the caller then keeps
# the single-gateway path it always took). With several keys the first present
# wins, which is Hermes' own precedence for `multiplex_profiles`. PyYAML answers
# exactly when the interpreter has it; otherwise a conservative stdlib probe does.
hermes_config_bool() {
  "$PYTHON" - --hermes-config-bool "$@" <<'PY' | tr -d '\r'
import re
import sys
from pathlib import Path

TRUE = {"true", "yes", "on", "1"}
FALSE = {"false", "no", "off", "0"}
KEY = re.compile(r"^(?P<indent> *)(?P<key>[A-Za-z0-9_][A-Za-z0-9_.\-]*):(?:[ \t]+(?P<value>.*))?$")


def verdict(value):
    if isinstance(value, bool) or isinstance(value, int):
        return "true" if value else "false"
    if isinstance(value, str):
        token = value.strip().lower()
        return "true" if token in TRUE else "false" if token in FALSE else ""
    return ""


def with_yaml(text, yaml, paths):
    data = yaml.safe_load(text)
    for path in paths:
        node = data
        for segment in path:
            node = node.get(segment) if isinstance(node, dict) else None
        if node is not None:
            return verdict(node)
    return ""


def scalar(raw):
    value = re.split(r"[ \t]#", raw, maxsplit=1)[0].strip()
    if len(value) >= 2 and value[0] in "\"'" and value[-1] == value[0]:
        return value[1:-1]
    if not value or value[0] in "&*!|>[{%@`\"'#":
        raise ValueError("not a plain scalar")
    return value


def without_yaml(text, paths):
    """Top-level and one-level block mappings only. Anything that could hide a
    wanted key (a flow mapping, an anchor, a tag, a sequence, a line this cannot
    parse, a tab, a second document) raises, and the answer is then unknown."""
    wanted = set(paths)
    sections = {path[0] for path in paths if len(path) == 2}
    found = {}
    section = child_indent = None
    for raw in text.splitlines():
        line = raw.rstrip()
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        leading = line[: len(line) - len(line.lstrip())]
        if "\t" in leading or stripped.startswith(("---", "...", "%")):
            raise ValueError("unsupported layout")
        match = KEY.match(line)
        if not leading:
            section = child_indent = None
            if match is None:
                raise ValueError("unparsed top-level line")
            key, value = match.group("key"), match.group("value") or ""
            if (key,) in wanted:
                found[(key,)] = scalar(value)
            elif key in sections:
                if re.split(r"(?:^|[ \t])#", value, maxsplit=1)[0].strip():
                    raise ValueError("inline section")
                section = key
            continue
        if section is None:
            continue
        if child_indent is None:
            child_indent = len(leading)
        if len(leading) > child_indent:
            continue
        if len(leading) < child_indent or match is None:
            raise ValueError("unparsed section line")
        if (section, match.group("key")) in wanted:
            found[(section, match.group("key"))] = scalar(match.group("value") or "")
    for path in paths:
        if path in found:
            return verdict(found[path])
    return ""


def main():
    try:
        text = Path(sys.argv[2]).read_text(encoding="utf-8")
    except Exception:
        return
    paths = [tuple(arg.split(".")) for arg in sys.argv[3:]]
    try:
        import yaml
    except ImportError:
        yaml = None
    try:
        answer = with_yaml(text, yaml, paths) if yaml is not None else without_yaml(text, paths)
    except Exception:
        answer = ""
    sys.stdout.write(answer)


main()
PY
}

host_multiplexes() {
  if [ -z "$_HOST_MULTIPLEXES" ]; then
    _HOST_MULTIPLEXES=0
    [ "$(hermes_config_bool "$HERMES_HOME_ROOT/config.yaml" multiplex_profiles gateway.multiplex_profiles)" != true ] \
      || _HOST_MULTIPLEXES=1
  fi
  [ "$_HOST_MULTIPLEXES" = 1 ]
}

# True when the multiplexed host serves this profile. The default profile IS the
# host. Only `gateway.standalone` in the profile's own config opts it out.
served_by_host() {
  local profile="$1"
  host_multiplexes || return 1
  [ "$profile" = "$HOST_PROFILE" ] && return 0
  [ "$(hermes_config_bool "$HERMES_HOME_ROOT/profiles/$profile/config.yaml" gateway.standalone)" != true ]
}

# One Hermes control verb on the host's socket: `reload-plugins <profile>` or
# `rescan-profiles`. Succeeds only when the running host answered it; a caller
# falls back to host_restart otherwise (no host running, or one predating the verb).
host_control() {
  HERMES_HOME="$HERMES_HOME_ROOT" "$PYTHON" - --hermes-control "$HERMES_HOME_ROOT" "$@" <<'PY' >/dev/null 2>&1
import sys
from pathlib import Path

root, verb = Path(sys.argv[2]), sys.argv[3]
try:
    from gateway import control_socket
except Exception:
    sys.exit(3)
if verb == "reload-plugins":
    answer = control_socket.reload_gateway_plugins(root, profile_home=root / "profiles" / sys.argv[4])
    sys.exit(0 if isinstance(answer, dict) and answer.get("reloaded") else 1)
if verb == "rescan-profiles":
    answer = control_socket.rescan_gateway_profiles(root)
    sys.exit(0 if isinstance(answer, dict) and answer.get("multiplex") is not False
             and "served_profiles" in answer and not answer.get("pending") else 1)
if verb == "unserve-profile":
    answer = control_socket.request_unserve_profile(root, sys.argv[4])
    sys.exit(0 if isinstance(answer, dict) and "error" not in answer else 1)
sys.exit(2)
PY
}

host_restart() { "$HERMES_BIN" -p "$HOST_PROFILE" gateway restart; }
