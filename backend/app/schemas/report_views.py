"""Read-side models of reports (Phase 7a). Labor fields are `None` whenever the viewer may not see them."""
from datetime import datetime

from pydantic import BaseModel


class GroupRef(BaseModel):
    id: int
    code: str
    name: str


class TypeRef(BaseModel):
    id: int
    code: str
    name_fa: str
    is_failure: bool


class EquipmentRef(BaseModel):
    id: int
    code: str


class PersonRef(BaseModel):
    id: int
    full_name: str


class ReportListItem(BaseModel):
    id: int
    report_number: str
    event_datetime: datetime
    created_at: datetime
    group: GroupRef
    report_type: TypeRef
    equipment: EquipmentRef | None  # None only for general reports
    is_general: bool
    creator: PersonRef
    description_summary: str
    is_locked: bool
    my_minutes: int | None  # the viewer's own labor row, if he participates
    total_minutes: int | None  # only where the viewer may see ALL labor rows of this report
    people_count: int | None


class ReportListOut(BaseModel):
    items: list[ReportListItem]
    next_cursor: str | None
    # Set only with an equipment filter and a viewer who is not organisation-wide: this equipment has reports of a
    # group he cannot see (it was moved). Deliberately a flag, never a number.
    other_group_reports_may_exist: bool = False


class ParticipantOut(BaseModel):
    user_id: int
    full_name: str
    minutes: int
    is_me: bool


class ReportDetail(ReportListItem):
    description: str
    locked_at: datetime | None
    participants: list[ParticipantOut]
    participants_complete: bool  # False: the viewer sees only his own row (or none)


class ColumnOut(BaseModel):
    key: str
    label_fa: str
    default_visible: bool
    sortable: bool
