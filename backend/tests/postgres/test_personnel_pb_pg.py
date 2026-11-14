"""Personnel phase Pb on real PostgreSQL: concurrent writers meet the unique indexes and the manager guards, and
always get a clean DomainError (409), never a raw IntegrityError."""
import asyncio

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

import app.models as m
from app.core.errors import DomainError
from app.services import personnel_admin
from app.services.auth_service import load_principal
from tests import factories as f


async def _boss(engine):
    async with AsyncSession(engine, expire_on_commit=False) as s:
        b = await f.user(s, "boss_a", "MANAGEMENT")
        await s.commit()
        return await load_principal(s, b.id)


@pytest.mark.parametrize("round_", range(3))
async def test_concurrent_new_people_with_the_same_code_or_mobile_yield_one_row_and_one_clean_409(committed_engine, round_):
    actor = await _boss(committed_engine)

    async def create(first, mobile):
        async with AsyncSession(committed_engine, expire_on_commit=False) as s:
            return await personnel_admin.create_person(s, actor=actor, first_name=first, last_name="X",
                                                       personnel_code="55", mobile=mobile, group_ids=[])

    r = await asyncio.gather(create("A", "09120000001"), create("B", "09120000002"), return_exceptions=True)
    assert sum(isinstance(x, dict) for x in r) == 1
    assert [x.code for x in r if isinstance(x, DomainError)] == ["personnel_code_taken"], r
    async with AsyncSession(committed_engine) as s:
        assert (await s.execute(select(func.count()).select_from(m.User).where(m.User.personnel_code == 55))).scalar_one() == 1

    async def same_mobile(code):
        async with AsyncSession(committed_engine, expire_on_commit=False) as s:
            return await personnel_admin.create_person(s, actor=actor, first_name="C", last_name="X",
                                                       personnel_code=code, mobile="09129999999", group_ids=[])

    r = await asyncio.gather(same_mobile("61"), same_mobile("62"), return_exceptions=True)
    assert sum(isinstance(x, dict) for x in r) == 1
    assert [x.code for x in r if isinstance(x, DomainError)] == ["mobile_taken"], r


async def test_concurrent_code_assignment_to_two_people_gives_one_winner(committed_engine):
    actor = await _boss(committed_engine)
    async with AsyncSession(committed_engine, expire_on_commit=False) as s:
        a, b = await f.person(s, "A", "One"), await f.person(s, "B", "Two")
        await s.commit()
        ids = (a.id, b.id)

    async def assign(uid):
        async with AsyncSession(committed_engine, expire_on_commit=False) as s:
            return await personnel_admin.set_personnel_code(s, actor=actor, user_id=uid, personnel_code="77",
                                                            reason=None, note=None)

    r = await asyncio.gather(*(assign(i) for i in ids), return_exceptions=True)
    assert sum(isinstance(x, dict) for x in r) == 1
    assert [x.code for x in r if isinstance(x, DomainError)] == ["personnel_code_taken"], r


async def test_concurrent_login_disable_of_both_managers_keeps_one(committed_engine):
    async with AsyncSession(committed_engine, expire_on_commit=False) as s:
        a, b = await f.user(s, "boss_a", "MANAGEMENT"), await f.user(s, "boss_b", "MANAGEMENT")
        await s.commit()
        pa, pb = await load_principal(s, a.id), await load_principal(s, b.id)
        a_id, b_id = a.id, b.id

    async def disable(actor, target):
        async with AsyncSession(committed_engine, expire_on_commit=False) as s:
            return await personnel_admin.set_login_enabled(s, actor=actor, user_id=target, enabled=False)

    r = await asyncio.gather(disable(pa, b_id), disable(pb, a_id), return_exceptions=True)
    assert sum(isinstance(x, dict) for x in r) == 1 and [x.code for x in r if isinstance(x, DomainError)] == ["last_management"], r
    async with AsyncSession(committed_engine) as s:
        n = (await s.execute(select(func.count()).select_from(m.User).join(m.Role).where(
            m.Role.code == "MANAGEMENT", m.User.is_active.is_(True), m.User.login_enabled.is_(True)))).scalar_one()
    assert n == 1
