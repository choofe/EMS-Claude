"""Personnel import history and cancel (phase-personnel, Pg).

There is no separate undo button: a manager opens the history, looks at a batch and cancels it from there. A cancel
removes (hard delete) every person of the batch who is still UNUSED and keeps everybody who has a reference; it can be
repeated later for the people who were kept. It is the Master Prompt's «import-undo» exception to «never hard-delete
history»: only rows that were created by that very batch and that nothing refers to are ever deleted.

References that keep a person (a person is created without a profile, but may get any of these afterwards):
a login profile, reports he created, participation in a report (labor rows), a star given or received.
The batch row is never deleted; every cancel is audited with counts only (never names, codes or mobile numbers).
"""
import hashlib
from datetime import datetime, timezone

from sqlalchemy import delete, exists, func, select
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import DomainError
from app.models import (
    FavoritePerson, Group, PersonnelImportBatch, Report, ReportParticipant, User, UserGroup,
)
from app.services.audit import add_audit

_CHUNK = 400  # keeps IN lists far below the SQLite variable limit

# Persian wording of the problem codes for the CSV report (the UI maps the same codes itself).
PROBLEM_FA = {
    "formula_not_allowed": "سلول شامل فرمول است و پذیرفته نمی‌شود",
    "date_cell": "سلول تاریخ است؛ مقدار باید متن یا عدد باشد",
    "missing_first_name": "نام وارد نشده است",
    "missing_last_name": "نام خانوادگی وارد نشده است",
    "missing_personnel_code": "کد پرسنلی وارد نشده است",
    "missing_mobile": "شماره موبایل وارد نشده است",
    "invalid_first_name": "نام نامعتبر است",
    "invalid_last_name": "نام خانوادگی نامعتبر است",
    "invalid_full_name": "نام و نام خانوادگی بیش از حد طولانی است",
    "invalid_personnel_code": "کد پرسنلی نامعتبر است (عدد ۱ تا ۹۹۹۹ بدون صفر ابتدایی)",
    "invalid_mobile": "شماره موبایل نامعتبر است",
    "too_many_groups": "تعداد گروه‌های یک سلول از حد مجاز بیشتر است",
    "personnel_code_taken": "این کد پرسنلی از قبل در سیستم وجود دارد",
    "mobile_taken": "این شماره موبایل از قبل در سیستم وجود دارد",
    "duplicate_personnel_code_in_file": "کد پرسنلی در ردیف دیگری از همین فایل تکرار شده است",
    "duplicate_mobile_in_file": "شماره موبایل در ردیف دیگری از همین فایل تکرار شده است",
    "group_malformed": "کد گروه نامعتبر است",
    "group_unknown": "کد گروه در سیستم وجود ندارد",
    "group_inactive": "گروه غیرفعال است",
}


def status_of(batch: PersonnelImportBatch, remaining: int) -> str:
    """complete = nobody removed yet; cancelled = nobody left; partial = in between."""
    if batch.removed_count == 0:
        return "complete"
    return "cancelled" if remaining == 0 else "partial"


async def _remaining(db: AsyncSession, batch_ids: list[int]) -> dict[int, int]:
    out = {i: 0 for i in batch_ids}
    if batch_ids:
        rows = (await db.execute(select(User.import_batch_id, func.count(User.id))
                                 .where(User.import_batch_id.in_(batch_ids)).group_by(User.import_batch_id))).all()
        out.update({b: n for b, n in rows})
    return out


async def list_batches(db: AsyncSession, *, limit: int, offset: int) -> tuple[list[dict], int]:
    total = (await db.execute(select(func.count(PersonnelImportBatch.id)))).scalar_one()
    rows = (await db.execute(
        select(PersonnelImportBatch, User.full_name).join(User, User.id == PersonnelImportBatch.created_by)
        .order_by(PersonnelImportBatch.id.desc()).limit(limit).offset(offset))).all()
    remaining = await _remaining(db, [b.id for b, _ in rows])
    items = [{
        "id": b.id, "kind": b.kind, "file_name": b.file_name, "created_at": b.created_at, "created_by_name": name,
        "created_count": b.created_count, "rejected_count": b.rejected_count, "removed_count": b.removed_count,
        "remaining_count": remaining[b.id], "status": status_of(b, remaining[b.id]), "undone_at": b.undone_at,
    } for b, name in rows]
    return items, total


async def _batch(db: AsyncSession, batch_id: int, *, lock: bool = False) -> PersonnelImportBatch:
    q = select(PersonnelImportBatch).where(PersonnelImportBatch.id == batch_id)
    if lock:
        q = q.with_for_update().execution_options(populate_existing=True)
    batch = (await db.execute(q)).scalar_one_or_none()
    if batch is None:
        raise DomainError("import_batch_not_found", 404)
    return batch


async def batch_people(db: AsyncSession, *, batch_id: int, limit: int, offset: int, with_mobile: bool) -> tuple[list[dict], int]:
    """The people of the batch who still exist, with their CURRENT data (not the data of the import day)."""
    await _batch(db, batch_id)
    total = (await db.execute(select(func.count(User.id)).where(User.import_batch_id == batch_id))).scalar_one()
    users = (await db.execute(select(User).where(User.import_batch_id == batch_id)
                              .order_by(User.personnel_code, User.id).limit(limit).offset(offset))).scalars().all()
    codes: dict[int, list[str]] = {u.id: [] for u in users}
    if users:
        for uid, code in (await db.execute(select(UserGroup.user_id, Group.code).join(Group, Group.id == UserGroup.group_id)
                                           .where(UserGroup.user_id.in_(list(codes))).order_by(Group.code))).all():
            codes[uid].append(code)
    items = [{"id": u.id, "first_name": u.first_name, "last_name": u.last_name, "full_name": u.full_name,
              "personnel_code": u.personnel_code, "group_codes": codes[u.id], "is_active": u.is_active,
              "has_profile": u.username is not None, "mobile": u.mobile if with_mobile else None} for u in users]
    return items, total


async def _classify(db: AsyncSession, batch_id: int, *, lock: bool) -> tuple[list[int], dict]:
    """(removable ids in ascending order, counts). With lock=True the batch's people are locked FOR UPDATE first
    (in id order, so two cancels cannot deadlock) and a concurrent insert that refers to one of them waits."""
    q = select(User.id, User.username).where(User.import_batch_id == batch_id).order_by(User.id)
    if lock:
        q = q.with_for_update(of=User)
    people = (await db.execute(q)).all()
    ids = [i for i, _ in people]
    used = {"profile": {i for i, name in people if name is not None}, "reports": set(), "participation": set(), "stars": set()}
    for start in range(0, len(ids), _CHUNK):
        part = ids[start:start + _CHUNK]
        used["reports"] |= set((await db.execute(select(Report.created_by).where(Report.created_by.in_(part)))).scalars())
        used["participation"] |= set((await db.execute(
            select(ReportParticipant.user_id).where(ReportParticipant.user_id.in_(part)))).scalars())
        used["stars"] |= set((await db.execute(select(FavoritePerson.owner_id).where(FavoritePerson.owner_id.in_(part)))).scalars())
        used["stars"] |= set((await db.execute(
            select(FavoritePerson.favorite_user_id).where(FavoritePerson.favorite_user_id.in_(part)))).scalars())
    exempt = set().union(*used.values())
    removable = [i for i in ids if i not in exempt]
    counts = {"remaining_count": len(ids), "removable_count": len(removable), "exempt_count": len(exempt),
              "exempt_reasons": {k: len(v) for k, v in used.items()}}  # a person may appear under several reasons
    return removable, counts


def fingerprint(batch_id: int, removable: list[int]) -> str:
    return hashlib.sha256(f"{batch_id}:{','.join(map(str, removable))}".encode()).hexdigest()


async def cancel_preview(db: AsyncSession, *, batch_id: int) -> dict:
    """Writes nothing: how many people a cancel would remove now and how many it would keep, plus the fingerprint
    the confirmation must send back."""
    await _batch(db, batch_id)
    removable, counts = await _classify(db, batch_id, lock=False)
    return {"batch_id": batch_id, **counts, "fingerprint": fingerprint(batch_id, removable)}


async def cancel_confirm(db: AsyncSession, *, actor_id: int, batch_id: int, expected_fingerprint: str) -> dict:
    batch = await _batch(db, batch_id, lock=True)
    removable, counts = await _classify(db, batch_id, lock=True)
    if fingerprint(batch_id, removable) != (expected_fingerprint or "").strip().lower():
        await db.rollback()
        raise DomainError("batch_changed", 409, **counts)  # nothing is deleted and nothing is re-run on its own
    if not removable:
        await db.rollback()
        raise DomainError("nothing_to_cancel", 409, **counts)
    try:
        for start in range(0, len(removable), _CHUNK):
            part = removable[start:start + _CHUNK]
            await db.execute(delete(UserGroup).where(UserGroup.user_id.in_(part)))
            await db.execute(delete(User).where(User.id.in_(part)))
        batch.removed_count += len(removable)
        batch.undone_at = datetime.now(timezone.utc)
        batch.undone_by = actor_id
        add_audit(db, actor_id=actor_id, action="personnel.import_cancel", entity_type="personnel_import_batch",
                  entity_id=batch.id, metadata={"removed": len(removable), "kept": counts["exempt_count"],
                                                "remaining_before": counts["remaining_count"]})
        await db.commit()
    except (IntegrityError, DBAPIError):  # a reference appeared at the last moment: the FK is the last line of defence
        await db.rollback()
        raise DomainError("batch_changed", 409) from None
    return {"batch_id": batch_id, "removed_count": len(removable), "kept_count": counts["exempt_count"]}


def problem_rows(report: dict) -> list[list]:
    """Rows of the CSV problem report from an analysed (and corrected) report: row, personnel code as typed (at most
    16 characters), problem code, Persian description. Never a mobile number or the owner of a duplicate."""
    rows = [[e["row"], e["personnel_code"], e["code"], PROBLEM_FA.get(e["code"], e["code"])] for e in report["errors"]]
    for g in report["group_issues"]:
        for bad in g["invalid_groups"]:
            code = f"group_{bad['reason']}"
            rows.append([g["row"], str(g["personnel_code"]), code, f"{PROBLEM_FA.get(code, code)}: {bad['token']}"])
    return sorted(rows, key=lambda r: (r[0], r[2]))


def csv_cell(value) -> str:
    """Spreadsheet-safe text: a cell that a spreadsheet could read as a formula is prefixed with an apostrophe."""
    text = str(value)
    return "'" + text if text[:1] in ("=", "+", "-", "@", "\t", "\r") else text


def build_problem_csv(report: dict) -> bytes:
    import csv
    import io
    buf = io.StringIO(newline="")
    writer = csv.writer(buf, lineterminator="\r\n")
    writer.writerow(["row", "personnel_code", "problem_code", "description_fa"])
    for row in problem_rows(report):
        writer.writerow([csv_cell(c) for c in row])
    return ("\ufeff" + buf.getvalue()).encode("utf-8")
