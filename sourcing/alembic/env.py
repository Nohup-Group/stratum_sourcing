"""Alembic environment configuration for async SQLAlchemy."""

import logging
from logging.config import fileConfig

from alembic import context
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, text

from app.config import settings
from app.models import Base

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata
logger = logging.getLogger("alembic.env")

# Nine Railway services boot from one image against one database, and every one
# of them runs `alembic upgrade head`. Two guards make that safe.
#
# The lock stops two containers starting together from running DDL at the same
# time. It is session-scoped, not transaction-scoped, so it survives the
# migration's own commits and is released automatically if the process dies —
# a crashed migrator cannot wedge the rest.
MIGRATION_LOCK_KEY = 918273645


def _revision_unknown_to_this_image(connection) -> str | None:
    """The revision the database reports, if this image has never heard of it.

    This is the normal state of every not-yet-rolled-over service in the
    seconds after a deploy: a newer peer has already migrated, and this
    container's migrations directory simply does not contain that revision yet.
    On 2026-08-13 that exited non-zero on every cron tick and read as
    "Deploy Crashed". It is not this container's error to raise — but it is the
    ONLY migration failure that gets forgiven here.
    """
    if connection.execute(text("SELECT to_regclass('alembic_version')")).scalar() is None:
        return None  # fresh database, nothing has migrated yet
    current = connection.execute(text("SELECT version_num FROM alembic_version")).scalar()
    if current is None:
        return None
    known = {revision.revision for revision in ScriptDirectory.from_config(config).walk_revisions()}
    return None if current in known else current


def run_migrations_offline() -> None:
    url = settings.sync_database_url
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = create_engine(settings.sync_database_url)
    # The lock and the revision check get their own connection, and the
    # migration gets a pristine one. Sharing them breaks alembic: any statement
    # issued first leaves an open transaction, MigrationContext then sees
    # _in_external_transaction, begin_transaction() degrades to a nullcontext,
    # and migrations lose both their atomicity and their autocommit_block —
    # 006 fails outright on an AssertionError.
    with connectable.connect() as guard:
        guard.execute(text("SELECT pg_advisory_lock(:key)"), {"key": MIGRATION_LOCK_KEY})
        guard.commit()
        try:
            ahead = _revision_unknown_to_this_image(guard)
            if ahead is not None:
                logger.warning(
                    "database is at revision %s, which this image does not contain — "
                    "a newer deployment has already migrated; skipping",
                    ahead,
                )
                return
            with connectable.connect() as connection:
                context.configure(connection=connection, target_metadata=target_metadata)
                with context.begin_transaction():
                    context.run_migrations()
        finally:
            # Releasing must never become the error the operator sees: after a
            # failed migration this connection may itself be in a failed
            # transaction. The lock is session-scoped and drops with the
            # connection regardless.
            try:
                guard.rollback()
                guard.execute(
                    text("SELECT pg_advisory_unlock(:key)"), {"key": MIGRATION_LOCK_KEY}
                )
                guard.commit()
            except Exception:  # pragma: no cover — best effort
                logger.warning("could not release the migration lock; it drops with the connection")


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
