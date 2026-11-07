"""Report entry (Phase 6): create a report, its private drafts, and the helpers the entry form needs.
Every route needs REPORT_CREATE (USER/EXPERT within their groups, MANAGEMENT everywhere; AUDITOR has none).
Read side (Phase 7a): list/columns/detail need REPORT_VIEW; the `/{report_id}` route stays LAST (after the static paths)."""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query, Response
from pydantic import AwareDatetime
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_principal, require_capability
from app.core.permissions import Capability as C, Principal
from app.db.session import get_db
from app.schemas.report_views import ColumnOut, ReportDetail, ReportListOut
from app.schemas.reports import (
    CandidateOut, DraftCreate, DraftOut, DraftUpdate, EntryConfigOut, HeartbeatOut, QuickPickOut, ReportCreate, ReportCreated,
    FavoriteRemovedOut, FavoritesFilterIn, FavoritesFilterOut, SuggestionsOut,
)
from app.services import favorite_people, report_columns, report_creation, report_drafts, report_views

router = APIRouter(prefix="/reports", tags=["reports"])
_create = require_capability(C.REPORT_CREATE)
_view = require_capability(C.REPORT_VIEW)


@router.post("", response_model=ReportCreated, status_code=201)
async def create_report(body: ReportCreate, response: Response, principal: Principal = Depends(_create),
                        db: AsyncSession = Depends(get_db)) -> dict:
    created = await report_creation.create_report(db, principal, body)
    if created["already_created"]:
        response.status_code = 200  # same key as an earlier successful attempt: that report, not a new one
    return created


@router.get("/entry-config", response_model=EntryConfigOut)
async def entry_config(principal: Principal = Depends(_create), db: AsyncSession = Depends(get_db)) -> dict:
    return await report_creation.entry_config(db, principal)


@router.get("/participant-candidates", response_model=list[CandidateOut])
async def participant_candidates(equipment_id: int | None = None, group_id: int | None = None, q: str | None = Query(None, max_length=64),
                                 limit: int = Query(30, ge=1, le=100), favorites_only: bool = False,
                                 principal: Principal = Depends(_create), db: AsyncSession = Depends(get_db)) -> list[dict]:
    return await report_creation.participant_candidates(db, principal, equipment_id, group_id, q, limit, favorites_only)


@router.put("/favorite-people/{user_id}", status_code=204)
async def add_favorite_person(user_id: int, principal: Principal = Depends(_create), db: AsyncSession = Depends(get_db)) -> None:
    """Star a colleague (idempotent). Private to the caller; unknown / ineligible target == 404."""
    await favorite_people.add_favorite(db, principal, user_id)


@router.delete("/favorite-people/{user_id}", response_model=FavoriteRemovedOut)
async def remove_favorite_person(user_id: int, principal: Principal = Depends(_create), db: AsyncSession = Depends(get_db)) -> dict:
    """Un-star (idempotent). `can_restore` tells the screen whether an undo would be accepted."""
    return await favorite_people.remove_favorite(db, principal, user_id)


@router.put("/favorites-filter", response_model=FavoritesFilterOut)
async def set_favorites_filter(body: FavoritesFilterIn, principal: Principal = Depends(_create),
                               db: AsyncSession = Depends(get_db)) -> dict:
    """Remember the picker's "starred only" switch for this user, on every device."""
    return await favorite_people.set_favorites_only(db, principal, body.favorites_only)


@router.get("/participant-suggestions", response_model=SuggestionsOut)
async def participant_suggestions(equipment_id: int | None = None, group_id: int | None = None,
                                  principal: Principal = Depends(_create), db: AsyncSession = Depends(get_db)) -> dict:
    return await report_creation.participant_suggestions(db, principal, equipment_id, group_id)


@router.get("/equipment-quick-pick", response_model=QuickPickOut)
async def equipment_quick_pick(limit: int = Query(8, ge=1, le=20), principal: Principal = Depends(_create),
                               db: AsyncSession = Depends(get_db)) -> dict:
    return await report_creation.equipment_quick_pick(db, principal, limit)


@router.post("/heartbeat", response_model=HeartbeatOut)
async def heartbeat(_: Principal = Depends(get_current_principal)) -> dict:
    """Client liveness ping while a form is open: proves the session is still valid (401/403 otherwise) and
    returns server time. Server-side idle timeout is Phase 9b; this endpoint writes nothing."""
    return {"ok": True, "server_time": datetime.now(timezone.utc)}


@router.get("/drafts", response_model=list[DraftOut])
async def list_drafts(principal: Principal = Depends(_create), db: AsyncSession = Depends(get_db)) -> list[dict]:
    return await report_drafts.list_drafts(db, principal)


@router.post("/drafts", response_model=DraftOut, status_code=201)
async def create_draft(body: DraftCreate, principal: Principal = Depends(_create),
                       db: AsyncSession = Depends(get_db)) -> dict:
    return await report_drafts.create_draft(db, principal, body.payload)


@router.get("/drafts/{draft_id}", response_model=DraftOut)
async def get_draft(draft_id: int, principal: Principal = Depends(_create), db: AsyncSession = Depends(get_db)) -> dict:
    return await report_drafts.get_draft(db, principal, draft_id)


@router.put("/drafts/{draft_id}", response_model=DraftOut)
async def update_draft(draft_id: int, body: DraftUpdate, principal: Principal = Depends(_create),
                       db: AsyncSession = Depends(get_db)) -> dict:
    return await report_drafts.update_draft(db, principal, draft_id, body.payload, body.version)


@router.delete("/drafts/{draft_id}", status_code=204)
async def delete_draft(draft_id: int, principal: Principal = Depends(_create), db: AsyncSession = Depends(get_db)) -> None:
    await report_drafts.delete_draft(db, principal, draft_id)


# --- read side (Phase 7a). Static paths above; the dynamic `{report_id}` route must stay last. -----------------------

@router.get("", response_model=ReportListOut)
async def list_reports(limit: int = Query(25, ge=1, le=100), cursor: str | None = Query(None, max_length=200),
                       sort_by: str = "event_datetime", order: str = Query("desc", pattern="^(asc|desc)$"),
                       date_from: AwareDatetime | None = None, date_to: AwareDatetime | None = None,
                       report_type_id: int | None = None, group_id: int | None = None, equipment_id: int | None = None,
                       equipment_code: str | None = Query(None, max_length=64), created_by: int | None = None,
                       general_only: bool = False, report_number: str | None = Query(None, max_length=32),
                       q: str | None = Query(None, max_length=100), mine: bool = False,
                       principal: Principal = Depends(_view), db: AsyncSession = Depends(get_db)) -> dict:
    """Reports the caller may see, newest event first. With `equipment_id` this IS the equipment history."""
    return await report_views.list_reports(
        db, principal, limit=limit, cursor=cursor, sort_by=sort_by, descending=order == "desc", date_from=date_from,
        date_to=date_to, report_type_id=report_type_id, group_id=group_id, equipment_id=equipment_id,
        equipment_code=equipment_code, created_by=created_by, general_only=general_only, report_number=report_number,
        q=q, mine=mine)


@router.get("/columns", response_model=list[ColumnOut])
async def list_columns(principal: Principal = Depends(_view)) -> list[dict]:
    return [{"key": c.key, "label_fa": c.label_fa, "default_visible": c.default_visible, "sortable": c.sortable}
            for c in report_columns.columns_for(principal)]


@router.get("/{report_id}", response_model=ReportDetail)
async def get_report(report_id: int, principal: Principal = Depends(_view), db: AsyncSession = Depends(get_db)) -> dict:
    return await report_views.get_report(db, principal, report_id)
