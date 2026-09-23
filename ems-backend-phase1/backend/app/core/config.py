"""
Centralized application configuration.

All configuration comes from environment variables (optionally loaded
from a local .env file in development). Nothing here is hard-coded
per-environment, so the same code runs in dev / staging / production
just by changing environment variables (Section 27 / 39 of the spec:
no secrets in source control, environment-based config).
"""
from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- App ---
    app_name: str = "Equipment Maintenance Reporting System"
    environment: Literal["development", "staging", "production", "test"] = "development"
    debug: bool = False

    # --- Database ---
    database_url: str = Field(
        default="postgresql+asyncpg://ems_user:ems_password@localhost:5432/ems_db",
        description="Async SQLAlchemy connection string.",
    )

    # --- Auth ---
    jwt_secret_key: str = Field(
        default="CHANGE_ME_IN_PRODUCTION",
        description="Secret used to sign JWTs. Must be overridden via env var in every real deployment.",
    )
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 30
    refresh_token_expire_days: int = 7

    # --- Business rules (defaults; overridable by system_settings table at runtime later) ---
    default_report_edit_window_hours: int = 24
    timezone: str = "Asia/Tehran"

    # --- CORS ---
    cors_allow_origins: list[str] = ["http://localhost:5173"]

    # --- Logging ---
    log_level: str = "INFO"


@lru_cache
def get_settings() -> Settings:
    """Settings are cached (loaded once per process) but not hard-coded."""
    return Settings()
