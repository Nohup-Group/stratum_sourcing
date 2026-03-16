"""SQLAlchemy ORM models for the 6-table schema."""

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
    secondary_urls: Mapped[dict] = mapped_column(JSONB, default=list, server_default="[]")
    config: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    verticals: Mapped[list[str]] = mapped_column(
        ARRAY(String), default=list, server_default="{}"
    )
    description: Mapped[str | None] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default="now()"
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default="now()", onupdate=datetime.utcnow
    )

    snapshots: Mapped[list["Snapshot"]] = relationship(back_populates="source")
    findings: Mapped[list["Finding"]] = relationship(back_populates="source")

    __table_args__ = (
        UniqueConstraint("name", "category", name="uq_sources_name_category"),
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
