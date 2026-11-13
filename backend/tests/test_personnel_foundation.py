"""Personnel phase, sub-phase Pa (decision P1): one `users` row per person, login profile optional.
Covers the DB constraints, the sign-in guards (a person without a profile holds no role/capability and can never
authenticate), the users views (outer join, mobile visibility), the profile guards and the new normalisers."""
import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

import app.models as m
from app.core.errors import DomainError
from app.core.normalize import canonical_mobile, canonical_personnel_code, compose_full_name
from app.core.permissions import Capability as C, Principal, scope_for, Scope
from app.services import auth_service, user_admin
from app.services.report_creation import participant_filter
from app.services.runtime_settings import get_report_entry_policy
from tests import factories as f


async def _commit_fails(db, obj):
    db.add(obj)
    with pytest.raises(IntegrityError):
        await db.flush()
    await db.rollback()


# ---------------------------------------------------------------- database constraints

async def test_login_columns_are_all_or_none(db):
    role = await f.role(db, "USER")
    await db.commit()
    rid = role.id
    await _commit_fails(db, m.User(username="a1x", full_name="A"))                       # username only
    await _commit_fails(db, m.User(hashed_password="h", full_name="A"))                  # password only
    await _commit_fails(db, m.User(role_id=rid, full_name="A", login_enabled=False))     # role only
    await _commit_fails(db, m.User(username="a1x", hashed_password="h", full_name="A"))  # no role
    await _commit_fails(db, m.User(full_name="A"))                                       # login_enabled defaults true


async def test_login_less_people_are_storable_and_many(db):
    await f.person(db, "Ali", "Rezaei")
    await f.person(db, "Sara", "Karimi")  # NULL usernames never collide
    await db.commit()
    assert len((await db.execute(select(m.User).where(m.User.username.is_(None)))).scalars().all()) == 2


async def test_personnel_code_range_and_uniqueness(db):
    for bad in (0, 10000, -5):
        await _commit_fails(db, m.User(full_name="A", login_enabled=False, personnel_code=bad))
    await f.person(db, "A", "One", code=1)
    await f.person(db, "B", "Two", code=9999)
    await f.person(db, "C", "Three")          # NULL codes may repeat
    await f.person(db, "D", "Four")
    await db.commit()
    await _commit_fails(db, m.User(full_name="E", login_enabled=False, personnel_code=1))


async def test_mobile_format_and_uniqueness(db):
    for bad in ("0912345678", "09123456789x", "08123456789", "912345678901", "09abcdefghi", "09123abc789",
                "09 23456789", "+989123456789", "091234567890", "09١٢٣٤٥٦٧٨٩"):
        await _commit_fails(db, m.User(full_name="A", login_enabled=False, mobile=bad))
    await f.person(db, "A", "One", mobile="09121234567")
    await f.person(db, "Z", "Zero", mobile="09000000000")
    await f.person(db, "B", "Two")            # NULL mobiles may repeat (old users)
    await f.person(db, "C", "Three")
    await db.commit()
    await _commit_fails(db, m.User(full_name="D", login_enabled=False, mobile="09121234567"))


async def test_existing_style_user_still_valid(db):
    u = await f.user(db, "ali", "USER")
    await db.commit()
    assert u.login_enabled is True and u.personnel_code is None and u.mobile is None


# ---------------------------------------------------------------- sign-in guards

async def test_person_without_profile_has_no_principal_and_cannot_sign_in(db):
    p = await f.person(db, "Ali", "Rezaei", code=12)
    await db.commit()
    assert await auth_service.load_principal(db, p.id) is None
    for typed in ("", "ali", "ali.rezaei", "12"):
        with pytest.raises(auth_service.InvalidCredentials):
            await auth_service.login(db, typed or "x", f.PASSWORD, None)


async def test_login_disabled_profile_cannot_sign_in_or_load_principal(db):
    u = await f.user(db, "ali", "USER")
    await db.commit()
    assert await auth_service.load_principal(db, u.id) is not None
    u.login_enabled = False
    await db.commit()
    assert await auth_service.load_principal(db, u.id) is None
    with pytest.raises(auth_service.InvalidCredentials):  # right password, still refused (same answer as wrong one)
        await auth_service.login(db, "ali", f.PASSWORD, None)


async def test_login_disabled_after_login_kills_the_access_token(api, db, world):
    assert (await api.call("GET", "/auth/me", who="ali")).status_code == 200
    ali = (await db.execute(select(m.User).where(m.User.username == "ali"))).scalar_one()
    ali.login_enabled = False
    await db.commit()
    assert (await api.call("GET", "/auth/me", who="ali")).status_code == 401


async def test_change_password_refused_when_login_disabled(db):
    u = await f.user(db, "ali", "USER")
    await db.commit()
    principal = await auth_service.load_principal(db, u.id)
    u.login_enabled = False
    await db.commit()
    uid, old_hash = u.id, u.hashed_password
    with pytest.raises(auth_service.InvalidCredentials):
        await auth_service.change_password(db, principal, f.PASSWORD, "another-long-password-1", None)
    # refused BEFORE anything changed: the old hash is intact and no session was issued
    row = (await db.execute(select(m.User).where(m.User.id == uid))).scalar_one()
    await db.refresh(row)
    assert row.hashed_password == old_hash
    assert (await db.execute(select(m.RefreshToken).where(m.RefreshToken.user_id == uid))).first() is None


# ---------------------------------------------------------------- people stay usable as participants

async def test_login_less_person_is_an_eligible_participant_only_when_active_and_in_scope(db):
    elv, door = await f.group(db, "ELV"), await f.group(db, "DOOR")
    boss = await f.user(db, "boss", "MANAGEMENT")
    ali = await f.user(db, "ali", "USER", [elv])
    member = await f.person(db, "M", "Member", groups=[elv])
    outsider = await f.person(db, "O", "Out", groups=[door])
    nogroup = await f.person(db, "N", "Nogroup")
    gone = await f.person(db, "G", "Gone", groups=[elv], active=False)
    await db.commit()
    policy = await get_report_entry_policy(db)

    async def ids(user, gid):
        p = await auth_service.load_principal(db, user.id)
        return set((await db.execute(select(m.User.id).where(participant_filter(p, policy, gid)))).scalars())

    assert member.id in await ids(ali, elv.id)                       # USER: report-group members
    assert not {outsider.id, nogroup.id, gone.id} & await ids(ali, elv.id)
    mgmt = await ids(boss, elv.id)                                    # MANAGEMENT: any ACTIVE person
    assert {member.id, outsider.id, nogroup.id} <= mgmt and gone.id not in mgmt


# ---------------------------------------------------------------- users views / admin guards

async def test_users_list_includes_login_less_people_and_hides_mobile_without_capability(db):
    elv = await f.group(db, "ELV")
    await f.user(db, "ali", "USER", [elv])
    p = await f.person(db, "Sara", "Karimi", code=7, mobile="09121234567", groups=[elv])
    await db.commit()
    items, total = await user_admin.list_users(db, q=None, role_code=None, is_active=None, group_id=None,
                                               limit=50, offset=0)
    assert total == 2
    row = next(i for i in items if i["id"] == p.id)
    assert (row["username"], row["role_code"], row["has_login"], row["login_enabled"]) == (None, None, False, False)
    assert row["personnel_code"] == 7 and row["group_ids"] == [elv.id]
    assert all(i["mobile"] is None for i in items)
    items, _ = await user_admin.list_users(db, q=None, role_code=None, is_active=None, group_id=None,
                                           limit=50, offset=0, include_mobile=True)
    assert next(i for i in items if i["id"] == p.id)["mobile"] == "09121234567"
    assert (await user_admin.get_user_view(db, p.id))["mobile"] is None
    assert (await user_admin.get_user_view(db, p.id, include_mobile=True))["mobile"] == "09121234567"
    # a role filter must not match people without a role
    items, total = await user_admin.list_users(db, q=None, role_code="USER", is_active=None, group_id=None,
                                               limit=50, offset=0)
    assert total == 1 and items[0]["username"] == "ali"


async def test_users_api_shows_mobile_to_management_and_auditor_only(api, db, world):
    p = await f.person(db, "Sara", "Karimi", mobile="09121234567")
    await db.commit()
    for who in ("boss", "aud"):
        r = await api.call("GET", f"/users/{p.id}", who=who)
        assert r.status_code == 200 and r.json()["mobile"] == "09121234567" and r.json()["username"] is None
    for who in ("ali", "exp"):
        assert (await api.call("GET", f"/users/{p.id}", who=who)).status_code == 403
        assert (await api.call("GET", "/users", who=who)).status_code == 403


def test_mobile_view_capability_is_management_and_auditor_only():
    for role, expected in (("USER", Scope.NONE), ("EXPERT", Scope.NONE), ("AUDITOR", Scope.ALL),
                           ("MANAGEMENT", Scope.ALL), ("", Scope.NONE)):
        assert scope_for(role, C.PERSONNEL_MOBILE_VIEW) is expected


async def test_profile_operations_are_refused_for_a_person_without_profile(db):
    boss = await f.user(db, "boss", "MANAGEMENT")
    p = await f.person(db, "Sara", "Karimi")
    await db.commit()
    actor = await auth_service.load_principal(db, boss.id)
    pid = p.id
    for coro in (
        user_admin.update_user(db, actor=actor, user_id=pid, role_code="USER"),
        user_admin.reset_password_for(db, actor=actor, user_id=pid, password="a-very-long-password-1"),
        user_admin.force_password_change_user(db, actor=actor, user_id=pid),
    ):
        with pytest.raises(DomainError) as e:
            await coro
        assert e.value.code == "user_has_no_profile"
    await db.rollback()
    row = (await db.execute(select(m.User).where(m.User.id == pid))).scalar_one()
    assert (row.username, row.hashed_password, row.role_id) == (None, None, None)


async def test_force_change_all_counts_only_profile_holders(db):
    await f.user(db, "ali", "USER")
    await f.person(db, "Sara", "Karimi")
    await db.commit()
    assert await user_admin.force_password_change_all(db, actor_id=None) == 1


async def test_a_manager_who_cannot_sign_in_does_not_count_as_remaining(db):
    boss, boss2 = await f.user(db, "boss", "MANAGEMENT"), await f.user(db, "boss2", "MANAGEMENT")
    await db.commit()
    boss.is_active = False
    boss2.login_enabled = False
    with pytest.raises(DomainError) as e:
        await user_admin._assert_management_remains(db)
    assert e.value.code == "last_management"


async def _boss_actor(db):
    boss = await f.user(db, "boss", "MANAGEMENT")
    await db.commit()
    return await auth_service.load_principal(db, boss.id)


async def test_name_parts_are_authoritative_and_full_name_is_composed(db):
    actor = await _boss_actor(db)
    p = await f.person(db, "Sara", "Karimi")
    await db.commit()
    view = await user_admin.update_user(db, actor=actor, user_id=p.id, first_name=" Sara ", last_name="Karimi Zadeh")
    assert (view["first_name"], view["last_name"], view["full_name"]) == ("Sara", "Karimi Zadeh", "Sara Karimi Zadeh")
    assert view["username"] is None
    log = (await db.execute(select(m.AuditLog).where(m.AuditLog.action == "user.update"))).scalars().one()
    assert log.metadata_json["changes"]["last_name"] == ["Karimi", "Karimi Zadeh"]


async def test_full_name_alone_cannot_contradict_stored_parts(db):
    actor = await _boss_actor(db)
    p = await f.person(db, "Sara", "Karimi")
    await db.commit()
    pid = p.id
    with pytest.raises(DomainError) as e:
        await user_admin.update_user(db, actor=actor, user_id=pid, full_name="Sara K")
    assert e.value.code == "name_parts_required"
    await db.rollback()
    row = (await db.execute(select(m.User).where(m.User.id == pid))).scalar_one()
    assert (row.first_name, row.last_name, row.full_name) == ("Sara", "Karimi", "Sara Karimi")


async def test_name_edit_input_rules(db):
    actor = await _boss_actor(db)
    p = await f.person(db, "Sara", "Karimi")
    await db.commit()
    pid = p.id
    cases = [dict(first_name="Only"), dict(last_name="Only"),
             dict(first_name="A", last_name="B", full_name="Someone Else"), dict(first_name=" ", last_name="B"),
             dict(first_name="A" * 65, last_name="B"), dict(first_name="A" * 64, last_name="B" * 64)]
    expected = ["both_name_parts_required", "both_name_parts_required", "full_name_conflicts_with_parts",
                "invalid_first_name", "invalid_first_name", "invalid_full_name"]
    for kw, code in zip(cases, expected):
        with pytest.raises(DomainError) as e:
            await user_admin.update_user(db, actor=actor, user_id=pid, **kw)
        assert e.value.code == code, kw
        await db.rollback()
    ok = await user_admin.update_user(db, actor=actor, user_id=pid, first_name="A", last_name="B", full_name="A B")
    assert ok["full_name"] == "A B"


async def test_old_user_without_parts_is_still_edited_by_full_name(db):
    actor = await _boss_actor(db)
    old = await f.user(db, "ali", "USER")
    await db.commit()
    view = await user_admin.update_user(db, actor=actor, user_id=old.id, full_name="Ali Rezaei")
    assert (view["full_name"], view["first_name"], view["last_name"]) == ("Ali Rezaei", None, None)


# ---------------------------------------------------------------- normalisers

@pytest.mark.parametrize("raw,expected", [("1", 1), (" 9999 ", 9999), ("۱۲۳", 123), ("٤٢", 42), (7, 7)])
def test_personnel_code_accepts(raw, expected):
    assert canonical_personnel_code(raw) == expected


@pytest.mark.parametrize("raw", ["", "0", "01", "10000", "12a", "-3", "1.5", "1 2", "   "])
def test_personnel_code_rejects(raw):
    with pytest.raises(DomainError) as e:
        canonical_personnel_code(raw)
    assert e.value.code == "invalid_personnel_code"


@pytest.mark.parametrize("raw", ["09121234567", "9121234567", "+98 912 123 4567", "0098-912-123-4567",
                                 "989121234567", "۰۹۱۲۱۲۳۴۵۶۷", "(0912) 123 4567"])
def test_mobile_accepts_every_common_form(raw):
    assert canonical_mobile(raw) == "09121234567"


@pytest.mark.parametrize("raw", ["", "0912123456", "091212345678", "08121234567", "02112345678", "abc", "+989"])
def test_mobile_rejects(raw):
    with pytest.raises(DomainError) as e:
        canonical_mobile(raw)
    assert e.value.code == "invalid_mobile"


def test_compose_full_name():
    assert compose_full_name("  Sara ", "Karimi  Zadeh") == "Sara Karimi Zadeh"
    for a, b in (("", "x"), ("x", " "), ("x" * 65, "y"), ("x" * 64, "y" * 64)):  # last: 129 > String(128)
        with pytest.raises(DomainError):
            compose_full_name(a, b)
    assert len(compose_full_name("x" * 63, "y" * 64)) == 128
