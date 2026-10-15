"""Response models for the equipment import API (requests are multipart forms, validated in the router)."""
from datetime import datetime

from pydantic import BaseModel


class ImportGroup(BaseModel):
    id: int
    code: str
    name: str


class ImportSampleRow(BaseModel):
    row: int
    equipment_code: str
    description: str | None


class ImportRowError(BaseModel):
    row: int
    equipment_code: str
    code: str                         # stable reason; the frontend maps it to a Persian message
    found: str | None = None          # group_mismatch
    expected: str | None = None       # group_mismatch
    first_row: int | None = None      # duplicate_in_file
    existing_group_code: str | None = None   # already_exists
    existing_is_active: bool | None = None   # already_exists
    bad_chars: list[str] | None = None       # invalid_equipment_code
    column: str | None = None                # date_cell


class ImportPreviewOut(BaseModel):
    group: ImportGroup
    file_name: str
    file_sha256: str
    rows_total: int
    valid_count: int
    error_count: int
    ignored_columns: list[str]
    errors: list[ImportRowError]
    sample: list[ImportSampleRow]


class ImportCommitOut(ImportPreviewOut):
    batch_id: int
    created_count: int


class ImportBatchOut(BaseModel):
    id: int
    group_id: int
    group_code: str
    group_name: str
    file_name: str
    created_by_name: str
    created_at: datetime
    created_count: int
    rejected_count: int
    remaining_count: int
    report_count: int
    undone_at: datetime | None
    can_undo: bool


class ImportUndoOut(BaseModel):
    batch_id: int
    deleted_count: int
