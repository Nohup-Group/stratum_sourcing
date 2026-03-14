"""FastAPI application factory."""

import structlog
from fastapi import FastAPI, Request

from app.api.routes import router

logger = structlog.get_logger()


def create_app() -> FastAPI:
    application = FastAPI(
        title="Stratum Sourcing Monitor",
        version="0.1.0",
        description="Daily monitoring tool for Stratum 3Ventures sourcing pipeline",
    )
    application.include_router(router)

    # Mount Slack Bolt app for events + slash commands
    from app.integrations.slack_bot import get_slack_app

    slack_app = get_slack_app()
    if slack_app is not None:
        from slack_bolt.adapter.fastapi.async_handler import AsyncSlackRequestHandler

        slack_handler = AsyncSlackRequestHandler(slack_app)

        @application.post("/slack/events")
        async def slack_events(req: Request):
            return await slack_handler.handle(req)

        @application.post("/slack/interactions")
        async def slack_interactions(req: Request):
            return await slack_handler.handle(req)

        logger.info("slack_bolt_mounted", routes=["/slack/events", "/slack/interactions"])
    else:
        logger.warning("slack_bolt_not_mounted", reason="tokens not configured")

    return application


app = create_app()
