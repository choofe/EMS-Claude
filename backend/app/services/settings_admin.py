"""Management view/update of the registered runtime settings. Every change is audited with old and new value."""
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import DomainError
from app.models.system_setting import SystemSetting
from app.services.audit import add_audit
from app.services.runtime_settings import REGISTRY, IntSettingSpec, resolve, validate


def _entry(spec: IntSettingSpec, row: SystemSetting | None) -> dict:
    return {
        "key": spec.key,
        "label_fa": spec.label_fa,
        "description": spec.description,
        "value": resolve(spec, row.value if row else None),
        "default": spec.default,
        "minimum": spec.minimum,
        "maximum": spec.maximum,
        "special_values": list(spec.special),
        "is_default": row is None,
        "updated_at": row.updated_at if row else None,
        "updated_by": row.updated_by if row else None,
    }


async def list_settings(db: AsyncSession) -> list[dict]:
    rows = {r.key: r for r in (await db.execute(select(SystemSetting).where(SystemSetting.key.in_(list(REGISTRY))))).scalars()}
    return [_entry(spec, rows.get(spec.key)) for spec in REGISTRY.values()]


async def update_setting(db: AsyncSession, *, actor_id: int, key: str, value: int) -> dict:
    spec = REGISTRY.get(key)
    if spec is None:
        raise DomainError("setting_not_found", 404)
    validate(spec, value)
    row = (await db.execute(select(SystemSetting).where(SystemSetting.key == key).with_for_update())).scalar_one_or_none()
    old = resolve(spec, row.value if row else None)
    if row is None:
        row = SystemSetting(key=key, value=str(value), description=spec.description, updated_by=actor_id)
        db.add(row)
    else:
        row.value = str(value)
        row.updated_by = actor_id
    add_audit(db, actor_id=actor_id, action="setting.update", entity_type="system_setting", entity_id=None,
              metadata={"key": key, "old": old, "new": value})
    await db.commit()
    await db.refresh(row)
    return _entry(spec, row)
