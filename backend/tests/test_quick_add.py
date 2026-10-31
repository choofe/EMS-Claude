"""Phase 6c — quick-add people (participant-suggestions): colleagues frequent in the author's OWN reports (30 days, >= 2).
Same eligibility rule as the candidate list."""
from datetime import datetime, timedelta, timezone

import pytest

import app.models as m
from tests import factories as f

pytestmark = pytest.mark.asyncio
NOW = lambda: datetime.now(timezone.utc)  # noqa: E731
_n = 0


async def mk(db, world, creator, people, days_ago=1, grp=None, active=True, minutes=30):
    """An own-created report `days_ago` days old with participants `people` (users)."""
    global _n
    _n += 1
    rt = await f.report_type(db)
    r = m.Report(report_number=f"26-ELV-{_n:03d}", equipment_id=world.e1.id, group_id=(grp or world.elv).id,
                 report_type_id=rt.id, event_datetime=NOW() - timedelta(days=days_ago), report_jalali_year=1405,
                 created_by=creator.id, description="t", is_active=active, created_at=NOW() - timedelta(days=days_ago))
    db.add(r)
    await db.flush()
    for u in people:
        db.add(m.ReportParticipant(report_id=r.id, user_id=u.id, minutes=minutes))
    await db.commit()
    return r


def url(world, **q):
    return "/reports/participant-suggestions?" + ("equipment_id=%d" % world.e1.id if not q else "&".join(f"{k}={v}" for k, v in q.items()))


def ids(rows):
    return [x["id"] for x in rows]


@pytest.fixture
async def crew(db, world):
    c = [await f.user(db, f"c{i}", "USER", [world.elv]) for i in range(7)]
    await db.commit()
    return c


async def two(db, world, creator, people, days_ago=2, **kw):
    """Two own reports containing `people`: the minimum that makes someone "frequent"."""
    await mk(db, world, creator, people, days_ago=days_ago, **kw)
    await mk(db, world, creator, people, days_ago=days_ago + 1, **kw)


async def test_frequent_needs_two_own_reports_in_30_days(api, db, world, crew):
    await mk(db, world, world.ali, [crew[0], crew[1]], days_ago=2)
    await mk(db, world, world.ali, [crew[0]], days_ago=10)
    await mk(db, world, world.ali, [crew[1]], days_ago=40)  # outside the window: does not count
    await mk(db, world, world.ali, [crew[2]], days_ago=1)   # a single report: not frequent
    r = await api.get(url(world), "ali")
    assert r.status_code == 200
    assert r.json() == {"frequent": [{"id": crew[0].id, "full_name": crew[0].full_name}]}  # ids+names only, no minutes


async def test_reports_where_caller_was_only_a_participant_are_never_used(api, db, world, crew):
    await two(db, world, world.exp, [world.ali, crew[0]])
    assert (await api.get(url(world), "ali")).json() == {"frequent": []}


async def test_other_users_reports_do_not_leak(api, db, world, crew):
    await two(db, world, world.exp, [crew[0], crew[1]])
    await two(db, world, world.ali, [crew[2]])
    assert ids((await api.get(url(world), "ali")).json()["frequent"]) == [crew[2].id]


async def test_soft_deleted_reports_are_ignored(api, db, world, crew):
    await two(db, world, world.ali, [crew[0]])
    await two(db, world, world.ali, [crew[1]], active=False)
    assert ids((await api.get(url(world), "ali")).json()["frequent"]) == [crew[0].id]


async def test_author_is_never_suggested(api, db, world, crew):
    await two(db, world, world.ali, [world.ali, crew[0]])
    assert ids((await api.get(url(world), "ali")).json()["frequent"]) == [crew[0].id]


async def test_ordered_by_report_count_then_recency_and_capped_at_the_pool(api, db, world, crew, monkeypatch):
    import app.services.report_creation as rc
    monkeypatch.setattr(rc, "FREQUENT_POOL", 3)
    for _ in range(3):
        await mk(db, world, world.ali, [crew[0]], days_ago=5)      # 3 reports
    for i in (1, 2):
        await mk(db, world, world.ali, [crew[i]], days_ago=9)
        await mk(db, world, world.ali, [crew[i]], days_ago={1: 4, 2: 2}[i])  # 2 reports each; crew[2] is the more recent
    for i in (3, 4):
        await two(db, world, world.ali, [crew[i]], days_ago=20)    # 2 reports each, older
    assert ids((await api.get(url(world), "ali")).json()["frequent"]) == [crew[0].id, crew[2].id, crew[1].id]


async def test_suggestions_are_revalidated_for_the_forms_group(api, db, world, crew):
    far = await f.user(db, "far", "USER", [world.door])
    await db.commit()
    await two(db, world, world.ali, [crew[0], far])
    assert ids((await api.get(url(world), "ali")).json()["frequent"]) == [crew[0].id]  # a DOOR member is not eligible in ELV for a USER
    db.add(m.SystemSetting(key="REPORT_USER_PARTICIPANTS_ALL_USERS", value="1"))
    await db.commit()
    assert set(ids((await api.get(url(world), "ali")).json()["frequent"])) == {crew[0].id, far.id}


async def test_inactive_people_are_not_suggested(api, db, world, crew):
    await two(db, world, world.ali, [crew[0], crew[1]])
    crew[1].is_active = False
    await db.commit()
    assert ids((await api.get(url(world), "ali")).json()["frequent"]) == [crew[0].id]


async def test_scope_and_params_and_roles(api, db, world):
    assert (await api.get(f"/reports/participant-suggestions?equipment_id={world.d1.id}", "ali")).status_code == 404
    assert (await api.get("/reports/participant-suggestions", "ali")).status_code == 422
    assert (await api.get(f"/reports/participant-suggestions?equipment_id={world.e1.id}&group_id={world.elv.id}", "ali")).status_code == 422
    assert (await api.get(url(world), "aud")).status_code == 403
    assert (await api.get(f"/reports/participant-suggestions?group_id={world.elv.id}", "ali")).status_code == 200
    assert (await api.get(f"/reports/participant-suggestions?group_id={world.door.id}", "ali")).status_code == 404


async def test_expert_and_management_follow_their_own_eligibility(api, db, world, crew):
    far = await f.user(db, "far", "USER", [world.door])
    await db.commit()
    await two(db, world, world.exp, [crew[0], far])
    assert set(ids((await api.get(url(world), "exp")).json()["frequent"])) == {crew[0].id, far.id}  # EXPERT: any user (default 1)
    await two(db, world, world.boss, [far])
    assert ids((await api.get(url(world), "boss")).json()["frequent"]) == [far.id]
