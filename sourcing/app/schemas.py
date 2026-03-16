"""Pydantic schemas for API request/response validation."""

from datetime import datetime

from pydantic import BaseModel


# --- Source schemas ---

class SourceBase(BaseModel):
    name: str
    category: str
    fetch_strategy: str
    url: str | None = None
    secondary_urls: list[str] = []
    config: dict = {}
    verticals: list[str] = []
    description: str | None = None
    notes: str | None = None
    cadence_bucket: str = "daily"
    discovery_mode: str = "manual"
    onboarding_status: str = "new"
    is_active: bool = True


class SourceCreate(SourceBase):
    pass


class SourceResponse(SourceBase):
    id: int
    notion_page_id: str | None = None
    next_ingest_at: datetime | None = None
    last_ingested_at: datetime | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


# --- ScanRun schemas ---

class ScanRunResponse(BaseModel):
    id: int
    started_at: datetime
    finished_at: datetime | None = None
    status: str
    sources_total: int
    sources_ok: int
    sources_failed: int
    findings_count: int

    model_config = {"from_attributes": True}


# --- Finding schemas ---

class EvidenceResponse(BaseModel):
    id: int
    url: str
    excerpt: str
    captured_at: datetime
    content_type: str

    model_config = {"from_attributes": True}


class FindingResponse(BaseModel):
    id: int
    run_id: int
    source_id: int
    title: str
    summary: str
    category: str | None = None
    relevance_score: float
    vertical_tags: list[str] = []
    status: str
    created_at: datetime
    evidence_items: list[EvidenceResponse] = []

    model_config = {"from_attributes": True}


class EntityResponse(BaseModel):
    id: int
    entity_type: str
    display_name: str
    canonical_url: str | None = None
    description: str | None = None
    thesis_tags: list[str] = []
    source_count: int
    finding_count: int
    last_seen_at: datetime

    model_config = {"from_attributes": True}


class WatchTargetResponse(BaseModel):
    id: int
    entity_id: int
    target_type: str
    status: str
    score: float
    rank: int | None = None
    notion_page_id: str | None = None
    published_at: datetime | None = None
    entity: EntityResponse

    model_config = {"from_attributes": True}


# --- Task trigger schemas ---

class TaskTriggerRequest(BaseModel):
    secret: str


class TaskTriggerResponse(BaseModel):
    status: str
    message: str


# --- Health check ---

class HealthResponse(BaseModel):
    status: str
    version: str = "0.1.0"
