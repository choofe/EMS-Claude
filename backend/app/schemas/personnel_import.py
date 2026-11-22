"""Schemas of the personnel import API (requests are multipart forms; `corrections` is a JSON text field)."""
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

MAX_CORRECTIONS = 2000
MAX_CORRECTIONS_BYTES = 200_000  # the `corrections` form field, in UTF-8 bytes (the route adds it to the body budget)


class PersonnelCorrection(BaseModel):
    """One manager's fix, applied by the server to the same file and re-validated:
    replace = change one invalid group code (`token`, as the preview showed it) to the group code `to`;
    remove  = drop that invalid group code from the person (the person is kept);
    drop    = leave the whole row out of the import."""
    row: int = Field(ge=2, le=1_000_000)
    op: Literal["replace", "remove", "drop"]
    token: str | None = Field(default=None, max_length=32)
    to: str | None = Field(default=None, max_length=64)

    @model_validator(mode="after")
    def _shape(self):
        if self.op == "drop" and (self.token is not None or self.to is not None):
            raise ValueError("drop takes only a row")
        if self.op == "remove" and (not self.token or self.to is not None):
            raise ValueError("remove takes a row and a token")
        if self.op == "replace" and (not self.token or not self.to):
            raise ValueError("replace takes a row, a token and a target")
        return self


class PersonnelRowError(BaseModel):
    row: int
    first_name: str | None = None     # cleaned; None when the name itself is the problem (or the cell is a formula/date)
    last_name: str | None = None
    personnel_code: str               # the code as typed (at most 16 characters); never the mobile number
    code: str                         # stable reason; the frontend maps it to a Persian message
    column: str | None = None         # date_cell, formula_not_allowed
    max_groups: int | None = None     # too_many_groups


class InvalidGroup(BaseModel):
    token: str
    reason: Literal["malformed", "unknown", "inactive"]


class PersonnelGroupIssue(BaseModel):
    row: int
    first_name: str
    last_name: str
    personnel_code: int
    invalid_groups: list[InvalidGroup]


class PersonnelSampleRow(BaseModel):
    row: int
    personnel_code: int
    full_name: str
    group_codes: list[str]


class FileRow(BaseModel):
    row: int
    first_name: str
    last_name: str
    personnel_code: int
    group_codes: list[str]
    mobile: str | None = None         # only in the preview and only for holders of personnel.mobile.view


class FileConflict(BaseModel):
    """Rows of the file linked by a shared personnel code or mobile (one cluster, possibly more than two rows). None
    of them is importable until the manager keeps ONE (the others are dropped) or drops all of them."""
    shared: list[Literal["personnel_code", "mobile"]]
    same_name: bool                   # every row carries the same name: probably ONE person with mistyped identifiers
    rows: list[FileRow]


class PersonnelReportOut(BaseModel):
    file_name: str
    file_sha256: str
    rows_total: int
    valid_count: int
    error_count: int
    group_issue_count: int
    dropped_count: int = 0
    ignored_columns: list[str]
    errors: list[PersonnelRowError]
    group_issues: list[PersonnelGroupIssue]
    sample: list[PersonnelSampleRow]
    file_conflict_count: int = 0      # clusters still undecided: the commit is refused while any is left
    file_conflicts: list[FileConflict] = []


class SameNameMatch(BaseModel):
    """An EXISTING person with the same (folded) full name. Never a mobile number, username or role."""
    full_name: str
    personnel_code: int | None = None  # omitted from the JSON (route uses exclude_none) for an old person without a code
    group_codes: list[str]
    is_active: bool
    has_profile: bool
    mobile: str | None = None         # only for holders of personnel.mobile.view


class SameNameRow(BaseModel):
    row: int
    first_name: str
    last_name: str
    personnel_code: int               # the code in the file
    mobile: str | None = None         # the file row's mobile; only for holders of personnel.mobile.view
    matches_total: int
    matches: list[SameNameMatch]      # at most 5, ascending personnel code (people without a code last)


class SameNameInFile(BaseModel):
    """Importable rows with the same name but a different code AND a different mobile: probably different people."""
    rows: list[FileRow]


class PersonnelPreviewOut(PersonnelReportOut):
    same_name_in_file: list[SameNameInFile] = []
    same_name_count: int = 0          # importable rows with at least one same-name person (complete count)
    same_names: list[SameNameRow] = []  # at most 200 rows, in file order


class PersonnelCommitOut(PersonnelReportOut):
    batch_id: int
    created_count: int


# ---------------------------------------------------------------- history and cancel (Pg)
class ImportBatchItem(BaseModel):
    id: int
    kind: str                      # PERSONNEL today; the equipment import may share the history later
    file_name: str
    created_at: datetime
    created_by_name: str
    created_count: int
    rejected_count: int
    removed_count: int             # people removed by cancels so far (never their names)
    remaining_count: int           # people of the batch who still exist (counted live)
    status: Literal["complete", "partial", "cancelled"]
    undone_at: datetime | None     # time of the LAST cancel


class BatchPerson(BaseModel):
    """A person of the batch with CURRENT data; `mobile` only for holders of personnel.mobile.view."""
    id: int
    first_name: str | None
    last_name: str | None
    full_name: str
    personnel_code: int | None
    group_codes: list[str]
    is_active: bool
    has_profile: bool
    mobile: str | None = None


class ExemptReasons(BaseModel):
    """People kept by each reason; one person may be counted under several."""
    profile: int
    reports: int
    participation: int
    stars: int


class CancelPreviewOut(BaseModel):
    batch_id: int
    remaining_count: int
    removable_count: int
    exempt_count: int
    exempt_reasons: ExemptReasons
    fingerprint: str


class CancelConfirmIn(BaseModel):
    fingerprint: str = Field(min_length=64, max_length=64)


class CancelOut(BaseModel):
    batch_id: int
    removed_count: int
    kept_count: int
