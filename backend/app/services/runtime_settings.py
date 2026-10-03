"""
Security-relevant settings that Management can tune at runtime (via the
system_settings table; the dashboard comes in Phase 4). Each has a default
and HARD bounds in code: a missing row, garbage value, or out-of-range value
can never weaken the policy below the floor — values are clamped, and the
floor for PASSWORD_MIN_LENGTH is 8.

Not tunable here on purpose (env only): JWT secret/algorithm, cookie flags.
"""
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.system_setting import SystemSetting


@dataclass(frozen=True)
class IntSettingSpec:
    key: str
    default: int
    minimum: int
    maximum: int
    description: str


PASSWORD_MIN_LENGTH = IntSettingSpec("PASSWORD_MIN_LENGTH", 8, 8, 64, "Minimum password length.")
LOGIN_MAX_ATTEMPTS = IntSettingSpec(
    "LOGIN_MAX_ATTEMPTS", 5, 3, 20, "Failed logins per username within the window before lockout."
)
LOGIN_LOCKOUT_MINUTES = IntSettingSpec(
    "LOGIN_LOCKOUT_MINUTES", 15, 1, 1440, "Length of the failed-login counting window / lockout, in minutes."
)
LOGIN_MAX_ATTEMPTS_PER_IP = IntSettingSpec(
    "LOGIN_MAX_ATTEMPTS_PER_IP",
    0,
    0,
    100000,
    "Failed logins per client IP within the window before that IP is blocked. 0 = disabled "
    "(keep disabled until the deployment reports real client IPs, otherwise one proxy IP would lock everyone).",
)

AUTH_SPECS = (PASSWORD_MIN_LENGTH, LOGIN_MAX_ATTEMPTS, LOGIN_LOCKOUT_MINUTES, LOGIN_MAX_ATTEMPTS_PER_IP)


def _resolve(spec: IntSettingSpec, raw: str | None) -> int:
    if raw is None:
        return spec.default
    try:
        value = int(raw.strip())
    except ValueError:
        return spec.default
    return max(spec.minimum, min(spec.maximum, value))


@dataclass(frozen=True)
class AuthPolicy:
    password_min_length: int
    login_max_attempts: int
    login_lockout_minutes: int
    login_max_attempts_per_ip: int


async def get_auth_policy(db: AsyncSession) -> AuthPolicy:
    rows = (
        await db.execute(
            select(SystemSetting.key, SystemSetting.value).where(
                SystemSetting.key.in_([s.key for s in AUTH_SPECS])
            )
        )
    ).all()
    raw = {k: v for k, v in rows}
    return AuthPolicy(
        password_min_length=_resolve(PASSWORD_MIN_LENGTH, raw.get(PASSWORD_MIN_LENGTH.key)),
        login_max_attempts=_resolve(LOGIN_MAX_ATTEMPTS, raw.get(LOGIN_MAX_ATTEMPTS.key)),
        login_lockout_minutes=_resolve(LOGIN_LOCKOUT_MINUTES, raw.get(LOGIN_LOCKOUT_MINUTES.key)),
        login_max_attempts_per_ip=_resolve(
            LOGIN_MAX_ATTEMPTS_PER_IP, raw.get(LOGIN_MAX_ATTEMPTS_PER_IP.key)
        ),
    )
