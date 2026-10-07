"""Small shared query helpers for the admin services."""
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import DomainError
from sqlalchemy import select

from app.models.group import Group


def contains_pattern(q: str) -> str:
    """LIKE pattern for a literal 'contains' search (escape % _ \\ so users cannot inject wildcards)."""
    escaped = q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


LIKE_ESCAPE = "\\"


async def lock_group(db: AsyncSession, group_id: int, *, exclusive: bool) -> Group:
    """Row-lock a group. Creating/moving/activating equipment takes a SHARED lock and verifies the group
    is active; deactivating a group takes the EXCLUSIVE lock — so a group can never be deactivated while
    equipment is concurrently being placed in it. (SQLite ignores row locks; PostgreSQL honours them.)"""
    stmt = select(Group).where(Group.id == group_id).with_for_update(read=not exclusive)
    group = (await db.execute(stmt)).scalar_one_or_none()
    if group is None:
        raise DomainError("group_not_found", 404, group_id=group_id)
    return group
