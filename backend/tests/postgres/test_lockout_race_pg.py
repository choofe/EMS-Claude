"""Lockout must hold under CONCURRENT attempts (reviewer finding F1/AUTH-03): the check-then-record
sequence used to let many parallel guesses pass the count before any failure was committed."""
import asyncio

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

import app.models as m
from app.services.auth_service import InvalidCredentials, TooManyAttempts, login
from tests import factories as f


async def test_parallel_bad_logins_never_exceed_the_lockout_limit(committed_engine):
    async with AsyncSession(committed_engine, expire_on_commit=False) as s:
        await f.user(s, "ali", "USER")
        await s.commit()

    async def attempt(pw):
        async with AsyncSession(committed_engine, expire_on_commit=False) as s:
            try:
                await login(s, "ali", pw, None)
                return "ok"
            except InvalidCredentials:
                return "invalid"
            except TooManyAttempts:
                return "locked"

    results = await asyncio.gather(*[attempt("wrong-password-x") for _ in range(16)])
    async with AsyncSession(committed_engine) as s:
        recorded = (await s.execute(
            select(func.count()).select_from(m.LoginAttempt).where(m.LoginAttempt.success.is_(False))
        )).scalar_one()

    assert results.count("ok") == 0
    assert results.count("invalid") <= 5          # at most 5 guesses ever reach password verification
    assert recorded == results.count("invalid") <= 5

    # after the burst the account is locked even for the right password
    async with AsyncSession(committed_engine, expire_on_commit=False) as s:
        try:
            await login(s, "ali", f.PASSWORD, None)
            outcome = "ok"
        except TooManyAttempts:
            outcome = "locked"
    assert outcome == "locked" or results.count("invalid") < 5
