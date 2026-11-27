"""Personnel phase, sub-phase Pf (backend part): the users list orders people who need a group first on every
page, `needs_group` equals the banner's count, the `has_login` filter, search by personnel code, and the AUDITOR
mobile block. Role CODES are untouched by the label change."""
from app.services import personnel_admin, user_admin
from tests import factories as f


async def _list(db, **kw):
    args = dict(q=None, role_code=None, is_active=None, group_id=None, limit=100, offset=0)
    args.update(kw)
    return await user_admin.list_users(db, **args)


async def _scene(db):
    elv = await f.group(db, "ELV")
    nog = await f.person(db, "Zahra", "Nazari", code=11)               # needs a group
    with_g = await f.person(db, "Ali", "Rezaei", code=12, groups=[elv])
    off = await f.person(db, "Off", "Inactive", code=13, active=False)  # inactive: does not need a group
    tech = await f.user(db, "tech", "USER")                              # account, no group: needs a group
    boss = await f.user(db, "boss", "MANAGEMENT")                        # organisation-wide: never
    aud = await f.user(db, "aud", "AUDITOR")
    await db.commit()
    return dict(nog=nog, with_g=with_g, off=off, tech=tech, boss=boss, aud=aud)


async def test_needs_group_flag_matches_the_banner_count(db):
    s = await _scene(db)
    items, _ = await _list(db)
    flagged = {i["id"] for i in items if i["needs_group"]}
    assert flagged == {s["nog"].id, s["tech"].id}
    assert len(flagged) == await personnel_admin._no_group_count(db)


async def test_people_who_need_a_group_come_first(db):
    s = await _scene(db)
    items, _ = await _list(db)
    assert [i["needs_group"] for i in items] == [True, True, False, False, False, False]
    assert {i["id"] for i in items[:2]} == {s["nog"].id, s["tech"].id}


async def test_order_holds_across_pages(db):
    s = await _scene(db)
    first, total = await _list(db, limit=2, offset=0)
    rest, _ = await _list(db, limit=4, offset=2)
    assert total == 6 and {i["id"] for i in first} == {s["nog"].id, s["tech"].id}
    assert not any(i["needs_group"] for i in rest)


async def test_has_login_filter(db):
    s = await _scene(db)
    items, total = await _list(db, has_login=True)
    assert {i["id"] for i in items} == {s["tech"].id, s["boss"].id, s["aud"].id} and total == 3
    items, total = await _list(db, has_login=False)
    assert {i["id"] for i in items} == {s["nog"].id, s["with_g"].id, s["off"].id} and total == 3


async def test_search_by_personnel_code(db):
    s = await _scene(db)
    items, _ = await _list(db, q="12")
    assert [i["id"] for i in items] == [s["with_g"].id]
    items, _ = await _list(db, q="۱۲")  # Persian digits
    assert [i["id"] for i in items] == [s["with_g"].id]
    items, _ = await _list(db, q="1")    # exact only: no prefix match on codes
    assert items == []


async def test_list_endpoint_filter_and_flag_for_roles(api, db, world):
    r = await api.call("GET", "/users?has_login=false", who="boss")
    assert r.status_code == 200 and all(i["username"] is None for i in r.json()["items"])
    r = await api.call("GET", "/users", who="aud")  # AUDITOR reads, gets the flag, never a number
    assert r.status_code == 200 and all("needs_group" in i and i["mobile"] is None for i in r.json()["items"])
    for who in ("ali", "exp"):
        assert (await api.call("GET", "/users", who=who)).status_code == 403


async def test_alert_is_management_only(api, world):
    assert (await api.call("GET", "/users/no-group-alert", who="boss")).status_code == 200
    for who in ("aud", "ali", "exp"):
        assert (await api.call("GET", "/users/no-group-alert", who=who)).status_code == 403
