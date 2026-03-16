"""SQLAlchemy ORM models for the sourcing control plane and data plane."""

from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


# --- Enum values ---

SOURCE_CATEGORIES = (
    "company",
    "person",
    "association",
    "newsletter",
    "university",
    "conference",
    "vc",
    "regulator",
)

FETCH_STRATEGIES = (
    "rss",
    "web_scrape",
    "browser",
)

FINDING_STATUSES = (
    "new",
    "reviewed",
    "actionable",
    "dismissed",
    "archived",
)

FINDING_CATEGORIES = (
    "funding_round",
    "product_launch",
    "partnership",
    "regulatory",
    "hiring",
    "research",
    "market_move",
    "opinion",
)

ENTITY_TYPES = (
    "company",
    "person",
)

WATCH_TARGET_TYPES = ENTITY_TYPES


class Source(Base):
    __tablename__ = "sources"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    category: Mapped[str] = mapped_column(
        Enum(*SOURCE_CATEGORIES, name="source_category"),
        nullable=False,
    )
    fetch_strategy: Mapped[str] = mapped_column(
        Enum(*FETCH_STRATEGIES, name="fetch_strategy"),
        nullable=False,
    )
    url: Mapped[str | None] = mapped_column(Text)
    secondary_urls: Mapped[list[str]] = mapped_column(
        JSONB, default=list, server_default="[]"
    )
    config: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    verticals: Mapped[list[str]] = mapped_column(
        ARRAY(String), default=list, server_default="{}"
    )
    description: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)
    notion_page_id: Mapped[str | None] = mapped_column(String(64), unique=True)
    discovery_mode: Mapped[str] = mapped_column(
        String(20), default="manual", server_default="manual"
    )
    parent_source_id: Mapped[int | None] = mapped_column(ForeignKey("sources.id"))
    cadence_bucket: Mapped[str] = mapped_column(
        String(20), default="daily", server_default="daily"
    )
    next_ingest_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_ingested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    onboarding_status: Mapped[str] = mapped_column(
        String(30), default="active", server_default="active"
    )
    observed_publish_rate: Mapped[float] = mapped_column(
        Float, default=0.0, server_default="0.0"
    )
    auto_growth_state: Mapped[str] = mapped_column(
        String(20), default="manual", server_default="manual"
    )
    cooldown_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default="now()"
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default="now()", onupdate=datetime.utcnow
    )

    snapshots: Mapped[list["Snapshot"]] = relationship(back_populates="source")
    findings: Mapped[list["Finding"]] = relationship(back_populates="source")
    parent_source: Mapped["Source | None"] = relationship(
        remote_side="Source.id", back_populates="discovered_sources"
    )
    discovered_sources: Mapped[list["Source"]] = relationship(back_populates="parent_source")
    agent_jobs: Mapped[list["AgentJob"]] = relationship(back_populates="source")
    outbox_events: Mapped[list["EventOutbox"]] = relationship(back_populates="source")
    entity_mentions: Mapped[list["EntityMention"]] = relationship(back_populates="source")

    __table_args__ = (
        UniqueConstraint("name", "category", name="uq_sources_name_category"),
        Index("idx_sources_next_ingest_at", "next_ingest_at"),
        Index("idx_sources_cadence_bucket", "cadence_bucket"),
        Index("idx_sources_onboarding_status", "onboarding_status"),
    )


class ScanRun(Base):
    __tablename__ = "scan_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default="now()"
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(30), default="running", server_default="running")
    sources_total: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    sources_ok: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    sources_failed: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    findings_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    error_log: Mapped[dict] = mapped_column(JSONB, default=list, server_default="[]")
    metadata_: Mapped[dict] = mapped_column(
        "metadata", JSONB, default=dict, server_default="{}"
    )

    snapshots: Mapped[list["Snapshot"]] = relationship(back_populates="run")
    findings: Mapped[list["Finding"]] = relationship(back_populates="run")


class Snapshot(Base):
    __tablename__ = "snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    source_id: Mapped[int] = mapped_column(ForeignKey("sources.id"), nullable=False)
    run_id: Mapped[int] = mapped_column(ForeignKey("scan_runs.id"), nullable=False)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    raw_content: Mapped[str | None] = mapped_column(Text)
    fetched_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default="now()"
    )
    fetch_duration_ms: Mapped[int | None] = mapped_column(Integer)
    error: Mapped[str | None] = mapped_column(Text)
    metadata_: Mapped[dict] = mapped_column(
        "metadata", JSONB, default=dict, server_default="{}"
    )

    source: Mapped["Source"] = relationship(back_populates="snapshots")
    run: Mapped["ScanRun"] = relationship(back_populates="snapshots")

    __table_args__ = (
        Index("idx_snapshots_source_run", "source_id", "run_id"),
        Index("idx_snapshots_content_hash", "content_hash"),
    )


class Finding(Base):
    __tablename__ = "findings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("scan_runs.id"), nullable=False)
    source_id: Mapped[int] = mapped_column(ForeignKey("sources.id"), nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    category: Mapped[str | None] = mapped_column(String(50))
    relevance_score: Mapped[float] = mapped_column(Float, default=0.0, server_default="0.0")
    vertical_tags: Mapped[list[str]] = mapped_column(
        ARRAY(String), default=list, server_default="{}"
    )
    metadata_: Mapped[dict] = mapped_column(
        "metadata", JSONB, default=dict, server_default="{}"
    )
    status: Mapped[str] = mapped_column(
        Enum(*FINDING_STATUSES, name="finding_status"),
        default="new",
        server_default="new",
    )
    dedup_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    notion_page_id: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default="now()"
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    source: Mapped["Source"] = relationship(back_populates="findings")
    run: Mapped["ScanRun"] = relationship(back_populates="findings")
    evidence_items: Mapped[list["Evidence"]] = relationship(
        back_populates="finding", cascade="all, delete-orphan"
    )
    notifications: Mapped[list["Notification"]] = relationship(back_populates="finding")
    entity_mentions: Mapped[list["EntityMention"]] = relationship(
        back_populates="finding", cascade="all, delete-orphan"
    )

    __table_args__ = (
        Index("idx_findings_run", "run_id"),
        Index("idx_findings_score", "relevance_score"),
    )


class Evidence(Base):
    __tablename__ = "evidence"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    finding_id: Mapped[int] = mapped_column(
        ForeignKey("findings.id", ondelete="CASCADE"), nullable=False
    )
    url: Mapped[str] = mapped_column(Text, nullable=False)
    excerpt: Mapped[str] = mapped_column(Text, nullable=False)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    content_type: Mapped[str] = mapped_column(
        String(20), default="text", server_default="text"
    )
    metadata_: Mapped[dict] = mapped_column(
        "metadata", JSONB, default=dict, server_default="{}"
    )

    finding: Mapped["Finding"] = relationship(back_populates="evidence_items")

    __table_args__ = (Index("idx_evidence_finding", "finding_id"),)


class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    finding_id: Mapped[int | None] = mapped_column(ForeignKey("findings.id"))
    channel: Mapped[str] = mapped_column(String(30), nullable=False)
    channel_ref: Mapped[str | None] = mapped_column(Text)
    sent_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default="now()"
    )
    payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)

    finding: Mapped["Finding | None"] = relationship(back_populates="notifications")

    __table_args__ = (
        UniqueConstraint(
            "finding_id", "channel", "payload_hash", name="uq_notifications_dedup"
        ),
    )


class IntegrationState(Base):
    __tablename__ = "integration_states"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    integration: Mapped[str] = mapped_column(String(50), nullable=False, unique=True)
    config: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default="now()", onupdate=datetime.utcnow
    )


class EventOutbox(Base):
    __tablename__ = "event_outbox"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    event_type: Mapped[str] = mapped_column(String(80), nullable=False)
    status: Mapped[str] = mapped_column(
        String(20), default="pending", server_default="pending"
    )
    dedup_key: Mapped[str | None] = mapped_column(String(128), unique=True)
    payload: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    source_id: Mapped[int | None] = mapped_column(ForeignKey("sources.id"))
    entity_id: Mapped[int | None] = mapped_column(ForeignKey("entities.id"))
    available_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default="now()"
    )
    last_error: Mapped[str | None] = mapped_column(Text)
    attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default="now()"
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default="now()", onupdate=datetime.utcnow
    )

    source: Mapped["Source | None"] = relationship(back_populates="outbox_events")
    entity: Mapped["Entity | None"] = relationship(back_populates="outbox_events")
    agent_jobs: Mapped[list["AgentJob"]] = relationship(back_populates="event")

    __table_args__ = (
        Index("idx_event_outbox_status_available", "status", "available_at"),
    )


class Entity(Base):
    __tablename__ = "entities"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    entity_type: Mapped[str] = mapped_column(
        Enum(*ENTITY_TYPES, name="entity_type"), nullable=False
    )
    display_name: Mapped[str] = mapped_column(String(255), nullable=False)
    normalized_name: Mapped[str] = mapped_column(String(255), nullable=False)
    canonical_url: Mapped[str | None] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(Text)
    thesis_tags: Mapped[list[str]] = mapped_column(
        ARRAY(String), default=list, server_default="{}"
    )
    metadata_: Mapped[dict] = mapped_column(
        "metadata", JSONB, default=dict, server_default="{}"
    )
    first_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default="now()"
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default="now()"
    )
    source_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    finding_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default="now()"
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default="now()", onupdate=datetime.utcnow
    )

    mentions: Mapped[list["EntityMention"]] = relationship(
        back_populates="entity", cascade="all, delete-orphan"
    )
    research_snapshots: Mapped[list["EntityResearchSnapshot"]] = relationship(
        back_populates="entity", cascade="all, delete-orphan"
    )
    scores: Mapped[list["EntityScore"]] = relationship(
        back_populates="entity", cascade="all, delete-orphan"
    )
    watch_targets: Mapped[list["WatchTarget"]] = relationship(back_populates="entity")
    agent_jobs: Mapped[list["AgentJob"]] = relationship(back_populates="entity")
    outbox_events: Mapped[list["EventOutbox"]] = relationship(back_populates="entity")

    __table_args__ = (
        UniqueConstraint("entity_type", "normalized_name", name="uq_entities_type_normalized"),
        Index("idx_entities_type", "entity_type"),
    )


class EntityMention(Base):
    __tablename__ = "entity_mentions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    entity_id: Mapped[int] = mapped_column(ForeignKey("entities.id"), nullable=False)
    finding_id: Mapped[int | None] = mapped_column(ForeignKey("findings.id"))
    evidence_id: Mapped[int | None] = mapped_column(ForeignKey("evidence.id"))
    source_id: Mapped[int | None] = mapped_column(ForeignKey("sources.id"))
    mention_text: Mapped[str] = mapped_column(String(255), nullable=False)
    role_hint: Mapped[str | None] = mapped_column(String(80))
    confidence: Mapped[float] = mapped_column(Float, default=0.0, server_default="0.0")
    context_excerpt: Mapped[str | None] = mapped_column(Text)
    metadata_: Mapped[dict] = mapped_column(
        "metadata", JSONB, default=dict, server_default="{}"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default="now()"
    )

    entity: Mapped["Entity"] = relationship(back_populates="mentions")
    finding: Mapped["Finding | None"] = relationship(back_populates="entity_mentions")
    evidence: Mapped["Evidence | None"] = relationship()
    source: Mapped["Source | None"] = relationship(back_populates="entity_mentions")

    __table_args__ = (
        Index("idx_entity_mentions_entity_id", "entity_id"),
        Index("idx_entity_mentions_finding_id", "finding_id"),
    )


class AgentJob(Base):
    __tablename__ = "agent_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    job_type: Mapped[str] = mapped_column(String(80), nullable=False)
    status: Mapped[str] = mapped_column(
        String(20), default="pending", server_default="pending"
    )
    external_ref: Mapped[str | None] = mapped_column(String(128))
    payload: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    result: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    source_id: Mapped[int | None] = mapped_column(ForeignKey("sources.id"))
    entity_id: Mapped[int | None] = mapped_column(ForeignKey("entities.id"))
    event_id: Mapped[int | None] = mapped_column(ForeignKey("event_outbox.id"))
    priority: Mapped[int] = mapped_column(Integer, default=100, server_default="100")
    attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    available_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default="now()"
    )
    leased_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    lease_owner: Mapped[str | None] = mapped_column(String(64))
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default="now()"
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default="now()", onupdate=datetime.utcnow
    )

    source: Mapped["Source | None"] = relationship(back_populates="agent_jobs")
    entity: Mapped["Entity | None"] = relationship(back_populates="agent_jobs")
    event: Mapped["EventOutbox | None"] = relationship(back_populates="agent_jobs")
    research_snapshots: Mapped[list["EntityResearchSnapshot"]] = relationship(
        back_populates="agent_job"
    )

    __table_args__ = (
        UniqueConstraint("job_type", "external_ref", name="uq_agent_jobs_type_external_ref"),
        Index("idx_agent_jobs_status_available", "status", "available_at", "priority"),
    )


class EntityResearchSnapshot(Base):
    __tablename__ = "entity_research_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    entity_id: Mapped[int] = mapped_column(ForeignKey("entities.id"), nullable=False)
    agent_job_id: Mapped[int | None] = mapped_column(ForeignKey("agent_jobs.id"))
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    profile: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    evidence_urls: Mapped[list[str]] = mapped_column(
        JSONB, default=list, server_default="[]"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default="now()"
    )

    entity: Mapped["Entity"] = relationship(back_populates="research_snapshots")
    agent_job: Mapped["AgentJob | None"] = relationship(back_populates="research_snapshots")


class EntityScore(Base):
    __tablename__ = "entity_scores"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    entity_id: Mapped[int] = mapped_column(ForeignKey("entities.id"), nullable=False)
    score: Mapped[float] = mapped_column(Float, default=0.0, server_default="0.0")
    components: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    rationale: Mapped[str | None] = mapped_column(Text)
    evidence_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    source_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    first_scored_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default="now()"
    )
    last_scored_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default="now()"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default="now()"
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default="now()", onupdate=datetime.utcnow
    )

    entity: Mapped["Entity"] = relationship(back_populates="scores")

    __table_args__ = (
        UniqueConstraint("entity_id", name="uq_entity_scores_entity_id"),
    )


class WatchTarget(Base):
    __tablename__ = "watch_targets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    entity_id: Mapped[int] = mapped_column(ForeignKey("entities.id"), nullable=False)
    target_type: Mapped[str] = mapped_column(
        Enum(*WATCH_TARGET_TYPES, name="watch_target_type"), nullable=False
    )
    status: Mapped[str] = mapped_column(
        String(20), default="active", server_default="active"
    )
    score: Mapped[float] = mapped_column(Float, default=0.0, server_default="0.0")
    rank: Mapped[int | None] = mapped_column(Integer)
    notion_page_id: Mapped[str | None] = mapped_column(String(64), unique=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default="now()"
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default="now()", onupdate=datetime.utcnow
    )

    entity: Mapped["Entity"] = relationship(back_populates="watch_targets")

    __table_args__ = (
        UniqueConstraint("entity_id", "target_type", name="uq_watch_targets_entity_type"),
        Index("idx_watch_targets_type_score", "target_type", "score"),
    )
