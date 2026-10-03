"""Pins the ENTIRE role/capability matrix. If you change app/core/permissions.py on purpose,
update the expected table here in the same PR — that is the review checkpoint."""
from app.core.permissions import ROLE_CAPABILITIES, Capability as C, Principal, Scope as S, scope_for

EXPECTED = {
    "USER": {
        C.EQUIPMENT_VIEW: S.GROUPS, C.GROUPS_VIEW: S.GROUPS, C.REPORT_CREATE: S.GROUPS,
        C.REPORT_VIEW: S.GROUPS, C.REPORT_EDIT: S.OWN, C.REPORT_ANALYTICS: S.OWN,
        C.LABOR_VIEW: S.OWN, C.REPORT_EXPORT: S.OWN,
    },
    "EXPERT": {
        C.EQUIPMENT_VIEW: S.GROUPS, C.GROUPS_VIEW: S.GROUPS, C.REPORT_CREATE: S.GROUPS,
        C.REPORT_VIEW: S.GROUPS, C.REPORT_EDIT: S.GROUPS, C.REPORT_ANALYTICS: S.GROUPS,
        C.LABOR_VIEW: S.GROUPS, C.REPORT_EXPORT: S.GROUPS,
    },
    "AUDITOR": {
        C.EQUIPMENT_VIEW: S.ALL, C.GROUPS_VIEW: S.ALL, C.REPORT_VIEW: S.ALL,
        C.REPORT_ANALYTICS: S.ALL, C.LABOR_VIEW: S.ALL, C.REPORT_EXPORT: S.ALL,
        C.USERS_VIEW: S.ALL, C.AUDIT_VIEW: S.ALL,
    },
    "MANAGEMENT": {cap: S.ALL for cap in C},
}

WRITE_CAPS = {
    C.REPORT_CREATE, C.REPORT_EDIT, C.USERS_MANAGE, C.GROUPS_MANAGE, C.EQUIPMENT_MANAGE,
    C.EXCEL_IMPORT, C.REPORT_TYPES_MANAGE, C.SETTINGS_MANAGE, C.REPORT_DELETE, C.REPORT_LOCK,
}


def test_full_matrix_is_pinned():
    assert ROLE_CAPABILITIES == EXPECTED


def test_every_capability_has_a_decision_for_every_role():
    for role in EXPECTED:
        for cap in C:
            assert isinstance(scope_for(role, cap), S)


def test_auditor_has_no_write_capability():
    for cap in WRITE_CAPS:
        assert scope_for("AUDITOR", cap) is S.NONE


def test_auditor_read_scope_equals_management_read_scope():
    for cap in set(C) - WRITE_CAPS - {C.SETTINGS_MANAGE}:
        if scope_for("AUDITOR", cap) is not S.NONE:
            assert scope_for("AUDITOR", cap) is scope_for("MANAGEMENT", cap)


def test_unknown_role_fails_closed():
    for cap in C:
        assert scope_for("SOMETHING_NEW", cap) is S.NONE


def test_user_and_expert_cannot_administer():
    admin = {C.USERS_VIEW, C.USERS_MANAGE, C.GROUPS_MANAGE, C.EQUIPMENT_MANAGE, C.EXCEL_IMPORT,
             C.REPORT_TYPES_MANAGE, C.SETTINGS_MANAGE, C.AUDIT_VIEW, C.REPORT_DELETE, C.REPORT_LOCK}
    for role in ("USER", "EXPERT"):
        for cap in admin:
            assert scope_for(role, cap) is S.NONE


def _p(role, groups=()):
    return Principal(1, "u", "U", role, "x", frozenset(groups), False)


def test_group_allowed():
    assert _p("EXPERT", {1, 2}).group_allowed(C.REPORT_VIEW, 2)
    assert not _p("EXPERT", {1, 2}).group_allowed(C.REPORT_VIEW, 3)
    assert _p("MANAGEMENT").group_allowed(C.REPORT_VIEW, 99)
    assert not _p("USER", {1}).group_allowed(C.REPORT_ANALYTICS, 1)  # OWN scope is not group-based
    assert not _p("AUDITOR").group_allowed(C.REPORT_CREATE, 1)
