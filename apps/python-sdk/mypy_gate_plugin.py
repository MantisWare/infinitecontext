"""Fail fast when mypy is invoked from a non-3.8 interpreter."""

from __future__ import annotations

import sys
from typing import Callable, Type

from mypy.plugin import Plugin


def _require_python38() -> None:
    major, minor = sys.version_info[:2]
    if (major, minor) != (3, 8):
        print(
            "error: infinitecontext SDK mypy must run on Python 3.8 "
            f"(this interpreter is {major}.{minor}).\n"
            "hint: from apps/python-sdk run `npm run check`, or create a 3.8 env:\n"
            "  uv venv --python 3.8 .venv && uv pip install -e '.[dev]' && .venv/bin/mypy",
            file=sys.stderr,
        )
        sys.exit(2)


class Python38GatePlugin(Plugin):
    """Mypy plugin whose import enforces a 3.8 interpreter for this package."""


def plugin(version: str) -> Type[Python38GatePlugin]:
    _require_python38()
    return Python38GatePlugin
