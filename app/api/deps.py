"""FastAPI dependency injection."""

from collections.abc import AsyncGenerator

from fastapi import Depends, Header, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    async for session in get_db():
        yield session


async def verify_cron_secret(x_cron_secret: str = Header(...)) -> str:
    if not settings.cron_secret:
        raise HTTPException(status_code=500, detail="CRON_SECRET not configured")
    if x_cron_secret != settings.cron_secret:
        raise HTTPException(status_code=403, detail="Invalid cron secret")
    return x_cron_secret
