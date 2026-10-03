# path: backend/app/models/__init__.py
"""
Importing this package registers every model on app.db.base.Base's
metadata, which is what Alembic autogenerate compares against and
what tests use for metadata.create_all(). Import order follows FK
dependency order (harmless either way for SQLAlchemy, but easier to
read top-down).
"""
from app.models.role import Role  # noqa: F401
from app.models.user import User  # noqa: F401
from app.models.group import Group  # noqa: F401
from app.models.user_group import UserGroup  # noqa: F401
from app.models.equipment import Equipment  # noqa: F401
from app.models.report_type import ReportType  # noqa: F401
from app.models.report_sequence import ReportSequence  # noqa: F401
from app.models.report import Report  # noqa: F401
from app.models.report_participant import ReportParticipant  # noqa: F401
from app.models.system_setting import SystemSetting  # noqa: F401
from app.models.audit_log import AuditLog  # noqa: F401
from app.models.refresh_token import RefreshToken  # noqa: F401
from app.models.login_attempt import LoginAttempt  # noqa: F401

__all__ = [
    "Role",
    "User",
    "Group",
    "UserGroup",
    "Equipment",
    "ReportType",
    "ReportSequence",
    "Report",
    "ReportParticipant",
    "SystemSetting",
    "AuditLog",
    "RefreshToken",
    "LoginAttempt",
]
