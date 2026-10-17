/**
 * Pure logic of the report entry form (no React, fully unit-tested): state shape, which sections a report type
 * shows, client-side validation, and the conversions to/from the API bodies. The client check is a convenience
 * (fast messages); the server re-validates every rule (docs/report-creation.md) and is the authority.
 */
import type { DraftPayload, EntryConfig, LaborMode, ReportCreateBody, ReportType } from "../../api/types";
import { dateTimeFromTexts, textsFromDate } from "../../lib/jalali";
import { MAX_MINUTES, splitMinutes, toMinutes } from "../../lib/labor";

export interface EquipmentOption { id: number; equipment_code: string; group_id: number; group_code: string; description: string | null }
export interface LaborRow { key: string; userId: number | null; name: string; hours: string; minutes: string }

export interface FormState {
  equipment: EquipmentOption | null;
  groupId: number | "";
  typeId: number | "";
  dateText: string;
  timeText: string;
  description: string;
  labor: LaborRow[];
  laborOpened: boolean; // ON_REQUEST: the author pressed «اضافه کردن ساعات افراد - اختیاری»
  authorRemoved: boolean; // the author's own row was deleted from the labor list (drives the warning)
}

export type IssueField = "type" | "equipment" | "group" | "datetime" | "description" | "labor";
export interface Issue { field: IssueField; message: string }

let rowSeq = 0;
export const newRowKey = () => `row-${++rowSeq}`;

export function emptyState(now: Date = new Date()): FormState {
  return { equipment: null, groupId: "", typeId: "", ...textsFromDate(now), description: "", labor: [], laborOpened: false, authorRemoved: false };
}

export const laborMode = (t: ReportType | undefined): LaborMode => t?.labor_mode ?? "REQUIRED";

/** Is the labor section on screen? NONE never; ON_REQUEST only after the button; REQUIRED/OPTIONAL always. */
export function laborVisible(t: ReportType | undefined, s: FormState): boolean {
  const mode = laborMode(t);
  if (!t || mode === "NONE") return false;
  return mode === "ON_REQUEST" ? s.laborOpened : true;
}

export const rowMinutes = (r: LaborRow) => toMinutes(r.hours, r.minutes);

export function authorRow(author: { id: number; full_name: string }, minutes: number): LaborRow {
  return { key: newRowKey(), userId: author.id, name: author.full_name, ...splitMinutes(minutes) };
}

/**
 * Called when the type changes or the labor section opens: REQUIRED (and an opened ON_REQUEST section) start with the
 * author and the default minutes pre-filled, unless the user already has rows or removed the author on purpose.
 * This is only a pre-fill the author sees and can edit — the server never invents labor.
 */
export function withDefaultLabor(s: FormState, t: ReportType | undefined, author: { id: number; full_name: string }, defaultMinutes: number): FormState {
  if (!laborVisible(t, s) || s.labor.length > 0 || s.authorRemoved) return s;
  if (laborMode(t) === "OPTIONAL") return s;
  return { ...s, labor: [authorRow(author, defaultMinutes)] };
}

export function validate(s: FormState, t: ReportType | undefined, cfg: EntryConfig, now: Date = new Date()): Issue[] {
  const issues: Issue[] = [];
  if (!t) issues.push({ field: "type", message: "نوع گزارش را انتخاب کنید." });

  if (t) {
    if (!s.equipment && t.equipment_required) issues.push({ field: "equipment", message: "تجهیز را انتخاب کنید." });
    if (!s.equipment && !t.equipment_required && s.groupId === "") issues.push({ field: "group", message: "گروه را انتخاب کنید." });
  }

  const when = dateTimeFromTexts(s.dateText, s.timeText);
  if (!when) issues.push({ field: "datetime", message: "تاریخ (مثلاً ۱۴۰۵/۰۷/۲۵) و ساعت (مثلاً ۱۴:۳۰) را درست وارد کنید." });
  else if (when.getTime() > now.getTime() + cfg.future_tolerance_minutes * 60_000) issues.push({ field: "datetime", message: "زمان رویداد نمی‌تواند در آینده باشد." });

  const desc = s.description.trim();
  if (!desc) issues.push({ field: "description", message: "توضیحات را بنویسید." });
  else if (desc.length > cfg.max_description_length) issues.push({ field: "description", message: "توضیحات بیش از حد مجاز طولانی است." });

  if (t && laborVisible(t, s)) {
    const named = s.labor.filter((r) => r.userId !== null);
    const seen = new Set<number>();
    for (const r of s.labor) {
      if (r.userId === null) { issues.push({ field: "labor", message: "برای یکی از ردیف‌های ساعت، فرد انتخاب نشده است." }); break; }
    }
    for (const r of named) {
      const m = rowMinutes(r);
      if (m === null || m < 1) issues.push({ field: "labor", message: `ساعت کار «${r.name}» باید عددی صحیح و بیشتر از صفر باشد.` });
      else if (m > cfg.max_participant_minutes) issues.push({ field: "labor", message: `ساعت کار «${r.name}» بیش از ۲۴ ساعت است.` });
      if (seen.has(r.userId!)) issues.push({ field: "labor", message: `«${r.name}» بیش از یک بار در فهرست آمده است.` });
      seen.add(r.userId!);
    }
    if (laborMode(t) === "REQUIRED" && named.length === 0) {
      issues.push({ field: "labor", message: "ساعت کاری وارد نشده است. تا ثبت ساعت و حداقل یک نفر، گزارش ثبت نمی‌شود." });
    }
    if (named.length > cfg.max_participants) issues.push({ field: "labor", message: "تعداد افراد از حد مجاز بیشتر است." });
  }
  return issues;
}

/** Body for POST /reports. Throws if called with an invalid form (call validate first). */
export function buildCreateBody(s: FormState, t: ReportType, draftId: number | null): ReportCreateBody {
  const when = dateTimeFromTexts(s.dateText, s.timeText);
  if (!when || s.typeId === "") throw new Error("invalid form");
  const body: ReportCreateBody = {
    report_type_id: s.typeId,
    event_datetime: when.toISOString(),
    description: s.description,
    participants: laborVisible(t, s)
      ? s.labor.filter((r) => r.userId !== null).map((r) => ({ user_id: r.userId!, minutes: rowMinutes(r)! }))
      : [],
  };
  if (s.equipment) body.equipment_id = s.equipment.id;
  else if (s.groupId !== "") body.group_id = s.groupId;
  if (draftId !== null) body.draft_id = draftId;
  return body;
}

export function toDraftPayload(s: FormState): DraftPayload {
  const when = dateTimeFromTexts(s.dateText, s.timeText);
  return {
    equipment_id: s.equipment?.id ?? null,
    group_id: s.equipment ? null : s.groupId === "" ? null : s.groupId,
    report_type_id: s.typeId === "" ? null : s.typeId,
    event_datetime: when ? when.toISOString() : null,
    description: s.description || null,
    participants: s.labor.map((r) => ({ user_id: r.userId, minutes: Math.min(Math.max(rowMinutes(r) ?? 0, 0), MAX_MINUTES) })),
  };
}

/** A draft with nothing in it is not worth a server row (the clock-defaulted date alone does not count). */
export function isBlank(s: FormState): boolean {
  // groupId is deliberately ignored: it is auto-selected when the user has a single group
  return !s.equipment && s.typeId === "" && !s.description.trim() && s.labor.length === 0;
}

/**
 * Draft -> form. Ids in a draft are untrusted: equipment is re-resolved by the caller (it may have been moved or
 * deactivated since), and names of participants are looked up the same way, so unknown ones are dropped upstream.
 */
export function fromDraftPayload(p: DraftPayload, resolve: { equipment: EquipmentOption | null; names: Record<number, string> }, now: Date = new Date()): FormState {
  const base = emptyState(p.event_datetime ? new Date(p.event_datetime) : now);
  return {
    ...base,
    equipment: resolve.equipment,
    groupId: resolve.equipment ? "" : p.group_id ?? "",
    typeId: p.report_type_id ?? "",
    description: p.description ?? "",
    labor: (p.participants ?? []).map((x) => ({
      key: newRowKey(), userId: x.user_id, name: x.user_id !== null ? resolve.names[x.user_id] ?? `کاربر ${x.user_id}` : "",
      ...(x.minutes > 0 ? splitMinutes(x.minutes) : { hours: "", minutes: "" }),
    })),
    laborOpened: (p.participants ?? []).length > 0,
  };
}
