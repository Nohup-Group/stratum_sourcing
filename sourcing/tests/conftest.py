"""Test-suite wiring.

The DB-backed tests point the app at TEST_DATABASE_URL — never at DATABASE_URL
— so a stray run cannot write to production, and they skip when it is unset:

    createdb stratum_sourcing_test
    TEST_DATABASE_URL=postgresql+asyncpg://localhost/stratum_sourcing_test \\
        .venv/bin/python -m pytest

This must happen before anything imports app.config, which reads DATABASE_URL
at import time. conftest is imported ahead of the test modules, so it does.
"""

from __future__ import annotations

import os

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL", "")

if TEST_DATABASE_URL:
    os.environ["DATABASE_URL"] = TEST_DATABASE_URL
