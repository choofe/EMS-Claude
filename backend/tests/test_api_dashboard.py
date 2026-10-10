async def test_dashboard_counts_and_group_breakdown(api, world):
    await api.post(f"/users/{world.omid.id}/deactivate", "boss")
    await api.post(f"/equipment/{world.d1.id}/deactivate", "boss")
    r = await api.get("/dashboard/summary", "boss")
    assert r.status_code == 200
    d = r.json()
    assert (d["active_users"], d["inactive_users"], d["active_equipment"], d["inactive_equipment"], d["active_groups"]) == (5, 1, 1, 1, 2)
    by = {g["code"]: g for g in d["groups"]}
    assert by["ELV"]["active_equipment"] == 1 and by["ELV"]["active_members"] == 2
    assert by["DOOR"]["active_equipment"] == 0 and by["DOOR"]["active_members"] == 0  # omid is inactive
    assert (await api.get("/dashboard/summary", "aud")).status_code == 200


async def test_dashboard_and_roles_need_users_view(api, world):
    for who in ("ali", "exp"):
        assert (await api.get("/dashboard/summary", who)).status_code == 403
        assert (await api.get("/roles", who)).status_code == 403


async def test_roles_lookup_returns_db_labels(api, world):
    r = await api.get("/roles", "boss")
    assert r.status_code == 200
    assert {x["code"]: x["label_fa"] for x in r.json()} == {
        "USER": "کاربر", "EXPERT": "کارشناس", "MANAGEMENT": "مدیریت", "AUDITOR": "بازرس ارشد"}
