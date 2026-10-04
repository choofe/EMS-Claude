"""
Role -> capability -> scope matrix (spec sections 8-12, Phase 0 decisions
#4, #5, #9). This is CODE, not database data, on purpose: it ships with the
release, changes only through git review, and cannot be altered at runtime by
SQL injection or a compromised admin account. tests/test_permissions.py pins
the whole matrix so any accidental edit fails CI.

Scope says WHICH rows a capability applies to:
  OWN     rows the user created (reports.created_by = me)
  GROUPS  rows in the user's groups — for reports this is reports.group_id
          (the creation-time snapshot), NEVER equipment.group_id (2026-09-27)
  ALL     organisation-wide
Boolean capabilities (e.g. manage users) use ALL to mean "granted".
Anything not listed for a role is NONE — and an unknown role code gets NONE
for everything (fail closed).

Edit-window / lock rules and per-object edit checks are Phase 7; this file
only states the scope each role has for editing.
"""
from dataclasses import dataclass
from enum import IntEnum, StrEnum


class Scope(IntEnum):
    NONE = 0
    OWN = 1
    GROUPS = 2
    ALL = 3


class Capability(StrEnum):
    # scoped
    EQUIPMENT_VIEW = "equipment.view"
    GROUPS_VIEW = "groups.view"
    REPORT_CREATE = "report.create"
    REPORT_VIEW = "report.view"
    REPORT_EDIT = "report.edit"
    REPORT_ANALYTICS = "report.analytics"
    LABOR_VIEW = "labor.view"            # report_participants rows
    REPORT_EXPORT = "report.export"
    # boolean (ALL = granted)
    USERS_VIEW = "users.view"
    USERS_MANAGE = "users.manage"
    GROUPS_MANAGE = "groups.manage"
    EQUIPMENT_MANAGE = "equipment.manage"
    EXCEL_IMPORT = "equipment.import"
    REPORT_TYPES_MANAGE = "report_types.manage"
    SETTINGS_MANAGE = "settings.manage"
    AUDIT_VIEW = "audit.view"
    REPORT_DELETE = "report.delete"      # soft delete
    REPORT_LOCK = "report.lock"          # lock / unlock


C = Capability
S = Scope

_USER = {
    C.EQUIPMENT_VIEW: S.GROUPS,
    C.GROUPS_VIEW: S.GROUPS,
    C.REPORT_CREATE: S.GROUPS,
    C.REPORT_VIEW: S.GROUPS,
    C.REPORT_EDIT: S.OWN,          # only within the edit window (Phase 7)
    C.REPORT_ANALYTICS: S.OWN,
    C.LABOR_VIEW: S.OWN,           # participant rows of reports THEY created only
    C.REPORT_EXPORT: S.OWN,        # follows spec s.24; matrix cell says "NO*" — see docs/auth.md
}

_EXPERT = {
    C.EQUIPMENT_VIEW: S.GROUPS,
    C.GROUPS_VIEW: S.GROUPS,
    C.REPORT_CREATE: S.GROUPS,
    C.REPORT_VIEW: S.GROUPS,
    C.REPORT_EDIT: S.GROUPS,
    C.REPORT_ANALYTICS: S.GROUPS,
    C.LABOR_VIEW: S.GROUPS,
    C.REPORT_EXPORT: S.GROUPS,
}

_AUDITOR = {  # read / report / export organisation-wide, nothing that writes
    C.EQUIPMENT_VIEW: S.ALL,
    C.GROUPS_VIEW: S.ALL,
    C.REPORT_VIEW: S.ALL,
    C.REPORT_ANALYTICS: S.ALL,
    C.LABOR_VIEW: S.ALL,
    C.REPORT_EXPORT: S.ALL,
    C.USERS_VIEW: S.ALL,
    C.AUDIT_VIEW: S.ALL,
}

_MANAGEMENT = {
    **{cap: S.ALL for cap in Capability},
}

ROLE_CAPABILITIES: dict[str, dict[Capability, Scope]] = {
    "USER": _USER,
    "EXPERT": _EXPERT,
    "MANAGEMENT": _MANAGEMENT,
    "AUDITOR": _AUDITOR,
}


def scope_for(role_code: str, capability: Capability) -> Scope:
    return ROLE_CAPABILITIES.get(role_code, {}).get(capability, Scope.NONE)


@dataclass(frozen=True)
class Principal:
    """The authenticated caller, rebuilt from the database on every request."""

    user_id: int
    username: str
    full_name: str
    role_code: str
    role_label_fa: str
    group_ids: frozenset[int]
    must_change_password: bool

    def scope(self, capability: Capability) -> Scope:
        return scope_for(self.role_code, capability)

    def can(self, capability: Capability) -> bool:
        return self.scope(capability) is not Scope.NONE

    def group_allowed(self, capability: Capability, group_id: int) -> bool:
        """Is `group_id` reachable under this capability's scope? (OWN never is: it is not group-based.)"""
        scope = self.scope(capability)
        if scope is Scope.ALL:
            return True
        if scope is Scope.GROUPS:
            return group_id in self.group_ids
        return False
