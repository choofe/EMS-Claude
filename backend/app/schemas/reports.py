"""Report-entry request/response models (Phase 6). Requests forbid unknown fields.

Time values: `event_datetime` must carry a UTC offset (naive values are rejected, not guessed); the server
stores UTC. `minutes` is the only labor unit the API accepts — the UI converts hours+minutes to minutes."""
from datetime import datetime

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

from app.models.report_participant import MAX_PARTICIPANT_MINUTES

MAX_DESCRIPTION_LENGTH = 5000
MAX_PARTICIPANTS = 30


class _Request(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ParticipantIn(_Request):
    user_id: int
    minutes: int = Field(ge=1, le=MAX_PARTICIPANT_MINUTES)


class ReportCreate(_Request):
    equipment_id: int | None = None  # may be omitted only for report types whose equipment_mode is not REQUIRED
    group_id: int | None = None  # required exactly when equipment_id is omitted; must match the equipment's group otherwise
    report_type_id: int
    event_datetime: AwareDatetime
    description: str = Field(max_length=MAX_DESCRIPTION_LENGTH * 2)  # real limit enforced after trimming
    participants: list[ParticipantIn] = Field(default_factory=list, max_length=MAX_PARTICIPANTS)
    draft_id: int | None = None
    # Idempotency key: the form makes one per submission attempt chain; the same key never creates a second report.
    client_request_id: str | None = Field(default=None, min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")


class ParticipantOut(BaseModel):
    user_id: int
    full_name: str
    minutes: int


class ReportCreated(BaseModel):
    id: int
    report_number: str
    equipment_id: int | None
    equipment_code: str | None
    group_id: int
    group_code: str
    report_type_id: int
    is_general: bool
    event_datetime: datetime
    created_at: datetime
    description: str
    participants: list[ParticipantOut]
    already_created: bool = False  # True when the idempotency key matched a report created by an earlier attempt


# ---- drafts: everything optional, minutes may be 0 while the form is half filled
class DraftParticipant(_Request):
    user_id: int | None = None
    # Display name remembered by the form so a restored draft can show it even when the person cannot be looked up
    # (e.g. no equipment chosen yet). Purely cosmetic and never trusted: submit uses user_id only.
    name: str | None = Field(default=None, max_length=128)
    minutes: int = Field(default=0, ge=0, le=MAX_PARTICIPANT_MINUTES)


class DraftPayload(_Request):
    equipment_id: int | None = None
    group_id: int | None = None
    report_type_id: int | None = None
    event_datetime: AwareDatetime | None = None
    description: str | None = Field(default=None, max_length=MAX_DESCRIPTION_LENGTH * 2)
    participants: list[DraftParticipant] = Field(default_factory=list, max_length=MAX_PARTICIPANTS)


class DraftCreate(_Request):
    payload: DraftPayload


class DraftUpdate(_Request):
    payload: DraftPayload
    version: int = Field(ge=1)


class DraftOut(BaseModel):
    id: int
    payload: dict
    version: int
    created_at: datetime
    updated_at: datetime


class CandidateOut(BaseModel):
    id: int
    full_name: str


class SuggestionsOut(BaseModel):
    """Quick-add people (Phase 6c): ids and names only, never minutes."""
    previous: list[CandidateOut]
    frequent: list[CandidateOut]


class QuickEquipmentOut(BaseModel):
    id: int
    equipment_code: str
    group_id: int
    group_code: str
    description: str | None


class QuickPickOut(BaseModel):
    recent: list[QuickEquipmentOut]
    frequent: list[QuickEquipmentOut]


class EntryGroupOut(BaseModel):
    id: int
    code: str
    name: str


class EntryConfigOut(BaseModel):
    """Everything the entry form needs besides the lists it searches: limits, the author's default labor, and the
    groups the caller may file general (equipment-less) reports in."""
    default_labor_minutes: int
    max_participant_minutes: int
    max_participants: int
    max_description_length: int
    future_tolerance_minutes: int
    groups: list[EntryGroupOut]


class HeartbeatOut(BaseModel):
    ok: bool
    server_time: datetime
