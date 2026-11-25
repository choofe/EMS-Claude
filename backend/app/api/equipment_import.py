"""Equipment import (Phase 5). All endpoints: EXCEL_IMPORT (MANAGEMENT only; AUDITOR has no write capability).
Uploads are multipart; the declared Content-Length is checked BEFORE the body is read, and the bytes read are
bounded again, so an oversized file is refused without being buffered. Chunked uploads (no Content-Length)
are refused with 411 — browsers always send a length for file uploads."""
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, Query, Response, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_capability
from app.api.upload_utils import UploadRoute, read_upload
from app.core.permissions import Capability as C, Principal
from app.db.session import get_db
from app.schemas.admin import MAX_OFFSET, Page
from app.schemas.equipment_import import ImportBatchOut, ImportCommitOut, ImportPreviewOut, ImportUndoOut
from app.services import equipment_import

_import = require_capability(C.EXCEL_IMPORT)


uploads = APIRouter(route_class=UploadRoute)
router = APIRouter(prefix="/equipment/import", tags=["equipment-import"])


@uploads.post("/preview", response_model=ImportPreviewOut, response_model_exclude_none=True)
async def preview(group_id: int = Form(...), file: UploadFile = File(...), _: Principal = Depends(_import),
                  db: AsyncSession = Depends(get_db)) -> dict:
    return await equipment_import.preview_import(db, group_id=group_id, filename=file.filename or "",
                                                 data=await read_upload(file))


@uploads.post("/commit", response_model=ImportCommitOut, status_code=201, response_model_exclude_none=True)
async def commit(group_id: int = Form(...), preview_sha256: str = Form(..., min_length=64, max_length=64),
                 file: UploadFile = File(...), actor: Principal = Depends(_import),
                 db: AsyncSession = Depends(get_db)) -> dict:
    return await equipment_import.commit_import(db, actor_id=actor.user_id, group_id=group_id,
                                                filename=file.filename or "", data=await read_upload(file),
                                                expected_sha256=preview_sha256)


@router.get("/template")
async def template(fmt: Literal["xlsx", "csv"] = Query("xlsx", alias="format"),
                   _: Principal = Depends(_import)) -> Response:
    content, media_type, name = equipment_import.build_template(fmt)
    return Response(content=content, media_type=media_type,
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.get("/batches", response_model=Page[ImportBatchOut])
async def batches(limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0, le=MAX_OFFSET),
                  _: Principal = Depends(_import), db: AsyncSession = Depends(get_db)) -> dict:
    items, total = await equipment_import.list_batches(db, limit=limit, offset=offset)
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.post("/batches/{batch_id}/undo", response_model=ImportUndoOut)
async def undo(batch_id: int, actor: Principal = Depends(_import), db: AsyncSession = Depends(get_db)) -> dict:
    return await equipment_import.undo_batch(db, actor_id=actor.user_id, batch_id=batch_id)


router.include_router(uploads)
