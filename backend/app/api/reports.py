"""Report entry (Phase 6): create a report, its private drafts, and the helpers the entry form needs.
Every route needs REPORT_CREATE (USER/EXPERT within their groups, MANAGEMENT everywhere; AUDITOR has none).
Report detail/history/editing are Phase 7 — add `/{report_id}` routes AFTER these static paths."""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_principal, require_capability
from app.core.permissions import Capability as C, Principal
from app.db.session import get_db
from app.schemas.reports import (
    CandidateOut, DraftCreate, DraftOut, DraftUpdate, HeartbeatOut, QuickPickOut, ReportCreate, ReportCreated,
)
from app.services import report_creation, report_drafts

router = APIRouter(prefix="/reports", tags=["reports"])
_create = require_capability(C.REPORT_CREATE)


@router.post("", response_model=ReportCreated, status_code=201)
async def create_report(body: ReportCreate, principal: Principal = Depends(_create),
                        db: AsyncSession = Depends(get_db)) -> dict:
    return await report_creation.create_report(db, principal, body)


@router.get("/participant-candidates", response_model=list[CandidateOut])
async def participant_candidates(equipment_id: int, q: str | None = Query(None, max_length=64),
                                 limit: int = Query(30, ge=1, le=100), principal: Principal = Depends(_create),
                                 db: AsyncSession = Depends(get_db)) -> list[dict]:
    return await report_creation.participant_candidates(db, principal, equipment_id, q, limit)


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
