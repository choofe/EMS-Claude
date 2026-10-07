"""Groups (spec section 5). `code` is immutable (it is embedded in report numbers). A group that still has
ACTIVE equipment cannot be deactivated. Read access is scoped: ALL sees every group (incl. inactive on
request), GROUPS sees only its own ACTIVE groups; anything else is 404."""
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import DomainError
from app.core.normalize import canonical_group_code, clean_text
from app.core.permissions import Capability, Principal, Scope
from app.core.scoping import apply_group_scope
from app.models.equipment import Equipment
from app.models.group import Group
from app.models.user import User
from app.models.user_group import UserGroup
from app.services.audit import add_audit
from app.services.queries import lock_group

_UNSET = object()


def _counts():
    eq = (select(func.count()).select_from(Equipment)
          .where(Equipment.group_id == Group.id, Equipment.is_active.is_(True)).correlate(Group).scalar_subquery())
    members = (select(func.count()).select_from(UserGroup).join(User, User.id == UserGroup.user_id)
               .where(UserGroup.group_id == Group.id, User.is_active.is_(True)).correlate(Group).scalar_subquery())
    return eq.label("equipment_count"), members.label("member_count")


def _view(g: Group, equipment_count: int, member_count: int) -> dict:
    return {"id": g.id, "code": g.code, "name": g.name, "description": g.description, "is_active": g.is_active,
            "equipment_count": equipment_count, "member_count": member_count,
            "created_at": g.created_at, "updated_at": g.updated_at}


async def _view_by_id(db: AsyncSession, group_id: int) -> dict:
    eq, members = _counts()
    row = (await db.execute(select(Group, eq, members).where(Group.id == group_id))).first()
    if row is None:
        raise DomainError("group_not_found", 404)
    return _view(*row)


async def list_groups(db: AsyncSession, principal: Principal, *, include_inactive: bool, limit: int, offset: int):
    eq, members = _counts()
    stmt = apply_group_scope(select(Group, eq, members), principal)
    if not (include_inactive and principal.scope(Capability.GROUPS_VIEW) is Scope.ALL):
        stmt = stmt.where(Group.is_active.is_(True))
    total = (await db.execute(select(func.count()).select_from(stmt.with_only_columns(Group.id).subquery()))).scalar_one()
    rows = (await db.execute(stmt.order_by(Group.code).limit(limit).offset(offset))).all()
    return [_view(*r) for r in rows], total


async def get_group(db: AsyncSession, principal: Principal, group_id: int) -> dict:
    eq, members = _counts()
    stmt = apply_group_scope(select(Group, eq, members).where(Group.id == group_id), principal)
    if principal.scope(Capability.GROUPS_VIEW) is not Scope.ALL:
        stmt = stmt.where(Group.is_active.is_(True))
    row = (await db.execute(stmt)).first()
    if row is None:
        raise DomainError("group_not_found", 404)  # same answer for "missing" and "not yours"
    return _view(*row)


def _description(raw: str | None) -> str | None:
    if raw is None or not raw.strip():
        return None
    return clean_text(raw, max_length=2000, code="invalid_description")


async def create_group(db: AsyncSession, *, actor_id: int, code: str, name: str, description: str | None) -> dict:
    code = canonical_group_code(code)
    name = clean_text(name, max_length=128, code="invalid_name")
    if (await db.execute(select(Group.id).where(Group.code == code))).first():
        raise DomainError("group_code_taken", 409)
    group = Group(code=code, name=name, description=_description(description))
    db.add(group)
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        raise DomainError("group_code_taken", 409)
    add_audit(db, actor_id=actor_id, action="group.create", entity_type="group", entity_id=group.id,
              metadata={"code": code, "name": name})
    await db.commit()
    return await _view_by_id(db, group.id)


async def update_group(db: AsyncSession, *, actor_id: int, group_id: int, name=_UNSET, description=_UNSET) -> dict:
    group = await lock_group(db, group_id, exclusive=True)
    changes: dict[str, list] = {}
    if name is not _UNSET:
        new = clean_text(name, max_length=128, code="invalid_name")
        if new != group.name:
            changes["name"] = [group.name, new]
            group.name = new
    if description is not _UNSET:
        new_d = _description(description)
        if new_d != group.description:
            changes["description"] = [group.description, new_d]
            group.description = new_d
    if changes:
        add_audit(db, actor_id=actor_id, action="group.update", entity_type="group", entity_id=group.id,
                  metadata={"changes": changes})
    await db.commit()
    return await _view_by_id(db, group_id)


async def set_group_active(db: AsyncSession, *, actor_id: int, group_id: int, active: bool) -> dict:
    group = await lock_group(db, group_id, exclusive=True)
    if group.is_active != active:
        if not active:
            n = (await db.execute(select(func.count()).select_from(Equipment)
                                  .where(Equipment.group_id == group.id, Equipment.is_active.is_(True)))).scalar_one()
            if n:
                await db.rollback()
                raise DomainError("group_has_active_equipment", 409, count=n)
        group.is_active = active
        add_audit(db, actor_id=actor_id, action="group.activate" if active else "group.deactivate",
                  entity_type="group", entity_id=group.id)
    await db.commit()
    return await _view_by_id(db, group_id)
