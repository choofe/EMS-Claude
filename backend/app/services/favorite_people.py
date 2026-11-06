"""Favorite people (Phase 6d). Strictly private: every query is filtered by the caller's own user id; nothing here
reads another user's shortlist. Starring checks eligibility NOW (`participant_filter_any_group`), un-starring never does
(a person who became ineligible can still be removed). A not-eligible / missing / inactive target answers one and the
same 404, so the endpoint cannot be used to probe which user ids exist."""
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import DomainError
from app.core.permissions import Principal
from app.models.favorite_person import FavoritePerson, UserReportPreference
from app.models.user import User
from app.services.report_creation import participant_filter_any_group
from app.services.runtime_settings import get_favorite_people_max, get_report_entry_policy


async def add_favorite(db: AsyncSession, principal: Principal, user_id: int) -> None:
    """Idempotent. Raises: 422 favorite_self, 404 person_not_found, 409 favorites_limit_reached."""
    if user_id == principal.user_id:
        raise DomainError("favorite_self", 422)
    # Serialise this owner's stars so two simultaneous requests cannot both pass the limit check
    # (FOR NO KEY UPDATE conflicts with itself, not with the FK checks other inserts do on the user row).
    await db.execute(select(User.id).where(User.id == principal.user_id).with_for_update(key_share=True))
    eligible = participant_filter_any_group(principal, await get_report_entry_policy(db))
    if (await db.execute(select(User.id).where(User.id == user_id, eligible))).scalar_one_or_none() is None:
        await db.rollback()
        raise DomainError("person_not_found", 404)
    if await db.get(FavoritePerson, (principal.user_id, user_id)) is not None:
        await db.rollback()
        return
    limit = await get_favorite_people_max(db)
    # Only people the caller can still use count: a deactivated colleague must not silently fill the quota.
    count = await _usable(db, principal, eligible)
    if count >= limit:
        await db.rollback()
        raise DomainError("favorites_limit_reached", 409, limit=limit)
    db.add(FavoritePerson(owner_id=principal.user_id, favorite_user_id=user_id))
    try:
        await db.commit()
    except IntegrityError:  # only a duplicate of the same pair can get here (the lock above makes it a no-op)
        await db.rollback()


async def _usable(db: AsyncSession, principal: Principal, eligible, only: int | None = None) -> int:
    """How many of the caller's stars he can still use (active and eligible now); `only` restricts to one person."""
    stmt = (select(func.count()).select_from(FavoritePerson).join(User, User.id == FavoritePerson.favorite_user_id)
            .where(FavoritePerson.owner_id == principal.user_id, eligible))
    if only is not None:
        stmt = stmt.where(FavoritePerson.favorite_user_id == only)
    return (await db.execute(stmt)).scalar_one()


async def remove_favorite(db: AsyncSession, principal: Principal, user_id: int) -> dict:
    """Idempotent. Answers only about the caller's own list: `can_restore` is true exactly when starring this person again
    would be accepted right now (he is still usable and the list is below the quota), so the screen offers «بازگردانی» only
    when it can work. Anybody else's data is never involved."""
    await db.execute(select(User.id).where(User.id == principal.user_id).with_for_update(key_share=True))
    eligible = participant_filter_any_group(principal, await get_report_entry_policy(db))
    usable = await _usable(db, principal, eligible)
    was_usable = await _usable(db, principal, eligible, only=user_id) > 0
    await db.execute(delete(FavoritePerson).where(FavoritePerson.owner_id == principal.user_id,
                                                  FavoritePerson.favorite_user_id == user_id))
    await db.commit()
    limit = await get_favorite_people_max(db)
    return {"can_restore": was_usable and usable - 1 < limit}


async def set_favorites_only(db: AsyncSession, principal: Principal, value: bool) -> dict:
    insert = pg_insert if db.get_bind().dialect.name == "postgresql" else sqlite_insert
    stmt = insert(UserReportPreference).values(user_id=principal.user_id, favorites_only=value)
    await db.execute(stmt.on_conflict_do_update(index_elements=["user_id"], set_={"favorites_only": value,
                                                                                  "updated_at": func.now()}))
    await db.commit()
    return {"favorites_only": value}
