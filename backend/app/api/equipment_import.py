"""Equipment import (Phase 5). All endpoints: EXCEL_IMPORT (MANAGEMENT only; AUDITOR has no write capability).
Uploads are multipart; the declared Content-Length is checked BEFORE the body is read, and the bytes read are
bounded again, so an oversized file is refused without being buffered. Chunked uploads (no Content-Length)
are refused with 411 — browsers always send a length for file uploads."""
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, Query, Request, Response, UploadFile
from fastapi.routing import APIRoute
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_capability
from app.core.config import get_settings
from app.core.errors import DomainError
from app.core.permissions import Capability as C, Principal
from app.db.session import get_db
from app.schemas.admin import MAX_OFFSET, Page
from app.schemas.equipment_import import ImportBatchOut, ImportCommitOut, ImportPreviewOut, ImportUndoOut
from app.services import equipment_import

_MULTIPART_OVERHEAD = 64 * 1024
_import = require_capability(C.EXCEL_IMPORT)


class _UploadRoute(APIRoute):
    def get_route_handler(self):
        original = super().get_route_handler()

        async def handler(request: Request):
            limit = get_settings().import_max_bytes
            length = request.headers.get("content-length")
            if length is None or not length.isdigit():
                raise DomainError("length_required", 411)
            if int(length) > limit + _MULTIPART_OVERHEAD:
                raise DomainError("file_too_large", 413, max_bytes=limit)
            return await original(request)

        return handler


async def _read(file: UploadFile) -> bytes:
    limit = get_settings().import_max_bytes
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise DomainError("file_too_large", 413, max_bytes=limit)
    return data


uploads = APIRouter(route_class=_UploadRoute)
router = APIRouter(prefix="/equipment/import", tags=["equipment-import"])


@uploads.post("/preview", response_model=ImportPreviewOut, response_model_exclude_none=True)
async def preview(group_id: int = Form(...), file: UploadFile = File(...), _: Principal = Depends(_import),
                  db: AsyncSession = Depends(get_db)) -> dict:
    return await equipment_import.preview_import(db, group_id=group_id, filename=file.filename or "",
                                                 data=await _read(file))


@uploads.post("/commit", response_model=ImportCommitOut, status_code=201, response_model_exclude_none=True)
async def commit(group_id: int = Form(...), preview_sha256: str = Form(..., min_length=64, max_length=64),
                 file: UploadFile = File(...), actor: Principal = Depends(_import),
                 db: AsyncSession = Depends(get_db)) -> dict:
    return await equipment_import.commit_import(db, actor_id=actor.user_id, group_id=group_id,
                                                filename=file.filename or "", data=await _read(file),
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
