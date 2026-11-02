"""Phase 6d — favorite people: a user's private starred shortlist in the report person picker.
Covers privacy (nobody sees anybody's stars), eligibility at star time (one 404 for missing/inactive/ineligible), eligibility
again at use time, the per-user cap, the server-side "favorites only" switch, and the DB constraints."""
import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

import app.models as m
from app.core.permissions import Principal
from app.services.report_creation import participant_filter, participant_filter_any_group
from app.services.runtime_settings import ReportEntryPolicy
from tests import factories as f
from tests.test_report_creation import body, set_setting

pytestmark = pytest.mark.asyncio


def cand(world, **q):
    qs = "&".join([f"equipment_id={world.e1.id}"] + [f"{k}={v}" for k, v in q.items()])
    return f"/reports/participant-candidates?{qs}"


def names(r):
    return [x["full_name"] for x in r.json()]


async def stars(db, owner):
    return sorted((await db.execute(select(m.FavoritePerson.favorite_user_id)
                                    .where(m.FavoritePerson.owner_id == owner.id))).scalars())


async def star(api, who, target):
    return await api.put(f"/reports/favorite-people/{target.id}", who)


@pytest.fixture
async def mates(db, world):
    """ELV colleagues ali can see besides himself and exp."""
    out = [await f.user(db, f"mate{i}", "USER", [world.elv]) for i in range(4)]
    await db.commit()
    return out


# ---------------------------------------------------------------- basics
async def test_star_unstar_flag_and_favorites_only_filter(api, db, world, mates):
    assert (await star(api, "ali", mates[0])).status_code == 204
    assert (await star(api, "ali", world.exp)).status_code == 204
    r = await api.get(cand(world), "ali")
    flags = {x["full_name"]: x["is_favorite"] for x in r.json()}
    assert flags["Mate0"] is True and flags["Exp"] is True and flags["Mate1"] is False and flags["Ali"] is False
    only = await api.get(cand(world, favorites_only="true"), "ali")
    assert names(only) == ["Exp", "Mate0"]  # same eligibility filter, alphabetical
    assert names(await api.get(cand(world, favorites_only="true", q="mat"), "ali")) == ["Mate0"]  # search works inside the stars
    assert (await api.delete(f"/reports/favorite-people/{mates[0].id}", "ali")).status_code == 204
    assert names(await api.get(cand(world, favorites_only="true"), "ali")) == ["Exp"]
    assert await stars(db, world.ali) == [world.exp.id]


async def test_star_and_unstar_are_idempotent(api, db, world, mates):
    for _ in range(2):
        assert (await star(api, "ali", mates[0])).status_code == 204
    assert await stars(db, world.ali) == [mates[0].id]
    for _ in range(2):
        assert (await api.delete(f"/reports/favorite-people/{mates[0].id}", "ali")).status_code == 204
    assert (await api.delete("/reports/favorite-people/999999", "ali")).status_code == 204  # silent about existence
    assert await stars(db, world.ali) == []


# ---------------------------------------------------------------- privacy
async def test_stars_are_private_to_their_owner(api, db, world, mates):
    await star(api, "ali", mates[0])
    other = await api.get(cand(world), "exp")  # someone else's list never shows ali's stars
    assert all(x["is_favorite"] is False for x in other.json())
    assert names(await api.get(cand(world, favorites_only="true"), "exp")) == []
    # un-starring as somebody else must not touch ali's row
    await api.delete(f"/reports/favorite-people/{mates[0].id}", "exp")
    assert await stars(db, world.ali) == [mates[0].id]


async def test_a_star_never_adds_anybody_to_the_candidate_list(api, db, world, mates):
    """Even a hand-made row for an ineligible person (other group) stays invisible: eligibility is applied first."""
    db.add(m.FavoritePerson(owner_id=world.ali.id, favorite_user_id=world.omid.id))
    await db.commit()
    assert names(await api.get(cand(world, favorites_only="true"), "ali")) == []
    assert "Omid" not in names(await api.get(cand(world), "ali"))


# ---------------------------------------------------------------- eligibility at star time
async def test_ineligible_missing_and_inactive_targets_answer_the_same_404(api, db, world):
    gone = await f.user(db, "gone", "USER", [world.elv], active=False)
    await db.commit()
    answers = []
    for target_id in (world.omid.id, 999999, gone.id, world.boss.id):  # other group, no such id, inactive, manager outside ali's groups
        r = await api.put(f"/reports/favorite-people/{target_id}", "ali")
        answers.append((r.status_code, r.json()))
    assert {a[0] for a in answers} == {404} and len({str(a[1]) for a in answers}) == 1  # identical bodies: no id probing
    assert await stars(db, world.ali) == []


async def test_self_cannot_be_starred(api, db, world):
    r = await api.put(f"/reports/favorite-people/{world.ali.id}", "ali")
    assert r.status_code == 422 and r.json()["detail"] == "favorite_self"


async def test_star_time_rule_follows_the_participant_settings(api, db, world):
    assert (await star(api, "ali", world.omid)).status_code == 404
    await set_setting(db, "REPORT_USER_PARTICIPANTS_ALL_USERS", 1)
    assert (await star(api, "ali", world.omid)).status_code == 204
    # managers and experts (default setting) may star anybody active
    assert (await star(api, "boss", world.omid)).status_code == 204
    assert (await star(api, "exp", world.omid)).status_code == 204


async def test_only_report_creators_can_use_the_endpoints(api, db, world, mates):
    assert (await star(api, "aud", mates[0])).status_code == 403
    assert (await api.delete(f"/reports/favorite-people/{mates[0].id}", "aud")).status_code == 403
    assert (await api.put("/reports/favorites-filter", "aud", json={"favorites_only": True})).status_code == 403
    assert (await api.put(f"/reports/favorite-people/{mates[0].id}")).status_code == 401


# ---------------------------------------------------------------- eligibility again at use time
async def test_a_star_for_someone_no_longer_eligible_is_hidden_but_removable(api, db, world):
    assert (await star(api, "exp", world.omid)).status_code == 204  # experts may list anybody (default)
    assert names(await api.get(cand(world, favorites_only="true"), "exp")) == ["Omid"]
    await set_setting(db, "REPORT_EXPERT_PARTICIPANTS_ALL_USERS", 0)  # now only members of the report's group
    assert names(await api.get(cand(world, favorites_only="true"), "exp")) == []
    assert (await api.delete(f"/reports/favorite-people/{world.omid.id}", "exp")).status_code == 204  # removal needs no eligibility
    assert await stars(db, world.exp) == []


async def test_a_star_does_not_let_an_ineligible_person_onto_a_report(api, db, world):
    await star(api, "exp", world.omid)
    await set_setting(db, "REPORT_EXPERT_PARTICIPANTS_ALL_USERS", 0)
    rt = await f.report_type(db)
    await db.commit()
    r = await api.post("/reports", "exp", json=body(world, rt, participants=[{"user_id": world.omid.id, "minutes": 30}]))
    assert r.status_code == 422 and r.json()["detail"]["code"] == "participant_not_allowed"


async def test_deactivated_favorite_disappears_from_the_list(api, db, world, mates):
    await star(api, "ali", mates[0])
    mates[0].is_active = False
    await db.commit()
    assert names(await api.get(cand(world, favorites_only="true"), "ali")) == []


# ---------------------------------------------------------------- cap
async def test_cap_blocks_new_stars_only(api, db, world, mates):
    await set_setting(db, "FAVORITE_PEOPLE_MAX", 2)
    assert (await star(api, "ali", mates[0])).status_code == 204
    assert (await star(api, "ali", mates[1])).status_code == 204
    r = await star(api, "ali", mates[2])
    assert r.status_code == 409 and r.json()["detail"] == {"code": "favorites_limit_reached", "limit": 2}
    assert (await star(api, "ali", mates[1])).status_code == 204  # re-starring an existing one is not "new"
    await api.delete(f"/reports/favorite-people/{mates[0].id}", "ali")
    assert (await star(api, "ali", mates[2])).status_code == 204
    assert await stars(db, world.ali) == sorted([mates[1].id, mates[2].id])
    # another user's quota is independent
    assert (await star(api, "exp", mates[0])).status_code == 204


async def test_deactivated_people_do_not_fill_the_quota(api, db, world, mates):
    await set_setting(db, "FAVORITE_PEOPLE_MAX", 1)
    await star(api, "ali", mates[0])
    mates[0].is_active = False
    await db.commit()
    assert (await star(api, "ali", mates[1])).status_code == 204


async def test_people_no_longer_eligible_do_not_fill_the_quota_either(api, db, world, mates):
    await set_setting(db, "FAVORITE_PEOPLE_MAX", 1)
    assert (await star(api, "exp", world.omid)).status_code == 204  # experts may star anybody (default)
    assert (await star(api, "exp", mates[0])).status_code == 409    # quota is full
    await set_setting(db, "REPORT_EXPERT_PARTICIPANTS_ALL_USERS", 0)  # omid is now unusable for exp: his star is invisible
    assert (await star(api, "exp", mates[0])).status_code == 204      # ... so it must not block a visible one


async def test_default_cap_is_25_and_setting_is_bounded(api, db, world):
    cfg = (await api.get("/reports/entry-config", "ali")).json()
    assert cfg["max_favorite_people"] == 25 and cfg["favorites_only"] is False
    assert (await api.put("/settings/FAVORITE_PEOPLE_MAX", "boss", json={"value": 0})).status_code == 422
    assert (await api.put("/settings/FAVORITE_PEOPLE_MAX", "boss", json={"value": 101})).status_code == 422
    assert (await api.put("/settings/FAVORITE_PEOPLE_MAX", "boss", json={"value": 40})).status_code == 200
    assert (await api.get("/reports/entry-config", "ali")).json()["max_favorite_people"] == 40


# ---------------------------------------------------------------- server-side switch
async def test_favorites_only_switch_is_stored_per_user(api, db, world):
    r = await api.put("/reports/favorites-filter", "ali", json={"favorites_only": True})
    assert r.status_code == 200 and r.json() == {"favorites_only": True}
    assert (await api.get("/reports/entry-config", "ali")).json()["favorites_only"] is True
    assert (await api.get("/reports/entry-config", "exp")).json()["favorites_only"] is False  # nobody else is affected
    await api.put("/reports/favorites-filter", "ali", json={"favorites_only": False})
    assert (await api.get("/reports/entry-config", "ali")).json()["favorites_only"] is False
    rows = (await db.execute(select(m.UserReportPreference))).scalars().all()
    assert [(x.user_id, x.favorites_only) for x in rows] == [(world.ali.id, False)]  # one row per user, updated in place
    assert (await api.put("/reports/favorites-filter", "ali", json={"favorites_only": "maybe"})).status_code == 422
    assert (await api.put("/reports/favorites-filter", "ali", json={"favorites_only": True, "x": 1})).status_code == 422


# ---------------------------------------------------------------- DB constraints
async def test_db_refuses_self_star_and_duplicate_pairs(db, world, mates):
    ali_id, mate_id = world.ali.id, mates[0].id  # plain ints: a rollback expires ORM objects
    db.add(m.FavoritePerson(owner_id=ali_id, favorite_user_id=ali_id))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()
    db.add_all([m.FavoritePerson(owner_id=ali_id, favorite_user_id=mate_id),
                m.FavoritePerson(owner_id=ali_id, favorite_user_id=mate_id)])
    with pytest.raises(IntegrityError):
        await db.commit()


# ---------------------------------------------------------------- the two eligibility rules cannot drift
async def test_any_group_rule_is_exactly_the_union_of_the_per_group_rule(db, world):
    users = list((await db.execute(select(m.User))).scalars())
    for role_code, flags in ((r, fl) for r in ("USER", "EXPERT", "MANAGEMENT")
                             for fl in ((False, False), (True, False), (False, True), (True, True))):
        owner = next(u for u in users if u.username == {"USER": "ali", "EXPERT": "exp", "MANAGEMENT": "boss"}[role_code])
        groups = frozenset((await db.execute(select(m.UserGroup.group_id).where(m.UserGroup.user_id == owner.id))).scalars())
        p = Principal(user_id=owner.id, username=owner.username, full_name=owner.full_name, role_code=role_code,
                      role_label_fa="", group_ids=groups, must_change_password=False)
        policy = ReportEntryPolicy(expert_participants_all_users=flags[0], user_participants_all_users=flags[1], default_labor_minutes=30)
        any_ids = set((await db.execute(select(m.User.id).where(participant_filter_any_group(p, policy)))).scalars())
        union = set()
        for g in groups if role_code != "MANAGEMENT" else {world.elv.id, world.door.id}:
            union |= set((await db.execute(select(m.User.id).where(participant_filter(p, policy, g)))).scalars())
        if role_code == "MANAGEMENT" or (role_code == "EXPERT" and flags[0]) or (role_code == "USER" and flags[1]):
            assert any_ids == {u.id for u in users if u.is_active}  # unrestricted: any active user
        else:
            assert any_ids == union, (role_code, flags)
