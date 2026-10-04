from datetime import timedelta

import jwt
import pytest

from app.core import security as sec
from app.core.config import get_settings


def test_password_hash_roundtrip_and_argon2id():
    h = sec.hash_password("a-long-enough-password")
    assert h.startswith("$argon2id$")
    assert sec.verify_password(h, "a-long-enough-password")
    assert not sec.verify_password(h, "wrong")
    assert not sec.verify_password("not-a-hash", "x")  # garbage hash -> False, no exception


def test_hash_is_salted():
    assert sec.hash_password("same-password") != sec.hash_password("same-password")


def test_access_token_roundtrip_carries_only_identity():
    token, expires_in = sec.create_access_token(42)
    assert sec.decode_access_token(token) == 42
    assert expires_in == get_settings().access_token_expire_minutes * 60
    payload = jwt.decode(token, options={"verify_signature": False})
    assert set(payload) == {"sub", "typ", "iat", "exp", "jti"}  # no role / groups inside


def test_expired_token_rejected():
    past = sec.utcnow() - timedelta(hours=2)
    token, _ = sec.create_access_token(1, now=past)
    assert sec.decode_access_token(token) is None


def test_wrong_secret_rejected():
    s = get_settings()
    forged = jwt.encode({"sub": "1", "typ": "access", "iat": sec.utcnow(), "exp": sec.utcnow() + timedelta(minutes=5)},
                        "x" * 40, algorithm="HS256")
    assert sec.decode_access_token(forged) is None


def test_alg_none_rejected():
    forged = jwt.encode({"sub": "1", "typ": "access", "iat": sec.utcnow(), "exp": sec.utcnow() + timedelta(minutes=5)},
                        None, algorithm="none")
    assert sec.decode_access_token(forged) is None


def test_wrong_token_type_rejected():
    s = get_settings()
    t = jwt.encode({"sub": "1", "typ": "refresh", "iat": sec.utcnow(), "exp": sec.utcnow() + timedelta(minutes=5)},
                   s.jwt_secret_key, algorithm=s.jwt_algorithm)
    assert sec.decode_access_token(t) is None


def test_garbage_tokens_rejected():
    for bad in ("", "abc", "a.b.c", "Bearer x"):
        assert sec.decode_access_token(bad) is None


def test_refresh_token_properties():
    a, b = sec.new_refresh_token(), sec.new_refresh_token()
    assert a != b and len(a) >= 60
    assert sec.hash_refresh_token(a) == sec.hash_refresh_token(a)
    assert sec.hash_refresh_token(a) != a and len(sec.hash_refresh_token(a)) == 64


def test_production_refuses_insecure_config():
    from pydantic import ValidationError
    from app.core.config import Settings, INSECURE_DEV_JWT_SECRET

    with pytest.raises(ValidationError):
        Settings(environment="production", jwt_secret_key=INSECURE_DEV_JWT_SECRET, refresh_cookie_secure=True)
    with pytest.raises(ValidationError):
        Settings(environment="production", jwt_secret_key="short", refresh_cookie_secure=True)
    with pytest.raises(ValidationError):
        Settings(environment="production", jwt_secret_key="x1y2z3Q9w8e7r6t5y4u3i2o1p0LKJHGF", refresh_cookie_secure=False)
    with pytest.raises(ValidationError):
        Settings(refresh_cookie_samesite="none", refresh_cookie_secure=False)
    # the exact placeholder from .env.example must be refused too
    with pytest.raises(ValidationError):
        Settings(environment="production", jwt_secret_key="replace-with-a-long-random-value", refresh_cookie_secure=True)
    with pytest.raises(ValidationError):
        Settings(environment="staging", jwt_secret_key="CHANGE_ME_IN_PRODUCTION_" + "x" * 20, refresh_cookie_secure=True)
    assert Settings(environment="production", jwt_secret_key="x1y2z3Q9w8e7r6t5y4u3i2o1p0LKJHGF", refresh_cookie_secure=True)


def test_config_hardening_from_review():
    from pydantic import ValidationError
    from app.core.config import Settings

    ok = dict(environment="production", refresh_cookie_secure=True)
    with pytest.raises(ValidationError):
        Settings(jwt_algorithm="none")                                   # only HMAC algorithms allowed
    with pytest.raises(ValidationError):
        Settings(jwt_algorithm="RS256")
    with pytest.raises(ValidationError):
        Settings(jwt_secret_key="a" * 40, **ok)                          # long but zero entropy
    with pytest.raises(ValidationError):
        Settings(jwt_secret_key="ab" * 20, **ok)
    with pytest.raises(ValidationError):
        Settings(jwt_secret_key="x1y2z3Q9w8e7r6t5y4u3i2o1p0LKJHGF", cors_allow_origins=["*"], **ok)
    assert Settings(jwt_secret_key="x1y2z3Q9w8e7r6t5y4u3i2o1p0LKJHGF", **ok)
    assert Settings(jwt_secret_key="0123456789abcdef" * 4, **ok)         # `openssl rand -hex 32` style passes
