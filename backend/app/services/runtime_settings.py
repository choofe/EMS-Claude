"""
Runtime-tunable settings (system_settings table). ONLY keys registered here exist: the API cannot
create arbitrary keys, every key has a type, hard bounds, a default and a Persian label for the
dashboard. Reads CLAMP (a garbage/out-of-range row can never weaken a policy below its floor);
writes through the API are strictly validated (out of range -> 422, never silently clamped).

`special` lists out-of-range sentinel values that are legal on purpose (REPORT_EDIT_WINDOW_HOURS: -1 = unlimited).
Not tunable here (env only): JWT secret/algorithm, cookie flags, token lifetimes.
"""
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import DomainError
from app.models.system_setting import SystemSetting


@dataclass(frozen=True)
class IntSettingSpec:
    key: str
    default: int
    minimum: int
    maximum: int
    label_fa: str
    description: str
    special: tuple[int, ...] = field(default=())


PASSWORD_MIN_LENGTH = IntSettingSpec(
    "PASSWORD_MIN_LENGTH", 8, 8, 64, "حداقل طول رمز عبور",
    "Minimum password length (floor 8). Existing users below it must change password at next login.",
)
LOGIN_MAX_ATTEMPTS = IntSettingSpec(
    "LOGIN_MAX_ATTEMPTS", 5, 3, 20, "حداکثر تلاش ناموفق ورود",
    "Failed logins per username within the window before lockout.",
)
LOGIN_LOCKOUT_MINUTES = IntSettingSpec(
    "LOGIN_LOCKOUT_MINUTES", 15, 1, 1440, "مدت قفل ورود (دقیقه)",
    "Length of the failed-login counting window / lockout, in minutes.",
)
LOGIN_MAX_ATTEMPTS_PER_IP = IntSettingSpec(
    "LOGIN_MAX_ATTEMPTS_PER_IP", 0, 0, 100000, "حداکثر تلاش ناموفق به‌ازای هر IP (۰ = غیرفعال)",
    "Failed logins per client IP within the window before that IP is blocked. 0 = disabled; keep "
    "disabled until the deployment reports real client IPs, otherwise one proxy IP would lock everyone.",
)
REPORT_EDIT_WINDOW_HOURS = IntSettingSpec(
    "REPORT_EDIT_WINDOW_HOURS", 24, 0, 720, "مهلت ویرایش گزارش توسط کاربر عادی (ساعت)",
    "Hours after creation during which a USER may edit their own report. 0 = USER cannot edit; "
    "-1 = unlimited. EXPERT/MANAGEMENT editing is not limited by this setting.",
    special=(-1,),
)

REGISTRY: dict[str, IntSettingSpec] = {
    s.key: s
    for s in (
        REPORT_EDIT_WINDOW_HOURS,
        PASSWORD_MIN_LENGTH,
        LOGIN_MAX_ATTEMPTS,
        LOGIN_LOCKOUT_MINUTES,
        LOGIN_MAX_ATTEMPTS_PER_IP,
    )
}


def resolve(spec: IntSettingSpec, raw: str | None) -> int:
    """Stored text -> effective value. Missing/garbage -> default; out of range -> clamped."""
    if raw is None:
        return spec.default
    try:
        value = int(raw.strip())
    except ValueError:
        return spec.default
    if value in spec.special:
        return value
    return max(spec.minimum, min(spec.maximum, value))


def validate(spec: IntSettingSpec, value: int) -> int:
    if value in spec.special or spec.minimum <= value <= spec.maximum:
        return value
    raise DomainError(
        "setting_out_of_range", 422,
        key=spec.key, minimum=spec.minimum, maximum=spec.maximum, special=list(spec.special),
    )


async def _raw_values(db: AsyncSession, keys: list[str]) -> dict[str, str]:
    rows = (
        await db.execute(select(SystemSetting.key, SystemSetting.value).where(SystemSetting.key.in_(keys)))
    ).all()
    return {k: v for k, v in rows}


@dataclass(frozen=True)
class AuthPolicy:
    password_min_length: int
    login_max_attempts: int
    login_lockout_minutes: int
    login_max_attempts_per_ip: int


async def get_auth_policy(db: AsyncSession) -> AuthPolicy:
    raw = await _raw_values(
        db, [PASSWORD_MIN_LENGTH.key, LOGIN_MAX_ATTEMPTS.key, LOGIN_LOCKOUT_MINUTES.key, LOGIN_MAX_ATTEMPTS_PER_IP.key]
    )
    return AuthPolicy(
        password_min_length=resolve(PASSWORD_MIN_LENGTH, raw.get(PASSWORD_MIN_LENGTH.key)),
        login_max_attempts=resolve(LOGIN_MAX_ATTEMPTS, raw.get(LOGIN_MAX_ATTEMPTS.key)),
        login_lockout_minutes=resolve(LOGIN_LOCKOUT_MINUTES, raw.get(LOGIN_LOCKOUT_MINUTES.key)),
        login_max_attempts_per_ip=resolve(LOGIN_MAX_ATTEMPTS_PER_IP, raw.get(LOGIN_MAX_ATTEMPTS_PER_IP.key)),
    )


async def get_report_edit_window_hours(db: AsyncSession) -> int | None:
    """Hours a USER may edit their own report after creation; None = unlimited (used by Phase 7)."""
    raw = (await _raw_values(db, [REPORT_EDIT_WINDOW_HOURS.key])).get(REPORT_EDIT_WINDOW_HOURS.key)
    hours = resolve(REPORT_EDIT_WINDOW_HOURS, raw)
    return None if hours == -1 else hours
