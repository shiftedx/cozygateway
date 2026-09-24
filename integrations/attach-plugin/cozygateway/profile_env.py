"""Read this plugin's settings for the Hermes profile that owns the current call.

A standalone Hermes gateway IS its profile: its process env is that profile's ``.env``, so a plain
``os.getenv`` is right, and it stays the contract whenever no profile scope is bound.

A multiplexed Hermes gateway (``gateway.multiplex_profiles: true``) serves every profile from ONE
process whose env is the launch profile's. A secondary profile's ``.env`` never enters
``os.environ``: Hermes binds it around that profile's config load, adapter creation, connect and
turns (``gateway/run.py::_profile_runtime_scope``) as a context-local home override
(``hermes_constants.set_hermes_home_override``) plus a secret scope built from ``<home>/.env``
(``agent.secret_scope.set_secret_scope``). Hermes' built-in platforms read their credentials
through that scope (``gateway/config.py::_getenv``); these helpers are the same read for this
plugin. Inside a scope a missing key is missing: it never falls back to the process env, which on a
multiplexed gateway holds another profile's token.

The Hermes imports are lazy and optional so the package stays importable with no harness.
"""

from __future__ import annotations

import logging
import os
from typing import Optional

logger = logging.getLogger(__name__)


def scope_bound() -> bool:
    """True while Hermes has a profile secret scope bound for this call."""
    try:
        from agent.secret_scope import current_secret_scope  # harness-defined identifier
    except Exception:  # noqa: BLE001 - no harness: nothing can be bound
        return False
    return current_secret_scope() is not None


def multiplex_active() -> bool:
    """True inside a multiplexing Hermes gateway process."""
    try:
        from agent.secret_scope import is_multiplex_active  # harness-defined identifier
    except Exception:  # noqa: BLE001 - no harness: a standalone process
        return False
    return is_multiplex_active()


def profile_env(name: str, default: Optional[str] = None) -> Optional[str]:
    """``name`` for the owning profile: the bound scope when there is one, else ``os.getenv``.

    A multiplexer with no scope bound has no owning profile to read for, and its ``os.environ`` is
    the launch profile's: that read fails closed (Hermes' own ``get_secret`` raises there). The
    launch profile's adapter, which Hermes builds unscoped, gets its settings from the
    PlatformConfig seeded under its own scope instead (``adapter._env_enablement``).
    """
    if scope_bound():
        from agent.secret_scope import get_secret  # harness-defined identifier

        return get_secret(name, default)
    if multiplex_active():
        logger.debug("attach: %s read with no profile scope on a multiplexed gateway; treated as unset", name)
        return default
    return os.getenv(name, default)


def scoped_home() -> Optional[str]:
    """The owning profile's home when Hermes bound one for this call, else ``None``."""
    try:
        from hermes_constants import get_hermes_home_override  # harness-defined identifier
    except Exception:  # noqa: BLE001 - no harness, or a stand-in without the override
        return None
    return get_hermes_home_override()


def serves_routed_profile() -> bool:
    """Hermes' own answer to "does this call run for a profile other than the process's own?"
    (always on a multiplexer). A scope bound for the process's own home, as cron binds one on a
    standalone gateway, is not routed."""
    try:
        from agent.secret_scope import serves_routed_profile as routed  # harness-defined identifier
    except Exception:  # noqa: BLE001 - no harness: nothing is routed
        return False
    return routed()


def owning_home() -> Optional[str]:
    """The owning profile's home as Hermes bound it: the home override, else the home the bound
    secret scope was built for, else (unscoped on a multiplexer) the launch profile's own home."""
    home = scoped_home()
    if home:
        return home
    try:
        from agent.secret_scope import current_secret_scope_home  # harness-defined identifier
        from hermes_constants import get_process_hermes_home  # harness-defined identifier
    except Exception:  # noqa: BLE001 - no harness
        return None
    bound = current_secret_scope_home()
    if bound:
        return bound
    return str(get_process_hermes_home()) if multiplex_active() else None


def profile_home() -> str:
    """The owning profile's home: the bound override, else ``$HERMES_HOME`` ("" when unset)."""
    return (scoped_home() or os.getenv("HERMES_HOME") or "").strip()


def profile_name_for_home(home: Optional[str]) -> str:
    """``<name>`` for a ``.../profiles/<name>`` home; "" for the root/default home or none."""
    if not home:
        return ""
    parent, name = os.path.split(os.path.normpath(home))
    return name if os.path.basename(parent) == "profiles" and name else ""
