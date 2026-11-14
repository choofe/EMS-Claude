"""
Personnel management (sub-phase Pb): people with or without a login profile. Everything here is MANAGEMENT-only
(the API enforces the capability) and every function commits and writes its own audit row.

Rules (decisions of 2026-11-11/13):
- A NEW person always has first name, last name, personnel code and mobile; a login profile is optional and is
  created only here (together with the person, or later for an existing person). Profile type: USER or EXPERT.
- Personnel code is the import's duplicate key: changing an existing code needs a reason (typo, unit change, rehire,
  organisation-wide change, other + note); a code can never be cleared. Same for a username change.
- The audit never carries a mobile number or a password.
"""
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import DomainError
from app.core.normalize import (canonical_mobile, canonical_personnel_code, canonical_username, clean_text,
                                compose_full_name)
from app.core.permissions import Principal
from app.models.role import Role
from app.models.user import User
from app.models.user_group import UserGroup
from app.services.audit import add_audit
from app.services.auth_service import revoke_all_user_tokens
from app.services.user_admin import (MANAGEMENT, _assert_management_remains, _check_groups_assignable, _lock_management,
                                     _role, _user, _validated_password, can_see_mobile, get_user_view)

PROFILE_ROLES = ("USER", "EXPERT")
CODE_REASONS = ("TYPO", "UNIT_CHANGE", "REHIRE", "ORG_WIDE_CHANGE", "OTHER")
USERNAME_REASONS = ("TYPO", "NAME_CHANGE", "OTHER")


def _reason(reason: str | None, note: str | None, allowed: tuple[str, ...]) -> tuple[str, str | None]:
    if reason not in allowed:
        raise DomainError("reason_required", 422, allowed=list(allowed))
    clean = clean_text(note, max_length=200, code="invalid_reason_note") if note and note.strip() else None
    if reason == "OTHER" and clean is None:
        raise DomainError("reason_note_required", 422)
    return reason, clean


async def _taken(db: AsyncSession, *, code: int | None = None, mobile: str | None = None, exclude: int | None = None) -> None:
    """Friendly 409 before the unique index would answer with an IntegrityError (the index stays the last guard)."""
    for column, value, err in ((User.personnel_code, code, "personnel_code_taken"), (User.mobile, mobile, "mobile_taken")):
        if value is None:
            continue
        stmt = select(User.id).where(column == value)
        if exclude is not None:
            stmt = stmt.where(User.id != exclude)
        if (await db.execute(stmt)).first():
            raise DomainError(err, 409)


async def _flush_or_conflict(db: AsyncSession) -> None:
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        text = str(exc.orig).lower()
        for needle, err in (("personnel_code", "personnel_code_taken"), ("mobile", "mobile_taken"), ("username", "username_taken")):
            if needle in text:
                raise DomainError(err, 409)
        raise DomainError("conflict", 409)


async def _attach_profile(db: AsyncSession, user: User, *, username: str, password: str, role_code: str,
                          must_change_password: bool) -> Role:
    if role_code not in PROFILE_ROLES:
        raise DomainError("invalid_profile_role", 422, allowed=list(PROFILE_ROLES))
    username = canonical_username(username)
    role = await _role(db, role_code)
    if (await db.execute(select(User.id).where(User.username == username))).first():
        raise DomainError("username_taken", 409)
    user.hashed_password = await _validated_password(db, password, username)
    user.username, user.role_id = username, role.id
    user.login_enabled, user.must_change_password = True, must_change_password
    return role


async def create_person(
    db: AsyncSession, *, actor: Principal, first_name: str, last_name: str, personnel_code: str | int, mobile: str,
    group_ids: list[int], profile: dict | None = None,
) -> dict:
    """A new person (all four identity fields mandatory); `profile` = {username, password, role_code,
    must_change_password} creates the login profile in the same transaction ("from scratch")."""
    full_name = compose_full_name(first_name, last_name)
    code, phone = canonical_personnel_code(personnel_code), canonical_mobile(mobile)
    wanted = set(group_ids)
    await _check_groups_assignable(db, wanted)
    await _taken(db, code=code, mobile=phone)
    user = User(full_name=full_name, first_name=clean_text(first_name, max_length=64, code="invalid_first_name"),
                last_name=clean_text(last_name, max_length=64, code="invalid_last_name"),
                personnel_code=code, mobile=phone, login_enabled=False)
    role = None
    if profile is not None:
        role = await _attach_profile(db, user, **profile)
    db.add(user)
    await _flush_or_conflict(db)
    for gid in sorted(wanted):
        db.add(UserGroup(user_id=user.id, group_id=gid))
    add_audit(db, actor_id=actor.user_id, action="user.create_person", entity_type="user", entity_id=user.id,
              metadata={"personnel_code": code, "group_ids": sorted(wanted), "has_profile": role is not None,
                        **({"username": user.username, "role": role.code} if role else {})})
    await db.commit()
    return await get_user_view(db, user.id, can_see_mobile(actor))


async def create_profile(
    db: AsyncSession, *, actor: Principal, user_id: int, username: str, password: str, role_code: str,
    must_change_password: bool,
) -> dict:
    user = await _user(db, user_id, lock=True)
    if user.username is not None:
        raise DomainError("user_has_profile", 409)
    if not user.is_active:
        raise DomainError("person_inactive", 409)
    role = await _attach_profile(db, user, username=username, password=password, role_code=role_code,
                                 must_change_password=must_change_password)
    await _flush_or_conflict(db)
    add_audit(db, actor_id=actor.user_id, action="user.profile_create", entity_type="user", entity_id=user.id,
              metadata={"username": user.username, "role": role.code, "must_change_password": must_change_password})
    await db.commit()
    return await get_user_view(db, user_id, can_see_mobile(actor))


async def set_personnel_code(db: AsyncSession, *, actor: Principal, user_id: int, personnel_code: str | int,
                             reason: str | None, note: str | None) -> dict:
    code = canonical_personnel_code(personnel_code)
    user = await _user(db, user_id, lock=True)
    if user.personnel_code == code:
        return await get_user_view(db, user_id, can_see_mobile(actor))
    meta: dict = {"from": user.personnel_code, "to": code}
    if user.personnel_code is not None:  # the first assignment (old users) needs no reason; a change does
        meta["reason"], meta["note"] = _reason(reason, note, CODE_REASONS)
    await _taken(db, code=code, exclude=user.id)
    user.personnel_code = code
    await _flush_or_conflict(db)
    add_audit(db, actor_id=actor.user_id, action="user.personnel_code_change", entity_type="user", entity_id=user.id,
              metadata=meta)
    await db.commit()
    return await get_user_view(db, user_id, can_see_mobile(actor))


async def set_mobile(db: AsyncSession, *, actor: Principal, user_id: int, mobile: str) -> dict:
    phone = canonical_mobile(mobile)
    user = await _user(db, user_id, lock=True)
    if user.mobile != phone:
        await _taken(db, mobile=phone, exclude=user.id)
        had = user.mobile is not None
        user.mobile = phone
        await _flush_or_conflict(db)
        add_audit(db, actor_id=actor.user_id, action="user.mobile_change", entity_type="user", entity_id=user.id,
                  metadata={"previously_set": had})  # the number itself is never audited
    await db.commit()
    return await get_user_view(db, user_id, can_see_mobile(actor))


async def set_username(db: AsyncSession, *, actor: Principal, user_id: int, username: str, reason: str | None,
                       note: str | None) -> dict:
    new = canonical_username(username)
    user = await _user(db, user_id, lock=True)
    if user.username is None:
        raise DomainError("user_has_no_profile", 409)
    if user.username == new:
        return await get_user_view(db, user_id, can_see_mobile(actor))
    why, why_note = _reason(reason, note, USERNAME_REASONS)
    if (await db.execute(select(User.id).where(User.username == new, User.id != user.id))).first():
        raise DomainError("username_taken", 409)
    old, user.username = user.username, new  # tokens carry the user id, so open sessions stay valid
    await _flush_or_conflict(db)
    add_audit(db, actor_id=actor.user_id, action="user.username_change", entity_type="user", entity_id=user.id,
              metadata={"from": old, "to": new, "reason": why, "note": why_note})
    await db.commit()
    return await get_user_view(db, user_id, can_see_mobile(actor))


async def set_login_enabled(db: AsyncSession, *, actor: Principal, user_id: int, enabled: bool) -> dict:
    """Switch a profile off (sessions are revoked at once) or back on. The person and his history stay."""
    if not enabled:
        if user_id == actor.user_id:
            raise DomainError("cannot_deactivate_self", 409)
        await _lock_management(db)
    user = await _user(db, user_id, lock=True)
    if user.username is None:
        raise DomainError("user_has_no_profile", 409)
    if enabled and not user.is_active:
        raise DomainError("person_inactive", 409)
    if user.login_enabled != enabled:
        user.login_enabled = enabled
        # Both directions: disabling ends the sessions; enabling also revokes, so a refresh token that a sign-in
        # created while the switch was being turned off can never come back to life (review finding on PR #19).
        await revoke_all_user_tokens(db, user.id)
        if not enabled:
            await _assert_management_remains(db)
        add_audit(db, actor_id=actor.user_id, action="user.login_enable" if enabled else "user.login_disable",
                  entity_type="user", entity_id=user.id)
    await db.commit()
    return await get_user_view(db, user_id, can_see_mobile(actor))


# ---------------------------------------------------------------- «users without a group» alert

async def _no_group_count(db: AsyncSession) -> int:
    """Active people with no group membership. MANAGEMENT and AUDITOR are organisation-wide, so they are excluded."""
    org_wide = select(Role.id).where(Role.code.in_((MANAGEMENT, "AUDITOR")))
    stmt = (select(func.count()).select_from(User)
            .where(User.is_active.is_(True), User.id.not_in(select(UserGroup.user_id)),
                   (User.role_id.is_(None)) | (User.role_id.not_in(org_wide))))
    return (await db.execute(stmt)).scalar_one()


async def no_group_alert(db: AsyncSession, *, actor: Principal) -> dict:
    """{count, show}. `show` is true while there are people without a group and the manager has not dismissed the alert
    at this count or a larger one. If the count has fallen below the dismissed value the dismissal follows it down,
    so people who become group-less later bring the alert back."""
    count = await _no_group_count(db)
    me = await _user(db, actor.user_id, lock=True)
    dismissed = me.no_group_alert_dismissed_count
    if dismissed is not None and count < dismissed:
        me.no_group_alert_dismissed_count = dismissed = count
        await db.commit()
    else:
        await db.rollback()  # release the row lock; nothing changed
    return {"count": count, "show": count > 0 and (dismissed is None or count > dismissed)}


async def dismiss_no_group_alert(db: AsyncSession, *, actor: Principal) -> dict:
    count = await _no_group_count(db)
    me = await _user(db, actor.user_id, lock=True)
    me.no_group_alert_dismissed_count = count
    await db.commit()
    return {"count": count, "show": False}
