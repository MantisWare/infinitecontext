# Contributing to the Python SDK

## Type checking (mypy)

The SDK targets **Python 3.8** at runtime (`requires-python = ">=3.8"`) and mypy is configured with `python_version = "3.8"` and `strict = true`.

**The type gate is the Python 3.8 virtualenv.** Running plain `mypy` from a 3.9+ interpreter pulls in newer site-packages (for example anyio with `match` syntax) and produces misleading errors.

Use one of:

```bash
# Monorepo check (creates/refreshes apps/python-sdk/.venv on Python 3.8)
cd apps/python-sdk && npm run check

# Manual 3.8 venv
cd apps/python-sdk
uv venv --python 3.8 .venv
uv pip install --python .venv/bin/python -e ".[dev]"
.venv/bin/mypy
```

Do **not** rely on `mypy` from a Python 3.9+ venv for this package. A small mypy plugin exits with a clear message if you try.

Both `npm run check` and `npm test` share the same **Python 3.8** `.venv` (via `uv`), so they do not overwrite each other with the system Python.

## Tests

```bash
cd apps/python-sdk
npm run check    # mypy (3.8 venv) + pytest
npm test         # pytest only (uses scripts/run-pytest.mjs)
```
