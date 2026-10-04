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

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Placeholder used ONLY for local development / tests. Production refuses to
# start with it (see Settings._check_production_safety). 32+ chars so PyJWT
# does not warn about short HMAC keys.
INSECURE_DEV_JWT_SECRET = "dev-only-insecure-jwt-secret-do-not-use-in-production"
# Placeholder shipped in .env.example — copying that file unchanged must not pass the production check.
_PLACEHOLDER_SECRET_PREFIXES = ("replace-with", "change_me", "changeme", "dev-only")


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

    test_database_url: str | None = Field(
        default=None,
        description=(
            "Optional. Async URL of a DEDICATED test database (name must end "
            "with _test). When set, the Postgres-backed tests in tests/postgres/ "
            "run against it; when unset they are skipped."
        ),
    )

    # --- Auth ---
    jwt_secret_key: str = Field(
        default=INSECURE_DEV_JWT_SECRET,
        description="Secret used to sign JWTs. Must be overridden via env var in every real deployment.",
    )
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 15
    refresh_token_expire_days: int = 7

    # Refresh token cookie (HttpOnly). The access token is never a cookie.
    # Secure/SameSite/Domain are env-driven because the right values depend on
    # how the frontend and API are hosted (same-site vs cross-site) — decided
    # in Phase 12. Defaults suit local development over plain http.
    refresh_cookie_name: str = "ems_refresh"
    refresh_cookie_path: str = "/auth"
    refresh_cookie_secure: bool = False
    refresh_cookie_samesite: Literal["lax", "strict", "none"] = "lax"
    refresh_cookie_domain: str | None = None

    # Client-IP source for login throttling/audit. When True, the LAST entry
    # of X-Forwarded-For is used (the one appended by our own reverse proxy;
    # earlier entries are client-controlled). Only enable behind exactly one
    # trusted proxy.
    trust_forwarded_for: bool = False

    # --- Business rules (defaults; overridable by system_settings table at runtime later) ---
    default_report_edit_window_hours: int = 24
    timezone: str = "Asia/Tehran"

    # --- CORS ---
    cors_allow_origins: list[str] = ["http://localhost:5173"]

    # --- Logging ---
    log_level: str = "INFO"

    @model_validator(mode="after")
    def _check_production_safety(self) -> "Settings":
        if self.environment in ("production", "staging"):
            if (
                self.jwt_secret_key.lower().startswith(_PLACEHOLDER_SECRET_PREFIXES)
                or len(self.jwt_secret_key) < 32
            ):
                raise ValueError(
                    "JWT_SECRET_KEY must be set to a random value of at least 32 characters "
                    f"when ENVIRONMENT={self.environment}."
                )
            if not self.refresh_cookie_secure:
                raise ValueError(
                    f"REFRESH_COOKIE_SECURE must be true when ENVIRONMENT={self.environment}."
                )
        if self.refresh_cookie_samesite == "none" and not self.refresh_cookie_secure:
            raise ValueError("REFRESH_COOKIE_SAMESITE=none requires REFRESH_COOKIE_SECURE=true.")
        return self


@lru_cache
def get_settings() -> Settings:
    """Settings are cached (loaded once per process) but not hard-coded."""
    return Settings()
