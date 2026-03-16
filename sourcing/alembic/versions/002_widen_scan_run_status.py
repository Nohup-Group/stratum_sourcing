"""Widen scan_runs.status from VARCHAR(20) to VARCHAR(30).

Revision ID: 002
Revises: 001
Create Date: 2026-03-10
"""

from alembic import op
import sqlalchemy as sa

revision = "002"
down_revision = "001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("scan_runs", "status", type_=sa.String(30), existing_type=sa.String(20))


def downgrade() -> None:
    op.alter_column("scan_runs", "status", type_=sa.String(20), existing_type=sa.String(30))
