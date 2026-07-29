"""Entity typing, canonical domain identity, eligibility gate, and coverage-aware scans.

Three defects this migration exists to fix, all measured in production:

1. The extractor typed every proper noun as a "company", so 1,825 company rows
   contained regulators, VCs, media, tokens, laws, countries and AI models. The
   entity_type enum gains the types needed to route those elsewhere.
2. Identity was resolved on display name, so name collisions scored the wrong
   company (Outpost vs Outpost24, Zapp across three firms). Companies now carry
   their own registrable domain and registry id.
3. Scans gave 0.5 credit per unresolved signal, so a company with 3 confirmed
   and 58 unknown signals banded "moderate" at 50.8%. Scans now record how much
   was actually resolved (coverage) and how many signals did not apply.

Revision ID: 006
Revises: 005
Create Date: 2026-07-30
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "006"
down_revision = "005"
branch_labels = None
depends_on = None

NEW_ENTITY_TYPES = (
    "investor",
    "regulator",
    "media",
    "event",
    "association",
    "academic",
    "protocol",
    "token",
    "standard",
    "product",
    "place",
    "concept",
)

LIFECYCLE_STATUSES = ("live", "acquired", "dissolved", "dormant", "unknown")


def upgrade() -> None:
    # ALTER TYPE ... ADD VALUE cannot be used later in the same transaction that
    # created it, so widen the enum in its own autocommit block first.
    with op.get_context().autocommit_block():
        for value in NEW_ENTITY_TYPES:
            op.execute(f"ALTER TYPE entity_type ADD VALUE IF NOT EXISTS '{value}'")

    lifecycle = sa.Enum(*LIFECYCLE_STATUSES, name="lifecycle_status")
    lifecycle.create(op.get_bind(), checkfirst=True)

    op.add_column("entities", sa.Column("domain", sa.String(length=255), nullable=True))
    op.add_column("entities", sa.Column("registry_id", sa.String(length=120), nullable=True))
    op.add_column(
        "entities",
        sa.Column(
            "lifecycle_status", lifecycle, nullable=False, server_default="unknown"
        ),
    )
    op.add_column(
        "entities", sa.Column("lifecycle_checked_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column("entities", sa.Column("is_eligible", sa.Boolean(), nullable=True))
    op.add_column(
        "entities", sa.Column("gate", JSONB(), nullable=False, server_default="{}")
    )

    # Domain is the real identity key. Not unique yet — existing rows have none,
    # and dedupe has to run before a constraint can hold.
    op.create_index("idx_entities_domain", "entities", ["domain"])
    op.create_index(
        "idx_entities_eligible",
        "entities",
        ["entity_type", "is_eligible"],
    )

    op.add_column(
        "signal_scans",
        sa.Column("signals_not_applicable", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "signal_scans",
        sa.Column("coverage", sa.Float(), nullable=False, server_default="0"),
    )

    # Existing scans were scored under the old unknown=0.5 rule, so their
    # score_pct is not comparable to anything produced from here on. Mark them
    # rather than silently leaving two incompatible scales in one column.
    op.execute(
        """
        UPDATE signal_scans
           SET band = 'insufficient-evidence',
               coverage = CASE
                   WHEN (signals_confirmed + signals_absent + signals_unknown) > 0
                   THEN (signals_confirmed + signals_absent)::float
                        / (signals_confirmed + signals_absent + signals_unknown)
                   ELSE 0
               END
         WHERE status = 'completed'
        """
    )


def downgrade() -> None:
    op.drop_column("signal_scans", "coverage")
    op.drop_column("signal_scans", "signals_not_applicable")
    op.drop_index("idx_entities_eligible", table_name="entities")
    op.drop_index("idx_entities_domain", table_name="entities")
    op.drop_column("entities", "gate")
    op.drop_column("entities", "is_eligible")
    op.drop_column("entities", "lifecycle_checked_at")
    op.drop_column("entities", "lifecycle_status")
    op.drop_column("entities", "registry_id")
    op.drop_column("entities", "domain")
    sa.Enum(name="lifecycle_status").drop(op.get_bind(), checkfirst=True)
    # entity_type enum values are intentionally left in place: Postgres cannot
    # drop an enum value, and reversing the type widening would require
    # rewriting the type and every dependent column.
