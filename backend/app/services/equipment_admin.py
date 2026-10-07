"""Equipment (spec section 6). equipment_code is immutable and canonical (UPPER-case, case-insensitively
unique). Moving equipment to another group is a Management action that is audited with old/new group — that
audit row IS the "moved on this date" record; reports keep their own frozen reports.group_id."""
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import DomainError
from app.core.normalize import canonical_equipment_code, clean_text
from app.core.permissions import Capability, Principal, Scope
from app.core.scoping import apply_equipment_scope
from app.models.equipment import Equipment
from app.models.group import Group
from app.services.audit import add_audit
from app.services.queries import LIKE_ESCAPE, contains_pattern, lock_group

_UNSET = object()


def _view(e: Equipment, g: Group) -> dict:
    return {"id": e.id, "equipment_code": e.equipment_code, "group_id": e.group_id, "group_code": g.code,
            "group_name": g.name, "description": e.description, "is_active": e.is_active,
            "created_at": e.created_at, "updated_at": e.updated_at}


async def _view_by_id(db: AsyncSession, equipment_id: int) -> dict:
    row = (await db.execute(select(Equipment, Group).join(Group, Group.id == Equipment.group_id)
                            .where(Equipment.id == equipment_id))).first()
    if row is None:
        raise DomainError("equipment_not_found", 404)
    return _view(*row)


def _scoped(principal: Principal, stmt):
    """Scope + visibility: roles below ALL only ever see ACTIVE equipment of their own groups."""
    stmt = apply_equipment_scope(stmt, principal)
    if principal.scope(Capability.EQUIPMENT_VIEW) is not Scope.ALL:
        stmt = stmt.where(Equipment.is_active.is_(True))
    return stmt


async def list_equipment(
    db: AsyncSession, principal: Principal, *, q: str | None, group_id: int | None, is_active: bool | None,
    limit: int, offset: int,
) -> tuple[list[dict], int]:
    stmt = _scoped(principal, select(Equipment, Group).join(Group, Group.id == Equipment.group_id))
    if q and q.strip():
        stmt = stmt.where(Equipment.equipment_code.ilike(contains_pattern(q), escape=LIKE_ESCAPE))
    if group_id is not None:
        stmt = stmt.where(Equipment.group_id == group_id)
    if is_active is not None and principal.scope(Capability.EQUIPMENT_VIEW) is Scope.ALL:
        stmt = stmt.where(Equipment.is_active.is_(is_active))
    total = (await db.execute(select(func.count()).select_from(stmt.with_only_columns(Equipment.id).subquery()))).scalar_one()
    rows = (await db.execute(stmt.order_by(Equipment.equipment_code).limit(limit).offset(offset))).all()
    return [_view(e, g) for e, g in rows], total


async def get_equipment(db: AsyncSession, principal: Principal, equipment_id: int) -> dict:
    row = (await db.execute(_scoped(principal, select(Equipment, Group).join(Group, Group.id == Equipment.group_id))
                            .where(Equipment.id == equipment_id))).first()
    if row is None:
        raise DomainError("equipment_not_found", 404)  # identical for "missing" and "not yours"
    return _view(*row)


async def _active_group_shared(db: AsyncSession, group_id: int) -> Group:
    group = await lock_group(db, group_id, exclusive=False)
    if not group.is_active:
        raise DomainError("group_inactive", 409, group_id=group_id)
    return group


async def _equipment(db: AsyncSession, equipment_id: int) -> Equipment:
    e = (await db.execute(select(Equipment).where(Equipment.id == equipment_id).with_for_update()
                          .execution_options(populate_existing=True))).scalar_one_or_none()
    if e is None:
        raise DomainError("equipment_not_found", 404)
    return e


async def create_equipment(db: AsyncSession, *, actor_id: int, equipment_code: str, group_id: int,
                           description: str | None) -> dict:
    code = canonical_equipment_code(equipment_code)
    desc = clean_text(description, max_length=2000, code="invalid_description") if description and description.strip() else None
    await _active_group_shared(db, group_id)
    if (await db.execute(select(Equipment.id).where(Equipment.equipment_code == code))).first():
        raise DomainError("equipment_code_taken", 409)
    e = Equipment(equipment_code=code, group_id=group_id, description=desc)
    db.add(e)
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        raise DomainError("equipment_code_taken", 409)
    add_audit(db, actor_id=actor_id, action="equipment.create", entity_type="equipment", entity_id=e.id,
              metadata={"equipment_code": code, "group_id": group_id})
    await db.commit()
    return await _view_by_id(db, e.id)


async def update_equipment(db: AsyncSession, *, actor_id: int, equipment_id: int, description=_UNSET) -> dict:
    e = await _equipment(db, equipment_id)
    if description is not _UNSET:
        new = clean_text(description, max_length=2000, code="invalid_description") if description and description.strip() else None
        if new != e.description:
            add_audit(db, actor_id=actor_id, action="equipment.update", entity_type="equipment", entity_id=e.id,
                      metadata={"changes": {"description": [e.description, new]}})
            e.description = new
    await db.commit()
    return await _view_by_id(db, equipment_id)


async def move_equipment(db: AsyncSession, *, actor_id: int, equipment_id: int, group_id: int) -> dict:
    e = await _equipment(db, equipment_id)
    if e.group_id == group_id:
        raise DomainError("same_group", 409)
    await _active_group_shared(db, group_id)
    old = e.group_id
    e.group_id = group_id
    add_audit(db, actor_id=actor_id, action="equipment.move", entity_type="equipment", entity_id=e.id,
              metadata={"equipment_code": e.equipment_code, "from_group_id": old, "to_group_id": group_id})
    await db.commit()
    return await _view_by_id(db, equipment_id)


async def set_equipment_active(db: AsyncSession, *, actor_id: int, equipment_id: int, active: bool) -> dict:
    e = await _equipment(db, equipment_id)
    if e.is_active != active:
        if active:
            await _active_group_shared(db, e.group_id)  # cannot reactivate into a deactivated group
        e.is_active = active
        add_audit(db, actor_id=actor_id, action="equipment.activate" if active else "equipment.deactivate",
                  entity_type="equipment", entity_id=e.id, metadata={"equipment_code": e.equipment_code})
    await db.commit()
    return await _view_by_id(db, equipment_id)
