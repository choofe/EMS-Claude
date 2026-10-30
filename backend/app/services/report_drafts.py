"""Report drafts (Phase 6). Strictly private: every query is filtered by the caller's own user_id, and another
user's draft answers 404 exactly like a missing one (no IDOR, no existence leak)."""
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import DomainError
from app.core.permissions import Principal
from app.models.report_draft import ReportDraft
from app.models.user import User
from app.schemas.reports import DraftPayload

MAX_DRAFTS_PER_USER = 1  # decided 2026-10-22: one draft at a time (lifting it later needs no migration)


def view(d: ReportDraft) -> dict:
    return {"id": d.id, "payload": d.payload, "version": d.version, "created_at": d.created_at, "updated_at": d.updated_at}


def _dump(payload: DraftPayload) -> dict:
    return payload.model_dump(mode="json")


async def list_drafts(db: AsyncSession, principal: Principal) -> list[dict]:
    rows = (await db.execute(select(ReportDraft).where(ReportDraft.user_id == principal.user_id)
                             .order_by(ReportDraft.updated_at.desc(), ReportDraft.id.desc()))).scalars()
    return [view(d) for d in rows]


async def _own(db: AsyncSession, principal: Principal, draft_id: int, *, lock: bool) -> ReportDraft:
    stmt = select(ReportDraft).where(ReportDraft.id == draft_id, ReportDraft.user_id == principal.user_id)
    if lock:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    draft = (await db.execute(stmt)).scalar_one_or_none()
    if draft is None:
        raise DomainError("draft_not_found", 404)
    return draft


async def get_draft(db: AsyncSession, principal: Principal, draft_id: int) -> dict:
    return view(await _own(db, principal, draft_id, lock=False))


async def create_draft(db: AsyncSession, principal: Principal, payload: DraftPayload) -> dict:
    # Serialise this user's creates: two simultaneous requests must not both pass the limit check.
    # FOR NO KEY UPDATE conflicts with itself but not with the FK checks other inserts do on the user row.
    await db.execute(select(User.id).where(User.id == principal.user_id).with_for_update(key_share=True))
    limit = MAX_DRAFTS_PER_USER
    count = (await db.execute(select(func.count()).select_from(ReportDraft)
                              .where(ReportDraft.user_id == principal.user_id))).scalar_one()
    if count >= limit:
        await db.rollback()
        raise DomainError("draft_limit_reached", 409, limit=limit)
    draft = ReportDraft(user_id=principal.user_id, payload=_dump(payload), version=1)
    db.add(draft)
    await db.commit()
    await db.refresh(draft)
    return view(draft)


async def update_draft(db: AsyncSession, principal: Principal, draft_id: int, payload: DraftPayload, version: int) -> dict:
    draft = await _own(db, principal, draft_id, lock=True)
    if draft.version != version:
        current = draft.version
        await db.rollback()
        raise DomainError("draft_version_conflict", 409, current_version=current)
    draft.payload = _dump(payload)
    draft.version = version + 1
    draft.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(draft)
    return view(draft)


async def delete_draft(db: AsyncSession, principal: Principal, draft_id: int) -> None:
    draft = await _own(db, principal, draft_id, lock=True)
    await db.delete(draft)
    await db.commit()
