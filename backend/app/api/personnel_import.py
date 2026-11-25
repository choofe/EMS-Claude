"""Personnel import (phase-personnel, Pd): preview and commit. Both: EXCEL_IMPORT (MANAGEMENT only). Uploads are
multipart (see app.api.upload_utils); `corrections` is an optional JSON text field with the manager's fixes of
invalid group codes (see schemas.personnel_import.PersonnelCorrection). The import creates NEW people only."""
from fastapi import APIRouter, Depends, File, Form, Response, UploadFile
from pydantic import TypeAdapter, ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_capability
from app.api.upload_utils import UploadRoute, read_upload
from app.core.errors import DomainError
from app.core.permissions import Capability as C, Principal
from app.db.session import get_db
from app.schemas.personnel_import import (
    MAX_CORRECTIONS, MAX_CORRECTIONS_BYTES, PersonnelCommitOut, PersonnelCorrection, PersonnelPreviewOut,
)
from app.services import personnel_import, personnel_import_history as history

_import = require_capability(C.EXCEL_IMPORT)
_corrections = TypeAdapter(list[PersonnelCorrection])

class PersonnelUploadRoute(UploadRoute):
    extra_body_bytes = MAX_CORRECTIONS_BYTES  # the corrections field travels beside the file


router = APIRouter(prefix="/personnel/import", tags=["personnel-import"], route_class=PersonnelUploadRoute)


def _parse_corrections(text: str) -> list[PersonnelCorrection]:
    if not text.strip():
        return []
    if len(text.encode()) > MAX_CORRECTIONS_BYTES:  # the form limit counts characters, the body budget bytes
        raise DomainError("invalid_corrections", 422, max_bytes=MAX_CORRECTIONS_BYTES)
    try:
        items = _corrections.validate_json(text)
    except ValidationError:
        raise DomainError("invalid_corrections", 422) from None
    if len(items) > MAX_CORRECTIONS:
        raise DomainError("invalid_corrections", 422, max_items=MAX_CORRECTIONS)
    return items


@router.post("/preview", response_model=PersonnelPreviewOut, response_model_exclude_none=True)
async def preview(file: UploadFile = File(...), corrections: str = Form("", max_length=MAX_CORRECTIONS_BYTES),
                  who: Principal = Depends(_import), db: AsyncSession = Depends(get_db)) -> dict:
    return await personnel_import.preview_import(db, filename=file.filename or "", data=await read_upload(file),
                                                 corrections=_parse_corrections(corrections),
                                                 include_mobile=who.can(C.PERSONNEL_MOBILE_VIEW))


@router.post("/commit", response_model=PersonnelCommitOut, status_code=201, response_model_exclude_none=True)
async def commit(preview_sha256: str = Form(..., min_length=64, max_length=64), file: UploadFile = File(...),
                 corrections: str = Form("", max_length=MAX_CORRECTIONS_BYTES), actor: Principal = Depends(_import),
                 db: AsyncSession = Depends(get_db)) -> dict:
    return await personnel_import.commit_import(
        db, actor_id=actor.user_id, filename=file.filename or "", data=await read_upload(file),
        expected_sha256=preview_sha256, corrections=_parse_corrections(corrections))


@router.post("/problems.csv", response_class=Response)
async def problems_csv(file: UploadFile = File(...), corrections: str = Form("", max_length=MAX_CORRECTIONS_BYTES),
                       _: Principal = Depends(_import), db: AsyncSession = Depends(get_db)) -> Response:
    """The problem rows of a file as a CSV (the preview keeps nothing, so the file is analysed again). It lists what
    the preview would show after the given corrections: row errors and invalid group codes still left."""
    report, _rows = await personnel_import.analyse_with_corrections(
        db, file.filename or "", await read_upload(file), _parse_corrections(corrections))
    return Response(content=history.build_problem_csv(report), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": 'attachment; filename="personnel-import-problems.csv"',
                             "Cache-Control": "no-store"})
