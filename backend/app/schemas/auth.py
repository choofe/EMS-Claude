from pydantic import BaseModel, Field

from app.core.password_policy import MAX_PASSWORD_LENGTH


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=MAX_PASSWORD_LENGTH)


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=MAX_PASSWORD_LENGTH)
    # Upper bound only: the minimum comes from the runtime policy and is checked in the service,
    # so the error is a machine-readable code instead of a generic 422 schema error.
    new_password: str = Field(min_length=1, max_length=1024)


class UserOut(BaseModel):
    id: int
    username: str
    full_name: str
    role_code: str
    role_label_fa: str
    group_ids: list[int]
    must_change_password: bool


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    must_change_password: bool
    user: UserOut
