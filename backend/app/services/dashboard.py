"""Dashboard numbers that exist before reports do (users, equipment, groups). Report-based figures (reports in a
period, failures, labor hours, reports by group) arrive with Phase 8 once reports exist."""
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.equipment import Equipment
from app.models.group import Group
from app.models.role import Role
from app.models.user import User
from app.models.user_group import UserGroup


async def _count(db: AsyncSession, model, active: bool) -> int:
    return (await db.execute(select(func.count()).select_from(model).where(model.is_active.is_(active)))).scalar_one()


async def summary(db: AsyncSession) -> dict:
    eq = (select(func.count()).select_from(Equipment)
          .where(Equipment.group_id == Group.id, Equipment.is_active.is_(True)).correlate(Group).scalar_subquery())
    members = (select(func.count()).select_from(UserGroup).join(User, User.id == UserGroup.user_id)
               .where(UserGroup.group_id == Group.id, User.is_active.is_(True)).correlate(Group).scalar_subquery())
    rows = (await db.execute(select(Group.id, Group.code, Group.name, eq, members)
                             .where(Group.is_active.is_(True)).order_by(Group.code))).all()
    return {
        "active_users": await _count(db, User, True), "inactive_users": await _count(db, User, False),
        "active_equipment": await _count(db, Equipment, True), "inactive_equipment": await _count(db, Equipment, False),
        "active_groups": len(rows),
        "groups": [{"id": i, "code": c, "name": n, "active_equipment": e, "active_members": m} for i, c, n, e, m in rows],
    }


async def list_roles(db: AsyncSession) -> list[dict]:
    return [{"code": r.code, "label_fa": r.label_fa} for r in (await db.execute(select(Role).order_by(Role.id))).scalars()]
