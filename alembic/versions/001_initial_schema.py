"""Initial schema: sources, scan_runs, snapshots, findings, evidence, notifications.

Revision ID: 001
Create Date: 2026-03-10
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import ARRAY, JSONB

revision = "001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Enum types
    source_category = sa.Enum(
        "person", "association", "newsletter", "university",
        "conference", "vc", "regulator",
        name="source_category",
    )
    fetch_strategy = sa.Enum("rss", "web_scrape", "browser", name="fetch_strategy")
    finding_status = sa.Enum(
        "new", "reviewed", "actionable", "dismissed", "archived",
        name="finding_status",
    )

    # 1. sources
    op.create_table(
        "sources",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("category", source_category, nullable=False),
        sa.Column("fetch_strategy", fetch_strategy, nullable=False),
        sa.Column("url", sa.Text),
        sa.Column("secondary_urls", JSONB, server_default="[]"),
        sa.Column("config", JSONB, server_default="{}"),
        sa.Column("verticals", ARRAY(sa.String), server_default="{}"),
        sa.Column("description", sa.Text),
        sa.Column("is_active", sa.Boolean, server_default="true"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.UniqueConstraint("name", "category", name="uq_sources_name_category"),
    )

    # 2. scan_runs
    op.create_table(
        "scan_runs",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("started_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.Column("status", sa.String(20), server_default="running"),
        sa.Column("sources_total", sa.Integer, server_default="0"),
        sa.Column("sources_ok", sa.Integer, server_default="0"),
        sa.Column("sources_failed", sa.Integer, server_default="0"),
        sa.Column("findings_count", sa.Integer, server_default="0"),
        sa.Column("error_log", JSONB, server_default="[]"),
        sa.Column("metadata", JSONB, server_default="{}"),
    )

    # 3. snapshots
    op.create_table(
        "snapshots",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("source_id", sa.Integer, sa.ForeignKey("sources.id"), nullable=False),
        sa.Column("run_id", sa.Integer, sa.ForeignKey("scan_runs.id"), nullable=False),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("raw_content", sa.Text),
        sa.Column("fetched_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.Column("fetch_duration_ms", sa.Integer),
        sa.Column("error", sa.Text),
    )
    op.create_index("idx_snapshots_source_run", "snapshots", ["source_id", "run_id"])
    op.create_index("idx_snapshots_content_hash", "snapshots", ["content_hash"])

    # 4. findings
    op.create_table(
        "findings",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("run_id", sa.Integer, sa.ForeignKey("scan_runs.id"), nullable=False),
        sa.Column("source_id", sa.Integer, sa.ForeignKey("sources.id"), nullable=False),
        sa.Column("title", sa.Text, nullable=False),
        sa.Column("summary", sa.Text, nullable=False),
        sa.Column("category", sa.String(50)),
        sa.Column("relevance_score", sa.Float, server_default="0.0"),
        sa.Column("vertical_tags", ARRAY(sa.String), server_default="{}"),
        sa.Column("status", finding_status, server_default="new"),
        sa.Column("dedup_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("notion_page_id", sa.String(64)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.Column("reviewed_at", sa.DateTime(timezone=True)),
    )
    op.create_index("idx_findings_run", "findings", ["run_id"])
    op.create_index("idx_findings_score", "findings", ["relevance_score"])

    # 5. evidence
    op.create_table(
        "evidence",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "finding_id",
            sa.Integer,
            sa.ForeignKey("findings.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("url", sa.Text, nullable=False),
        sa.Column("excerpt", sa.Text, nullable=False),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("content_type", sa.String(20), server_default="text"),
        sa.Column("metadata", JSONB, server_default="{}"),
    )
    op.create_index("idx_evidence_finding", "evidence", ["finding_id"])

    # 6. notifications
    op.create_table(
        "notifications",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("finding_id", sa.Integer, sa.ForeignKey("findings.id")),
        sa.Column("channel", sa.String(30), nullable=False),
        sa.Column("channel_ref", sa.Text),
        sa.Column("sent_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.Column("payload_hash", sa.String(64), nullable=False),
        sa.UniqueConstraint(
            "finding_id", "channel", "payload_hash", name="uq_notifications_dedup"
        ),
    )


def downgrade() -> None:
    op.drop_table("notifications")
    op.drop_table("evidence")
    op.drop_table("findings")
    op.drop_table("snapshots")
    op.drop_table("scan_runs")
    op.drop_table("sources")
    sa.Enum(name="finding_status").drop(op.get_bind())
    sa.Enum(name="fetch_strategy").drop(op.get_bind())
    sa.Enum(name="source_category").drop(op.get_bind())
