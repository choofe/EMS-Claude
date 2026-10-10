"""Report types. Read: any logged-in role (needed to file reports); inactive ones are listed only for
MANAGEMENT. Write: REPORT_TYPES_MANAGE."""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_capability
from app.core.permissions import Capability as C, Principal
from app.db.session import get_db
from app.schemas.admin import ReportTypeCreate, ReportTypeOut, ReportTypeUpdate
from app.services import report_type_admin

router = APIRouter(prefix="/report-types", tags=["report-types"])
_manage = require_capability(C.REPORT_TYPES_MANAGE)


@router.get("", response_model=list[ReportTypeOut])
async def list_report_types(include_inactive: bool = False,
                            principal: Principal = Depends(require_capability(C.REPORT_TYPES_VIEW)),
                            db: AsyncSession = Depends(get_db)) -> list[dict]:
    return await report_type_admin.list_report_types(
        db, include_inactive=include_inactive and principal.can(C.REPORT_TYPES_MANAGE))


@router.post("", response_model=ReportTypeOut, status_code=201)
async def create(body: ReportTypeCreate, actor: Principal = Depends(_manage), db: AsyncSession = Depends(get_db)) -> dict:
    return await report_type_admin.create_report_type(db, actor_id=actor.user_id, code=body.code,
                                                      name_fa=body.name_fa, is_failure=body.is_failure)


@router.patch("/{type_id}", response_model=ReportTypeOut)
async def update(type_id: int, body: ReportTypeUpdate, actor: Principal = Depends(_manage),
                 db: AsyncSession = Depends(get_db)) -> dict:
    fields = {k: getattr(body, k) for k in body.model_fields_set}
    return await report_type_admin.update_report_type(db, actor_id=actor.user_id, type_id=type_id, **fields)


@router.post("/{type_id}/deactivate", response_model=ReportTypeOut)
async def deactivate(type_id: int, actor: Principal = Depends(_manage), db: AsyncSession = Depends(get_db)) -> dict:
    return await report_type_admin.set_report_type_active(db, actor_id=actor.user_id, type_id=type_id, active=False)


@router.post("/{type_id}/activate", response_model=ReportTypeOut)
async def activate(type_id: int, actor: Principal = Depends(_manage), db: AsyncSession = Depends(get_db)) -> dict:
    return await report_type_admin.set_report_type_active(db, actor_id=actor.user_id, type_id=type_id, active=True)
