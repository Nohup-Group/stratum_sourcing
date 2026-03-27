"""Centralized configuration via Pydantic Settings (environment-driven)."""

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # --- Database ---
    database_url: str = Field(
        default="postgresql+asyncpg://postgres:postgres@localhost:5432/stratum_sourcing",
        alias="DATABASE_URL",
    )

    @property
    def sync_database_url(self) -> str:
        """Synchronous DB URL for Alembic migrations."""
        return self.database_url.replace("+asyncpg", "").replace("asyncpg://", "postgresql://")

    # --- Slack ---
    slack_bot_token: str = Field(default="", alias="SLACK_BOT_TOKEN")
    slack_signing_secret: str = Field(default="", alias="SLACK_SIGNING_SECRET")
    slack_app_token: str = Field(default="", alias="SLACK_APP_TOKEN")
    slack_channel_sourcing: str = Field(default="#sourcing", alias="SLACK_CHANNEL_SOURCING")

    # --- Notion ---
    notion_api_key: str = Field(default="", alias="NOTION_API_KEY")
    notion_api_version: str = Field(default="2026-03-11", alias="NOTION_API_VERSION")
    notion_ocean_database_id: str = Field(default="", alias="NOTION_OCEAN_DATABASE_ID")
    notion_parent_page_id: str = Field(default="", alias="NOTION_PARENT_PAGE_ID")
    notion_source_registry_database_id: str = Field(
        default="", alias="NOTION_SOURCE_REGISTRY_DATABASE_ID"
    )
    notion_company_watchlist_database_id: str = Field(
        default="", alias="NOTION_COMPANY_WATCHLIST_DATABASE_ID"
    )
    notion_people_watchlist_database_id: str = Field(
        default="", alias="NOTION_PEOPLE_WATCHLIST_DATABASE_ID"
    )
    notion_webhook_verification_token: str = Field(
        default="", alias="NOTION_WEBHOOK_VERIFICATION_TOKEN"
    )

    # --- LLM ---
    # Option 1 (production): OpenClaw gateway with Codex OAuth
    openclaw_gateway_url: str = Field(default="", alias="OPENCLAW_GATEWAY_URL")
    openclaw_gateway_token: str = Field(default="", alias="OPENCLAW_GATEWAY_TOKEN")
    openclaw_internal_port: int = Field(default=9080, alias="OPENCLAW_INTERNAL_PORT")
    # Option 2 (fallback): Direct Anthropic API
    anthropic_api_key: str = Field(default="", alias="ANTHROPIC_API_KEY")
    # Option 3 (fallback): Direct OpenAI API key
    openai_api_key: str = Field(default="", alias="OPENAI_API_KEY")
    # OAuth minter (used by OpenClaw for Codex auth on Railway)
    oauth_minter_url: str = Field(default="", alias="OAUTH_MINTER_URL")
    oauth_minter_key: str = Field(default="", alias="OAUTH_MINTER_KEY")
    llm_model: str = Field(default="gpt-5.4", alias="LLM_MODEL")
    embedding_model: str = Field(default="qwen/qwen3-embedding-8b", alias="EMBEDDING_MODEL")
    # --- OpenRouter (embeddings) ---
    openrouter_api_key: str = Field(default="", alias="OPENROUTER_API_KEY")

    # --- Cron / Security ---
    cron_secret: str = Field(default="", alias="CRON_SECRET")
    lexie_ops_url: str = Field(default="", alias="LEXIE_OPS_URL")
    lexie_ops_token: str = Field(default="", alias="LEXIE_OPS_TOKEN")

    # --- Persistent volume ---
    data_dir: str = Field(default="/data", alias="DATA_DIR")

    # --- Scraping ---
    fetch_timeout_seconds: int = Field(default=30, alias="FETCH_TIMEOUT_SECONDS")
    fetch_concurrency: int = Field(default=5, alias="FETCH_CONCURRENCY")
    browser_rate_limit_seconds: float = Field(default=10.0, alias="BROWSER_RATE_LIMIT_SECONDS")

    # --- Scoring weights ---
    score_weight_vertical: float = Field(default=0.40)
    score_weight_geographic: float = Field(default=0.15)
    score_weight_stage: float = Field(default=0.15)
    score_weight_recency: float = Field(default=0.15)
    score_weight_authority: float = Field(default=0.15)

    # --- Scheduler / auto-growth ---
    auto_growth_daily_limit: int = Field(default=5, alias="AUTO_GROWTH_DAILY_LIMIT")
    auto_growth_per_parent_limit: int = Field(default=2, alias="AUTO_GROWTH_PER_PARENT_LIMIT")
    watchlist_company_threshold: float = Field(default=0.55, alias="WATCHLIST_COMPANY_THRESHOLD")
    watchlist_people_threshold: float = Field(default=0.50, alias="WATCHLIST_PEOPLE_THRESHOLD")


settings = Settings()
