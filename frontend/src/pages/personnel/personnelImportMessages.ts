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
    case "duplicate_personnel_code_in_file": return `کد پرسنلی در ردیف دیگری از همین فایل تکرار شده است${e.first_row ? ` (ردیف ${fa(e.first_row)})` : ""}`;
    case "duplicate_mobile_in_file": return `شماره موبایل در ردیف دیگری از همین فایل تکرار شده است${e.first_row ? ` (ردیف ${fa(e.first_row)})` : ""}`;
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
  group_issues_unresolved: "ردیف تعیین‌تکلیف‌نشده دارید.",
  file_changed: "فایل با پیش‌نمایش تفاوت دارد. دوباره بارگذاری کنید.",
  nothing_to_import: "ردیف قابل ورودی باقی نمانده است.",
  correction_row_not_found: "اصلاحات نامعتبر است. پیش‌نمایش را دوباره بسازید.",
  correction_token_not_found: "اصلاحات نامعتبر است. پیش‌نمایش را دوباره بسازید.",
  duplicate_correction: "اصلاحات نامعتبر است. پیش‌نمایش را دوباره بسازید.",
  invalid_corrections: "اصلاحات نامعتبر است. پیش‌نمایش را دوباره بسازید.",
};

export function personnelErrorMessage(err: unknown): string {
  if (err instanceof ApiError && OVERRIDES[err.code]) return OVERRIDES[err.code];
  return errorMessage(err);
}

/** After these answers nothing was imported and the preview no longer matches reality: the manager starts over. */
export const RESTART_CODES = new Set(["import_conflict", "correction_group_invalid", "file_changed", "nothing_to_import",
  "correction_row_not_found", "correction_token_not_found", "duplicate_correction", "invalid_corrections"]);
