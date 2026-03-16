"""Pipeline stage tracking for observability.

Follows the ncf-dataroom PipelineTracker pattern: records start/complete/fail
events per source per scan stage, enabling debugging and performance monitoring.
"""

from datetime import datetime, timezone
from enum import Enum

import structlog

logger = structlog.get_logger()


class ScanStage(str, Enum):
    FETCH = "fetch"
    DIFF = "diff"
    ANALYZE = "analyze"
    SCORE = "score"
    DEDUP = "dedup"
    STORE = "store"


class PipelineTracker:
    """Tracks pipeline stage execution per source per run.

    Usage:
        tracker = PipelineTracker(run_id=1, source_id=5, source_name="Bankless")
        tracker.start(ScanStage.FETCH)
        ...
        tracker.complete(ScanStage.FETCH, duration_ms=234)
        # or
        tracker.fail(ScanStage.FETCH, error="timeout")
    """

    def __init__(self, run_id: int, source_id: int, source_name: str):
        self.run_id = run_id
        self.source_id = source_id
        self.source_name = source_name
        self.stages: dict[str, dict] = {}

    def start(self, stage: ScanStage) -> None:
        self.stages[stage] = {
            "started_at": datetime.now(timezone.utc).isoformat(),
            "status": "running",
        }
        logger.debug(
            "pipeline_stage_start",
            run_id=self.run_id,
            source=self.source_name,
            stage=stage,
        )

    def complete(self, stage: ScanStage, duration_ms: int = 0, details: dict | None = None) -> None:
        if stage in self.stages:
            self.stages[stage]["status"] = "completed"
            self.stages[stage]["duration_ms"] = duration_ms
            if details:
                self.stages[stage]["details"] = details
        logger.debug(
            "pipeline_stage_complete",
            run_id=self.run_id,
            source=self.source_name,
            stage=stage,
            duration_ms=duration_ms,
        )

    def fail(self, stage: ScanStage, error: str) -> None:
        if stage in self.stages:
            self.stages[stage]["status"] = "failed"
            self.stages[stage]["error"] = error
        logger.warning(
            "pipeline_stage_fail",
            run_id=self.run_id,
            source=self.source_name,
            stage=stage,
            error=error,
        )

    def to_dict(self) -> dict:
        return {
            "run_id": self.run_id,
            "source_id": self.source_id,
            "source_name": self.source_name,
            "stages": self.stages,
        }
