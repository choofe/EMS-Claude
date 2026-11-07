"""Phase 7a on real PostgreSQL: timezone-aware cursor keyset paging and group scope of the reports list."""
from datetime import datetime, timedelta, timezone

import app.models as m
from app.core.permissions import Principal
from app.services import report_views
from tests.postgres import helpers as h

T0 = datetime(2026, 1, 1, tzinfo=timezone.utc)


def principal_of(u: m.User, role: str, group_ids=()) -> Principal:
    return Principal(user_id=u.id, username=u.username, full_name=u.full_name, role_code=role, role_label_fa=role,
                     group_ids=frozenset(group_ids), must_change_password=False)


async def test_cursor_paging_and_scope_on_postgres(db):
    elv, door = await h.make_group(db, "ELV"), await h.make_group(db, "DOOR", "Door")
    e1, d1 = await h.make_equipment(db, elv, "ELV-1"), await h.make_equipment(db, door, "DOOR-1")
    rt = await h.get_report_type(db)
    ali = await h.make_user(db, "ali", "USER")
    db.add(m.UserGroup(user_id=ali.id, group_id=elv.id))
    for i in range(7):  # equal event times in threes: the tie-break by id must keep pages exact
        for g, e, tag in ((elv, e1, "E"), (door, d1, "D")):
            db.add(m.Report(report_number=f"05-{tag}-{i:03d}", equipment_id=e.id, group_id=g.id, report_type_id=rt.id,
                            event_datetime=T0 + timedelta(days=i // 3), report_jalali_year=1404, created_by=ali.id,
                            description="x"))
    await db.commit()
    p = principal_of(ali, "USER", [elv.id])
    seen, cursor = [], None
    while True:
        page = await report_views.list_reports(db, p, limit=3, cursor=cursor)
        seen += [i["report_number"] for i in page["items"]]
        cursor = page["next_cursor"]
        if not cursor:
            break
    assert len(seen) == 7 and len(set(seen)) == 7 and all("-E-" in n for n in seen)  # only his group, no gaps/repeats
    boss = principal_of(ali, "MANAGEMENT")
    assert len((await report_views.list_reports(db, boss, limit=100))["items"]) == 14
