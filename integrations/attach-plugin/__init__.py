"""Hermes directory-plugin entry point.

Keeping the implementation in the ``cozygateway`` package makes it independently testable, while
this root shim lets the checked-in directory itself satisfy Hermes' plugin loader contract.
"""

from .cozygateway.adapter import register

__all__ = ["register"]
