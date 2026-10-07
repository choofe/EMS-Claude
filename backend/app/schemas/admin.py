"""Request/response models for the management API. Requests forbid unknown fields, so immutable fields
(group code, equipment code, report-type code, ...) cannot be sent at all — they fail with 422."""
from datetime import datetime
from typing import Generic, TypeVar

from pydantic import BaseModel, ConfigDict, Field

from app.core.password_policy import MAX_PASSWORD_LENGTH

T = TypeVar("T")


class Request(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    limit: int
    offset: int


# ---- users
class UserOut(BaseModel):
    id: int
    username: str
    full_name: str
    role_code: str
    role_label_fa: str
    is_active: bool
    must_change_password: bool
    group_ids: list[int]
    created_at: datetime
    updated_at: datetime


class UserCreate(Request):
    username: str = Field(min_length=1, max_length=64)
    full_name: str = Field(min_length=1, max_length=128)
    role_code: str = Field(min_length=1, max_length=32)
    password: str = Field(min_length=1, max_length=MAX_PASSWORD_LENGTH)
    group_ids: list[int] = Field(default_factory=list, max_length=200)
    must_change_password: bool = True


class UserUpdate(Request):
    full_name: str | None = Field(default=None, max_length=128)
    role_code: str | None = Field(default=None, max_length=32)


class UserGroupsSet(Request):
    group_ids: list[int] = Field(max_length=200)


class PasswordReset(Request):
    password: str = Field(min_length=1, max_length=MAX_PASSWORD_LENGTH)
    must_change_password: bool = True


class CountOut(BaseModel):
    users_affected: int


# ---- groups
class GroupOut(BaseModel):
    id: int
    code: str
    name: str
    description: str | None
    is_active: bool
    equipment_count: int
    member_count: int
    created_at: datetime
    updated_at: datetime


class GroupCreate(Request):
    code: str = Field(min_length=1, max_length=16)
    name: str = Field(min_length=1, max_length=128)
    description: str | None = Field(default=None, max_length=2000)


class GroupUpdate(Request):
    name: str | None = Field(default=None, max_length=128)
    description: str | None = Field(default=None, max_length=2000)


# ---- equipment
class EquipmentOut(BaseModel):
    id: int
    equipment_code: str
    group_id: int
    group_code: str
    group_name: str
    description: str | None
    is_active: bool
    created_at: datetime
    updated_at: datetime


class EquipmentCreate(Request):
    equipment_code: str = Field(min_length=1, max_length=64)
    group_id: int
    description: str | None = Field(default=None, max_length=2000)


class EquipmentUpdate(Request):
    description: str | None = Field(default=None, max_length=2000)


class EquipmentMove(Request):
    group_id: int


# ---- report types
class ReportTypeOut(BaseModel):
    id: int
    code: str
    name_fa: str
    is_failure: bool
    is_active: bool
    created_at: datetime
    updated_at: datetime


class ReportTypeCreate(Request):
    code: str = Field(min_length=1, max_length=32)
    name_fa: str = Field(min_length=1, max_length=128)
    is_failure: bool = False


class ReportTypeUpdate(Request):
    name_fa: str | None = Field(default=None, max_length=128)
    is_failure: bool | None = None


# ---- settings
class SettingOut(BaseModel):
    key: str
    label_fa: str
    description: str
    value: int
    default: int
    minimum: int
    maximum: int
    special_values: list[int]
    is_default: bool
    updated_at: datetime | None
    updated_by: int | None


class SettingUpdate(Request):
    value: int
