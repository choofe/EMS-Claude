"""Column registry of the reports list (Phase 7a, decision 7a.1).

One place that says which columns exist, who may ask for them, whether they are shown by default and whether the
list can be sorted by them. A future per-user column choice only has to store a subset of `key`s. Hiding a column is
COSMETIC: the API never puts into a row what the viewer may not see (see report_views), whatever columns are chosen.
"""
from dataclasses import dataclass

from app.core.permissions import Capability as C, Principal


@dataclass(frozen=True)
class Column:
    key: str
    label_fa: str
    capability: C | None = None  # None = every caller who may view reports
    default_visible: bool = True
    sortable: bool = False


COLUMNS: tuple[Column, ...] = (
    Column("report_number", "شماره گزارش"),
    Column("event_datetime", "زمان رخداد", sortable=True),
    Column("report_type", "نوع گزارش"),
    Column("group", "گروه"),
    Column("equipment", "تجهیز"),
    Column("creator", "ثبت‌کننده"),
    Column("description", "شرح"),
    Column("created_at", "زمان ثبت", default_visible=False, sortable=True),
    Column("my_minutes", "زمان من"),
    Column("total_minutes", "جمع زمان کار", capability=C.LABOR_VIEW, default_visible=False),
    Column("people_count", "تعداد افراد", capability=C.LABOR_VIEW, default_visible=False),
)

SORTABLE = tuple(c.key for c in COLUMNS if c.sortable)


def columns_for(principal: Principal) -> list[Column]:
    return [c for c in COLUMNS if c.capability is None or principal.can(c.capability)]
