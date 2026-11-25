"""Personnel import history (phase-personnel, Pg). Reading (the batch list and a batch's people) needs AUDIT_VIEW:
MANAGEMENT and AUDITOR. Cancelling needs EXCEL_IMPORT: MANAGEMENT only, any manager for any batch. A cancel is two
steps: a preview (writes nothing) and a confirmation that carries the preview's fingerprint. JSON only, so this router
does not use the upload route class."""
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_capability
from app.core.permissions import Capability as C, Principal
from app.db.session import get_db
from app.schemas.admin import Page
from app.schemas.personnel_import import (
    BatchPerson, CancelConfirmIn, CancelOut, CancelPreviewOut, ImportBatchItem,
)
from app.services import personnel_import_history as history

_read = require_capability(C.AUDIT_VIEW)
_cancel = require_capability(C.EXCEL_IMPORT)

router = APIRouter(prefix="/personnel/import", tags=["personnel-import-history"])


@router.get("/batches", response_model=Page[ImportBatchItem])
async def batches(limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0, le=100_000),
                  _: Principal = Depends(_read), db: AsyncSession = Depends(get_db)) -> dict:
    items, total = await history.list_batches(db, limit=limit, offset=offset)
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.get("/batches/{batch_id}/people", response_model=Page[BatchPerson])
async def batch_people(batch_id: int, limit: int = Query(100, ge=1, le=200), offset: int = Query(0, ge=0, le=100_000),
                       who: Principal = Depends(_read), db: AsyncSession = Depends(get_db)) -> dict:
    items, total = await history.batch_people(db, batch_id=batch_id, limit=limit, offset=offset,
                                              with_mobile=who.can(C.PERSONNEL_MOBILE_VIEW))
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.post("/batches/{batch_id}/cancel-preview", response_model=CancelPreviewOut)
async def cancel_preview(batch_id: int, _: Principal = Depends(_cancel), db: AsyncSession = Depends(get_db)) -> dict:
    return await history.cancel_preview(db, batch_id=batch_id)


@router.post("/batches/{batch_id}/cancel", response_model=CancelOut)
async def cancel(batch_id: int, body: CancelConfirmIn, actor: Principal = Depends(_cancel),
                 db: AsyncSession = Depends(get_db)) -> dict:
    return await history.cancel_confirm(db, actor_id=actor.user_id, batch_id=batch_id,
                                        expected_fingerprint=body.fingerprint)
