"""Widen entity_mentions.role_hint from VARCHAR(80) to TEXT.

The extractor writes a free-text role description straight from the LLM into
this column. On 2026-08-12 it produced a 101-character hint, the insert raised
StringDataRightTruncationError, and agent-jobs crashed on every 10-minute run
for an hour. The hint is prose, not an identifier — there is no width the
model can be relied on to respect, so it gets none.

Revision ID: 007
Revises: 006
Create Date: 2026-08-12
"""

from alembic import op
import sqlalchemy as sa

revision = "007"
down_revision = "006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "entity_mentions",
        "role_hint",
        type_=sa.Text(),
        existing_type=sa.String(80),
        existing_nullable=True,
    )


def downgrade() -> None:
    op.execute("UPDATE entity_mentions SET role_hint = left(role_hint, 80)")
    op.alter_column(
        "entity_mentions",
        "role_hint",
        type_=sa.String(80),
        existing_type=sa.Text(),
        existing_nullable=True,
    )
