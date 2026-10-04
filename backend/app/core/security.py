"""
Cryptographic primitives for authentication.

* Passwords: Argon2id (argon2-cffi defaults = RFC 9106 low-memory profile,
  ~64 MiB per hash). Hashing/verification is CPU- and memory-heavy, so the
  async wrappers run it in a worker thread to keep the event loop responsive.
* Access tokens: short-lived HS256 JWTs carrying ONLY the user id. Role and
  group membership are deliberately NOT embedded — they are re-read from the
  database on every request so deactivation / role changes take effect
  immediately instead of after token expiry.
* Refresh tokens: random opaque strings; only their SHA-256 hash is stored.
"""
import asyncio
import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from functools import lru_cache

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

from app.core.config import get_settings

_hasher = PasswordHasher()  # Argon2id


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def as_utc(dt: datetime) -> datetime:
    """SQLite returns naive datetimes; treat them as UTC (we only ever store UTC)."""
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


# --- passwords -----------------------------------------------------------

def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(hashed: str, password: str) -> bool:
    try:
        return _hasher.verify(hashed, password)
    except (VerificationError, InvalidHashError):
        return False


def password_needs_rehash(hashed: str) -> bool:
    return _hasher.check_needs_rehash(hashed)


@lru_cache
def _dummy_hash() -> str:
    return _hasher.hash("timing-equalisation-dummy-password")


def verify_dummy(password: str) -> None:
    """Spend the same time as a real verify when the username does not exist."""
    verify_password(_dummy_hash(), password)


async def ahash_password(password: str) -> str:
    return await asyncio.to_thread(hash_password, password)


async def averify_password(hashed: str, password: str) -> bool:
    return await asyncio.to_thread(verify_password, hashed, password)


async def averify_dummy(password: str) -> None:
    await asyncio.to_thread(verify_dummy, password)


# --- access tokens (JWT) -------------------------------------------------

ACCESS_TOKEN_TYPE = "access"


def create_access_token(user_id: int, now: datetime | None = None) -> tuple[str, int]:
    """Returns (token, expires_in_seconds)."""
    settings = get_settings()
    now = now or utcnow()
    lifetime = timedelta(minutes=settings.access_token_expire_minutes)
    payload = {
        "sub": str(user_id),
        "typ": ACCESS_TOKEN_TYPE,
        "iat": now,
        "exp": now + lifetime,
        "jti": uuid.uuid4().hex,
    }
    token = jwt.encode(payload, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)
    return token, int(lifetime.total_seconds())


def decode_access_token(token: str) -> int | None:
    """Returns the user id, or None for ANY problem (bad signature, expired, wrong type...)."""
    settings = get_settings()
    try:
        payload = jwt.decode(
            token,
            settings.jwt_secret_key,
            algorithms=[settings.jwt_algorithm],  # pinned: never trust the token's own "alg"
            options={"require": ["exp", "iat", "sub"]},
        )
        if payload.get("typ") != ACCESS_TOKEN_TYPE:
            return None
        return int(payload["sub"])
    except (jwt.PyJWTError, ValueError, TypeError):
        return None


# --- refresh tokens ------------------------------------------------------

def new_refresh_token() -> str:
    return secrets.token_urlsafe(48)


def hash_refresh_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def new_family_id() -> str:
    return uuid.uuid4().hex
