"""Audit helper (spec section 25). Adds a row to the caller's transaction — the caller commits.
NEVER pass passwords, tokens or hashes in `metadata`."""
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit_log import AuditLog


def add_audit(
    db: AsyncSession,
    *,
    actor_id: int | None,
    action: str,
    entity_type: str,
    entity_id: int | None,
    metadata: dict | None = None,
) -> None:
    db.add(
        AuditLog(
            actor_id=actor_id,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            metadata_json=metadata,
        )
    )
