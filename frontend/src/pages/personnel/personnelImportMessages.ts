import { ApiError } from "../../api/http";
import type { InvalidGroupReason, PersonnelRowError } from "../../api/types";
import { errorMessage } from "../../i18n/messages";
import { toPersianDigits } from "../../lib/dates";

const fa = (n: number) => toPersianDigits(String(n));

/** Persian text of a rejected row. Mirrors PROBLEM_FA of the backend CSV report (services/personnel_import_history.py). */
export function personnelRowReason(e: PersonnelRowError): string {
  switch (e.code) {
    case "formula_not_allowed": return `سلول${e.column ? ` «${e.column}»` : ""} شامل فرمول است و پذیرفته نمی‌شود`;
    case "date_cell": return `سلول${e.column ? ` «${e.column}»` : ""} تاریخ است؛ ستون را با قالب «متن» (Text) بسازید`;
    case "missing_first_name": return "نام وارد نشده است";
    case "missing_last_name": return "نام خانوادگی وارد نشده است";
    case "missing_personnel_code": return "کد پرسنلی وارد نشده است";
    case "missing_mobile": return "شماره موبایل وارد نشده است";
    case "invalid_first_name": return "نام نامعتبر است";
    case "invalid_last_name": return "نام خانوادگی نامعتبر است";
    case "invalid_full_name": return "نام و نام خانوادگی بیش از حد طولانی است";
    case "invalid_personnel_code": return "کد پرسنلی نامعتبر است (عدد ۱ تا ۹۹۹۹ بدون صفر ابتدایی)";
    case "invalid_mobile": return "شماره موبایل نامعتبر است";
    case "too_many_groups": return `تعداد گروه‌های یک سلول از حد مجاز${e.max_groups ? ` (${fa(e.max_groups)})` : ""} بیشتر است`;
    case "personnel_code_taken": return "این کد پرسنلی از قبل در سیستم وجود دارد";
    case "mobile_taken": return "این شماره موبایل از قبل در سیستم وجود دارد";
    default: return e.code;
  }
}

export function groupReason(r: InvalidGroupReason): string {
  return r === "unknown" ? "گروهی با این کد وجود ندارد" : r === "inactive" ? "گروه غیرفعال است" : "کد گروه نامعتبر است";
}

/** Page-level texts of the personnel import. They differ from the equipment import's texts of the same codes. */
const OVERRIDES: Record<string, string> = {
  correction_group_invalid: "برخی کد گروه‌ها دیگر وجود ندارند. گروه‌ها را بررسی کنید و دوباره وارد کنید.",
  import_conflict: "در فاصلهٔ پیش‌نمایش و ثبت، کد پرسنلی، موبایل یا گروهی تغییر کرده است. هیچ‌کس وارد نشد. فایل را دوباره بارگذاری کنید.",
  file_conflicts_unresolved: "ردیف‌هایی با کد یا موبایل مشترک هنوز تعیین‌تکلیف نشده‌اند. هیچ‌کس وارد نشد. فایل را دوباره بارگذاری کنید.",
  group_issues_unresolved: "وضعیت گروه‌ها پس از پیش‌نمایش تغییر کرده است. هیچ‌کس وارد نشد. فایل را دوباره بارگذاری کنید.",
  file_changed: "فایل با پیش‌نمایش تفاوت دارد. دوباره بارگذاری کنید.",
  nothing_to_import: "ردیف قابل ورودی باقی نمانده است.",
  correction_row_not_found: "اصلاحات نامعتبر است. پیش‌نمایش را دوباره بسازید.",
  correction_token_not_found: "اصلاحات نامعتبر است. پیش‌نمایش را دوباره بسازید.",
  duplicate_correction: "اصلاحات نامعتبر است. پیش‌نمایش را دوباره بسازید.",
  invalid_corrections: "تعداد یا حجم اصلاحات از حد مجاز بیشتر است. برخی ردیف‌ها را کنار بگذارید یا فایل را اصلاح کنید.",
};

export function personnelErrorMessage(err: unknown): string {
  if (err instanceof ApiError && OVERRIDES[err.code]) return OVERRIDES[err.code];
  return errorMessage(err);
}

/** After these answers nothing was imported and the preview no longer matches reality: the manager starts over.
 *  `invalid_corrections` (too many or too large) is NOT here: the manager keeps the file and the decisions. */
export const RESTART_CODES = new Set(["import_conflict", "correction_group_invalid", "file_changed", "nothing_to_import",
  "correction_row_not_found", "correction_token_not_found", "duplicate_correction", "group_issues_unresolved", "file_conflicts_unresolved"]);

/** CSV of the rows that were NOT imported, built from the commit answer (the file is never re-analysed after the
 *  people exist: the database would then report them as already taken). Spreadsheet-safe cells; no mobile numbers. */
export function importedProblemsCsv(errors: PersonnelRowError[]): Blob {
  const cell = (v: string | number) => { const t = String(v); const x = /^[=+\-@\t\r]/.test(t) ? `'${t}` : t; return `"${x.replace(/"/g, '""')}"`; };
  const lines = ["row,first_name,last_name,personnel_code,problem_code,description_fa",
    ...errors.map((e) => [e.row, e.first_name ?? "", e.last_name ?? "", e.personnel_code, e.code, personnelRowReason(e)].map(cell).join(","))];
  return new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
}
