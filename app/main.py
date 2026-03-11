"""FastAPI application factory."""

import structlog
from fastapi import FastAPI

from app.api.routes import router

logger = structlog.get_logger()


def create_app() -> FastAPI:
    app = FastAPI(
        title="Stratum Sourcing Monitor",
        version="0.1.0",
        description="Daily monitoring tool for Stratum 3Ventures sourcing pipeline",
    )
    app.include_router(router)
    return app


app = create_app()
