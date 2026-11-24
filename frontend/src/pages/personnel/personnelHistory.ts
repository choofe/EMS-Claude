import type { PersonnelBatchPerson, PersonnelCancelPreview, PersonnelImportBatch } from "../../api/types";
import { toPersianDigits } from "../../lib/dates";

const fa = (n: number) => toPersianDigits(String(n));

/** Rows imported out of the rows of the file (created + rejected = every row: a commit is refused while a group issue or a conflict is left). */
export function importedOfTotal(b: Pick<PersonnelImportBatch, "created_count" | "rejected_count">): string {
  return `${fa(b.created_count)} از ${fa(b.created_count + b.rejected_count)}`;
}

/** Every batch has an explicit status. */
export function statusLabel(status: PersonnelImportBatch["status"]): string {
  return status === "partial" ? "بخشی لغو شده" : status === "cancelled" ? "کامل لغو شده" : "بدون لغو";
}

/** The server computes `remaining_count` live; a cancel is possible again for the people who were kept. */
export function canCancel(b: Pick<PersonnelImportBatch, "remaining_count">): boolean {
  return b.remaining_count > 0;
}

/** People kept by each reason (one person may be counted under several), only the non-zero ones. */
export function exemptLines(r: PersonnelCancelPreview["exempt_reasons"]): string[] {
  const out: string[] = [];
  if (r.profile > 0) out.push(`${fa(r.profile)} نفر پروفایل ورود دارند`);
  if (r.reports > 0) out.push(`${fa(r.reports)} نفر گزارش ثبت کرده‌اند`);
  if (r.participation > 0) out.push(`${fa(r.participation)} نفر در گزارشی ساعت کار دارند`);
  if (r.stars > 0) out.push(`${fa(r.stars)} نفر ستاره‌دار شده‌اند یا ستاره زده‌اند`);
  return out;
}

/** «نام کامل (کد پرسنلی)»; a person without a code shows the name only. */
export function personName(p: Pick<PersonnelBatchPerson, "full_name" | "personnel_code">): string {
  return p.personnel_code === null ? p.full_name : `${p.full_name} (${fa(p.personnel_code)})`;
}

/** How many batches to reload after a cancel: everything already shown, within the server's page limit of 100. */
export const BATCH_PAGE = 25;
export const reloadSize = (shown: number): number => Math.min(100, Math.max(BATCH_PAGE, shown));
