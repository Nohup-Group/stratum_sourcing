"""Nine services, one image, one database, `alembic upgrade head` on every boot.

On 2026-08-13 a deploy stamped the database at revision 007. Every service
still running the previous image then failed its next boot with
"Can't locate revision identified by '007'" and exited non-zero, which Railway
reported as "Deploy Crashed". It self-healed as each service rolled over, but
it recurs on every migration.

Three properties are locked in here:

1. a database ahead of this image is tolerated — log and skip, exit 0;
2. every OTHER migration failure is still fatal, so this is not a blanket
   `|| true` that would turn a real failure into a silent one;
3. concurrent boots cannot run DDL at the same time.

Property 2 is the one that matters most. A guard that swallows everything would
pass property 1 and leave the system worse than before.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import text

from app.database import async_session_factory, engine

REPO_ROOT = Path(__file__).resolve().parents[1]
TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL", "")

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not TEST_DATABASE_URL,
        reason="needs a scratch Postgres — set TEST_DATABASE_URL",
    ),
]


def run_alembic(*args: str, database_url: str | None = None, timeout: int = 60):
    return subprocess.run(
        [sys.executable, "-m", "alembic", *args],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=timeout,
        env={**os.environ, "DATABASE_URL": database_url or TEST_DATABASE_URL},
    )


def current_head() -> str:
    """The head revision, read at runtime.

    Hardcoding it means the day migration 008 lands, a probe migration anchored
    to 007 creates a second head, `upgrade head` dies on "Multiple head
    revisions" before the probe ever runs, and every assertion below passes for
    the wrong reason — a gate that silently stops testing anything.
    """
    heads = run_alembic("heads").stdout.split()
    assert heads, "could not determine the alembic head"
    return heads[0]


def psql(database: str, sql: str) -> str:
    return subprocess.run(
        ["psql", database, "-tAc", sql], capture_output=True, text=True, check=True
    ).stdout.strip()


@pytest.fixture
def fresh_database():
    """An EMPTY database.

    Every migration test used to run against the already-migrated scratch DB,
    where `upgrade head` has nothing to do and therefore proves nothing. That
    is exactly how a change that broke migrating from 005 to 006 passed a suite
    of four migration tests.
    """
    name = "sourcing_migration_gate"
    subprocess.run(["dropdb", "--if-exists", name], check=True, capture_output=True)
    subprocess.run(["createdb", name], check=True, capture_output=True)
    base = TEST_DATABASE_URL.rpartition("/")[0]
    try:
        yield name, f"{base}/{name}"
    finally:
        subprocess.run(["dropdb", "--if-exists", name], check=True, capture_output=True)


def test_an_empty_database_migrates_all_the_way_up(fresh_database) -> None:
    name, url = fresh_database

    result = run_alembic("upgrade", "head", database_url=url, timeout=180)
    assert result.returncode == 0, f"a fresh database must migrate:\n{result.stderr}"

    heads = run_alembic("heads", database_url=url).stdout.split()
    assert psql(name, "SELECT version_num FROM alembic_version") == heads[0]
    # Proof that the late migrations really ran, not just that the stamp moved:
    # 006 adds these four columns, 007 widens role_hint.
    assert psql(
        name,
        "SELECT count(*) FROM information_schema.columns WHERE table_name='entities' "
        "AND column_name IN ('domain','registry_id','is_eligible','gate')",
    ) == "4"
    assert psql(
        name,
        "SELECT data_type FROM information_schema.columns "
        "WHERE table_name='entity_mentions' AND column_name='role_hint'",
    ) == "text"


def test_a_migration_that_fails_partway_leaves_nothing_behind(fresh_database) -> None:
    """Migrations must stay atomic.

    If a migration's DDL commits while its revision does not advance, the next
    boot re-runs it and fails on the duplicate forever — on all nine services.
    """
    name, url = fresh_database
    assert run_alembic("upgrade", "head", database_url=url, timeout=180).returncode == 0
    before = psql(name, "SELECT version_num FROM alembic_version")

    head = current_head()
    partial = REPO_ROOT / "alembic" / "versions" / "998_partial_for_test.py"
    partial.write_text(
        '"""Adds a column then raises, to prove migrations roll back.\n\n'
        f'Revision ID: 998_partial\nRevises: {head}\n"""\n\n'
        "import sqlalchemy as sa\nfrom alembic import op\n\n"
        'revision = "998_partial"\n'
        f'down_revision = "{head}"\n'
        "branch_labels = None\ndepends_on = None\n\n\n"
        "def upgrade() -> None:\n"
        '    op.add_column("entities", sa.Column("probe_col", sa.Text()))\n'
        '    raise RuntimeError("probe: fails after its DDL")\n\n\n'
        "def downgrade() -> None:\n    pass\n"
    )
    try:
        result = run_alembic("upgrade", "head", database_url=url, timeout=180)
        assert result.returncode != 0
        assert psql(
            name,
            "SELECT count(*) FROM information_schema.columns "
            "WHERE table_name='entities' AND column_name='probe_col'",
        ) == "0", "the failed migration's DDL was committed"
        assert psql(name, "SELECT version_num FROM alembic_version") == before
    finally:
        partial.unlink()


def test_a_database_ahead_of_this_image_is_not_a_crash(fresh_database) -> None:
    name, url = fresh_database
    assert run_alembic("upgrade", "head", database_url=url, timeout=180).returncode == 0
    # A revision no image will ever contain — the same shape as an old
    # container meeting a revision a newer peer just applied.
    psql(name, "UPDATE alembic_version SET version_num = '999_from_the_future'")

    result = run_alembic("upgrade", "head", database_url=url)

    assert result.returncode == 0, f"boot must not crash:\n{result.stderr}"
    assert "999_from_the_future" in result.stderr + result.stdout
    assert "skipping" in (result.stderr + result.stdout).lower()
    assert (
        psql(name, "SELECT version_num FROM alembic_version") == "999_from_the_future"
    ), "skipping must not rewrite the revision"


async def test_an_unreachable_database_is_still_fatal() -> None:
    """The guard must not have widened into 'any migration problem is fine'."""
    result = run_alembic(
        "upgrade",
        "head",
        database_url="postgresql+asyncpg://erickpg@localhost:5432/database_that_does_not_exist",
    )
    assert result.returncode != 0, "a real failure must still stop the boot"


def test_a_broken_migration_is_still_fatal(fresh_database) -> None:
    """A revision this image DOES know, whose SQL fails, must exit non-zero.

    Runs against its own database. Sharing the scratch one made this test
    depend on that database's revision: leave it stamped ahead of the image and
    the guard skips, `upgrade head` returns 0, and the test reports a failure
    that never happened.
    """
    name, url = fresh_database
    assert run_alembic("upgrade", "head", database_url=url, timeout=180).returncode == 0
    head = current_head()
    broken = REPO_ROOT / "alembic" / "versions" / "999_broken_for_test.py"
    broken.write_text(
        '"""Deliberately broken migration used by tests.\n\n'
        f'Revision ID: 999_broken\nRevises: {head}\n"""\n\n'
        "from alembic import op\n\n"
        'revision = "999_broken"\n'
        f'down_revision = "{head}"\n'
        "branch_labels = None\ndepends_on = None\n\n\n"
        "def upgrade() -> None:\n"
        '    op.execute("SELECT * FROM a_table_that_does_not_exist")\n\n\n'
        "def downgrade() -> None:\n    pass\n"
    )
    try:
        result = run_alembic("upgrade", "head", database_url=url, timeout=180)
        assert result.returncode != 0, "a failing migration must stop the boot"
        output = result.stderr + result.stdout
        assert "a_table_that_does_not_exist" in output
        # And it must be the error the operator actually sees. Releasing the
        # advisory lock in a `finally` on an already-failed transaction raises,
        # and that exception becomes the top-level one — burying the real cause
        # under a pg_advisory_unlock traceback.
        tail = "\n".join(result.stderr.strip().splitlines()[-6:])
        assert "pg_advisory_unlock" not in tail, f"real cause masked by the unlock:\n{tail}"
    finally:
        broken.unlink()


async def test_the_migration_lock_serialises_concurrent_boots() -> None:
    """Hold the advisory lock, and a booting container must wait for it."""
    # alembic/env.py cannot be imported (the installed alembic package shadows
    # it, and importing would run a migration), so read the constant from the
    # source — renaming it there fails this test rather than silently
    # locking on the wrong key.
    source = (REPO_ROOT / "alembic" / "env.py").read_text()
    match = re.search(r"^MIGRATION_LOCK_KEY = (\d+)$", source, re.M)
    assert match, "MIGRATION_LOCK_KEY not found in alembic/env.py"
    MIGRATION_LOCK_KEY = int(match.group(1))

    async with async_session_factory() as holder:
        await holder.execute(
            text("SELECT pg_advisory_lock(:k)"), {"k": MIGRATION_LOCK_KEY}
        )
        # Deliberately not committed/released: the lock is session-scoped and
        # held for as long as this connection lives.
        with pytest.raises(subprocess.TimeoutExpired):
            run_alembic("upgrade", "head", timeout=8)
        await holder.execute(
            text("SELECT pg_advisory_unlock(:k)"), {"k": MIGRATION_LOCK_KEY}
        )
        await holder.commit()

    await engine.dispose()
    assert run_alembic("upgrade", "head").returncode == 0, "must proceed once released"
