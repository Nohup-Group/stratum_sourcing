"""Add control-plane foundations for entity-centric sourcing.

Revision ID: 004
Revises: 003
Create Date: 2026-03-16
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import ARRAY, ENUM, JSONB

revision = "004"
down_revision = "003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1
                FROM pg_enum
                WHERE enumlabel = 'company'
                  AND enumtypid = 'source_category'::regtype
            ) THEN
                ALTER TYPE source_category ADD VALUE 'company';
            END IF;
        END$$;
        """
    )

    op.add_column("sources", sa.Column("notes", sa.Text(), nullable=True))
    op.add_column("sources", sa.Column("notion_page_id", sa.String(length=64), nullable=True))
    op.add_column(
        "sources",
        sa.Column("discovery_mode", sa.String(length=20), server_default="manual", nullable=False),
    )
    op.add_column("sources", sa.Column("parent_source_id", sa.Integer(), nullable=True))
    op.add_column(
        "sources",
        sa.Column("cadence_bucket", sa.String(length=20), server_default="daily", nullable=False),
    )
    op.add_column("sources", sa.Column("next_ingest_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("sources", sa.Column("last_ingested_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "sources",
        sa.Column(
            "onboarding_status",
            sa.String(length=30),
            server_default="active",
            nullable=False,
        ),
    )
    op.add_column(
        "sources",
        sa.Column(
            "observed_publish_rate",
            sa.Float(),
            server_default="0.0",
            nullable=False,
        ),
    )
    op.add_column(
        "sources",
        sa.Column(
            "auto_growth_state",
            sa.String(length=20),
            server_default="manual",
            nullable=False,
        ),
    )
    op.add_column("sources", sa.Column("cooldown_until", sa.DateTime(timezone=True), nullable=True))
    op.create_foreign_key(
        "fk_sources_parent_source_id_sources",
        "sources",
        "sources",
        ["parent_source_id"],
        ["id"],
    )
    op.create_unique_constraint("uq_sources_notion_page_id", "sources", ["notion_page_id"])
    op.create_index("idx_sources_next_ingest_at", "sources", ["next_ingest_at"])
    op.create_index("idx_sources_cadence_bucket", "sources", ["cadence_bucket"])
    op.create_index("idx_sources_onboarding_status", "sources", ["onboarding_status"])

    op.add_column(
        "snapshots",
        sa.Column("metadata", JSONB(), server_default=sa.text("'{}'::jsonb"), nullable=False),
    )
    op.add_column(
        "findings",
        sa.Column("metadata", JSONB(), server_default=sa.text("'{}'::jsonb"), nullable=False),
    )

    op.create_table(
        "integration_states",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("integration", sa.String(length=50), nullable=False),
        sa.Column(
            "config",
            JSONB(),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("integration"),
    )

    entity_type = ENUM("company", "person", name="entity_type", create_type=False)
    watch_target_type = ENUM("company", "person", name="watch_target_type", create_type=False)
    entity_type.create(op.get_bind(), checkfirst=True)
    watch_target_type.create(op.get_bind(), checkfirst=True)

    op.create_table(
        "entities",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("entity_type", entity_type, nullable=False),
        sa.Column("display_name", sa.String(length=255), nullable=False),
        sa.Column("normalized_name", sa.String(length=255), nullable=False),
        sa.Column("canonical_url", sa.Text(), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("thesis_tags", ARRAY(sa.String()), server_default="{}", nullable=False),
        sa.Column(
            "metadata",
            JSONB(),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "first_seen_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("source_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("finding_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("entity_type", "normalized_name", name="uq_entities_type_normalized"),
    )
    op.create_index("idx_entities_type", "entities", ["entity_type"])

    op.create_table(
        "event_outbox",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("event_type", sa.String(length=80), nullable=False),
        sa.Column("status", sa.String(length=20), server_default="pending", nullable=False),
        sa.Column("dedup_key", sa.String(length=128), nullable=True),
        sa.Column(
            "payload",
            JSONB(),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("source_id", sa.Integer(), nullable=True),
        sa.Column("entity_id", sa.Integer(), nullable=True),
        sa.Column(
            "available_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["entity_id"], ["entities.id"]),
        sa.ForeignKeyConstraint(["source_id"], ["sources.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("dedup_key"),
    )
    op.create_index("idx_event_outbox_status_available", "event_outbox", ["status", "available_at"])

    op.create_table(
        "agent_jobs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("job_type", sa.String(length=80), nullable=False),
        sa.Column("status", sa.String(length=20), server_default="pending", nullable=False),
        sa.Column("external_ref", sa.String(length=128), nullable=True),
        sa.Column(
            "payload",
            JSONB(),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "result",
            JSONB(),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("source_id", sa.Integer(), nullable=True),
        sa.Column("entity_id", sa.Integer(), nullable=True),
        sa.Column("event_id", sa.Integer(), nullable=True),
        sa.Column("priority", sa.Integer(), server_default="100", nullable=False),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "available_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("leased_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("lease_owner", sa.String(length=64), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["entity_id"], ["entities.id"]),
        sa.ForeignKeyConstraint(["event_id"], ["event_outbox.id"]),
        sa.ForeignKeyConstraint(["source_id"], ["sources.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("job_type", "external_ref", name="uq_agent_jobs_type_external_ref"),
    )
    op.create_index(
        "idx_agent_jobs_status_available",
        "agent_jobs",
        ["status", "available_at", "priority"],
    )

    op.create_table(
        "entity_research_snapshots",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("entity_id", sa.Integer(), nullable=False),
        sa.Column("agent_job_id", sa.Integer(), nullable=True),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column(
            "profile",
            JSONB(),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "evidence_urls",
            JSONB(),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["agent_job_id"], ["agent_jobs.id"]),
        sa.ForeignKeyConstraint(["entity_id"], ["entities.id"]),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "entity_scores",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("entity_id", sa.Integer(), nullable=False),
        sa.Column("score", sa.Float(), server_default="0.0", nullable=False),
        sa.Column(
            "components",
            JSONB(),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("rationale", sa.Text(), nullable=True),
        sa.Column("evidence_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("source_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "first_scored_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "last_scored_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["entity_id"], ["entities.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("entity_id", name="uq_entity_scores_entity_id"),
    )

    op.create_table(
        "watch_targets",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("entity_id", sa.Integer(), nullable=False),
        sa.Column("target_type", watch_target_type, nullable=False),
        sa.Column("status", sa.String(length=20), server_default="active", nullable=False),
        sa.Column("score", sa.Float(), server_default="0.0", nullable=False),
        sa.Column("rank", sa.Integer(), nullable=True),
        sa.Column("notion_page_id", sa.String(length=64), nullable=True),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["entity_id"], ["entities.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("entity_id", "target_type", name="uq_watch_targets_entity_type"),
        sa.UniqueConstraint("notion_page_id"),
    )
    op.create_index("idx_watch_targets_type_score", "watch_targets", ["target_type", "score"])

    op.create_table(
        "entity_mentions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("entity_id", sa.Integer(), nullable=False),
        sa.Column("finding_id", sa.Integer(), nullable=True),
        sa.Column("evidence_id", sa.Integer(), nullable=True),
        sa.Column("source_id", sa.Integer(), nullable=True),
        sa.Column("mention_text", sa.String(length=255), nullable=False),
        sa.Column("role_hint", sa.String(length=80), nullable=True),
        sa.Column("confidence", sa.Float(), server_default="0.0", nullable=False),
        sa.Column("context_excerpt", sa.Text(), nullable=True),
        sa.Column(
            "metadata",
            JSONB(),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["entity_id"], ["entities.id"]),
        sa.ForeignKeyConstraint(["evidence_id"], ["evidence.id"]),
        sa.ForeignKeyConstraint(["finding_id"], ["findings.id"]),
        sa.ForeignKeyConstraint(["source_id"], ["sources.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_entity_mentions_entity_id", "entity_mentions", ["entity_id"])
    op.create_index("idx_entity_mentions_finding_id", "entity_mentions", ["finding_id"])


def downgrade() -> None:
    op.drop_index("idx_entity_mentions_finding_id", table_name="entity_mentions")
    op.drop_index("idx_entity_mentions_entity_id", table_name="entity_mentions")
    op.drop_table("entity_mentions")

    op.drop_index("idx_watch_targets_type_score", table_name="watch_targets")
    op.drop_table("watch_targets")

    op.drop_table("entity_scores")
    op.drop_table("entity_research_snapshots")

    op.drop_index("idx_agent_jobs_status_available", table_name="agent_jobs")
    op.drop_table("agent_jobs")

    op.drop_index("idx_event_outbox_status_available", table_name="event_outbox")
    op.drop_table("event_outbox")

    op.drop_index("idx_entities_type", table_name="entities")
    op.drop_table("entities")

    watch_target_type = ENUM("company", "person", name="watch_target_type", create_type=False)
    entity_type = ENUM("company", "person", name="entity_type", create_type=False)
    watch_target_type.drop(op.get_bind(), checkfirst=True)
    entity_type.drop(op.get_bind(), checkfirst=True)

    op.drop_table("integration_states")

    op.drop_column("findings", "metadata")
    op.drop_column("snapshots", "metadata")

    op.drop_index("idx_sources_onboarding_status", table_name="sources")
    op.drop_index("idx_sources_cadence_bucket", table_name="sources")
    op.drop_index("idx_sources_next_ingest_at", table_name="sources")
    op.drop_constraint("uq_sources_notion_page_id", "sources", type_="unique")
    op.drop_constraint("fk_sources_parent_source_id_sources", "sources", type_="foreignkey")
    op.drop_column("sources", "cooldown_until")
    op.drop_column("sources", "auto_growth_state")
    op.drop_column("sources", "observed_publish_rate")
    op.drop_column("sources", "onboarding_status")
    op.drop_column("sources", "last_ingested_at")
    op.drop_column("sources", "next_ingest_at")
    op.drop_column("sources", "cadence_bucket")
    op.drop_column("sources", "parent_source_id")
    op.drop_column("sources", "discovery_mode")
    op.drop_column("sources", "notion_page_id")
    op.drop_column("sources", "notes")
