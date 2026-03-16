"""Placeholder for revision applied in dev but not committed.

Revision ID: 003
Revises: 002
Create Date: 2026-03-16

This is a no-op migration. The database already has revision '003' recorded
in alembic_version, but the original migration file was never committed.
The schema matches the current models, so no changes are needed.
"""

revision = "003"
down_revision = "002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
