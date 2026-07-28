"""Signal engine: the 200-signal library, per-company scans, and per-signal results.

Revision ID: 005
Revises: 004
Create Date: 2026-07-28
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "005"
down_revision = "004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "signals",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("number", sa.Integer(), nullable=False, unique=True),
        sa.Column("category", sa.String(length=60), nullable=False),
        sa.Column("subcategory", sa.String(length=60), nullable=True),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("indicator", sa.Text(), nullable=True),
        sa.Column("data_source", sa.Text(), nullable=True),
        sa.Column("search_method", sa.Text(), nullable=True),
        sa.Column("strength", sa.String(length=10), nullable=False, server_default="high"),
        sa.Column("threshold", sa.Text(), nullable=True),
        sa.Column("anti_signal", sa.Text(), nullable=True),
        sa.Column("points", sa.Float(), nullable=False, server_default="2.0"),
        sa.Column("scan_tier", sa.Integer(), nullable=False, server_default="2"),
        sa.Column("is_veto", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()")
        ),
    )
    op.create_index("idx_signals_category", "signals", ["category"])
    op.create_index("idx_signals_scan_tier", "signals", ["scan_tier"])

    op.create_table(
        "signal_scans",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "entity_id", sa.Integer(), sa.ForeignKey("entities.id"), nullable=False
        ),
        sa.Column(
            "agent_job_id", sa.Integer(), sa.ForeignKey("agent_jobs.id"), nullable=True
        ),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="pending"),
        sa.Column(
            "scan_depth", sa.String(length=10), nullable=False, server_default="standard"
        ),
        sa.Column("trigger", sa.String(length=30), nullable=False, server_default="manual"),
        sa.Column("points_earned", sa.Float(), nullable=False, server_default="0"),
        sa.Column("points_possible", sa.Float(), nullable=False, server_default="0"),
        sa.Column("score_pct", sa.Float(), nullable=False, server_default="0"),
        sa.Column("band", sa.String(length=20), nullable=True),
        sa.Column("veto_flags", JSONB(), nullable=False, server_default="[]"),
        sa.Column("category_scores", JSONB(), nullable=False, server_default="{}"),
        sa.Column("signals_confirmed", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("signals_absent", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("signals_unknown", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("rationale", sa.Text(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
    )
    op.create_index(
        "idx_signal_scans_entity_created", "signal_scans", ["entity_id", "created_at"]
    )
    op.create_index("idx_signal_scans_status", "signal_scans", ["status"])

    op.create_table(
        "signal_results",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "scan_id",
            sa.Integer(),
            sa.ForeignKey("signal_scans.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "signal_id", sa.Integer(), sa.ForeignKey("signals.id"), nullable=False
        ),
        sa.Column("result", sa.String(length=12), nullable=False, server_default="unknown"),
        sa.Column("evidence_url", sa.Text(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("points_earned", sa.Float(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.UniqueConstraint("scan_id", "signal_id", name="uq_signal_results_scan_signal"),
    )
    op.create_index("idx_signal_results_scan", "signal_results", ["scan_id"])
    op.create_index("idx_signal_results_signal", "signal_results", ["signal_id"])


def downgrade() -> None:
    op.drop_table("signal_results")
    op.drop_table("signal_scans")
    op.drop_table("signals")
