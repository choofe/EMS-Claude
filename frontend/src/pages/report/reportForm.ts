/**
 * Pure logic of the report entry form (no React, fully unit-tested): state shape, which sections a report type
 * shows, client-side validation, and the conversions to/from the API bodies. The client check is a convenience
 * (fast messages); the server re-validates every rule (docs/report-creation.md) and is the authority.
 *
 * Labor and equipment follow ONE rule set per report type (2026-10-22):
 *   REQUIRED - always shown and mandatory; OPTIONAL - hidden until the author asks for it (button), then shown;
 *   NONE - not available at all. Data the author already entered stays in memory when the type changes, but the NEW type
 *   decides what is shown and what is sent — hidden data is never sent (and the author is told it is hidden).
 */
import type { DraftPayload, EntryConfig, Mode, ReportCreateBody, ReportType } from "../../api/types";
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
  laborOpened: boolean; // OPTIONAL labor: the author pressed «اضافه کردن ساعات افراد - اختیاری»
  equipmentOpened: boolean; // OPTIONAL equipment: the author pressed «افزودن تجهیز - اختیاری»
  authorRemoved: boolean; // the author's own row was deleted from the labor list (drives the warning)
}

export type IssueField = "type" | "equipment" | "group" | "datetime" | "description" | "labor";
export interface Issue { field: IssueField; message: string }

let rowSeq = 0;
export const newRowKey = () => `row-${++rowSeq}`;

export function emptyState(now: Date = new Date()): FormState {
  return {
    equipment: null, groupId: "", typeId: "", ...textsFromDate(now), description: "", labor: [],
    laborOpened: false, equipmentOpened: false, authorRemoved: false,
  };
}

export const laborMode = (t: ReportType | undefined): Mode => t?.labor_mode ?? "REQUIRED";
export const equipmentMode = (t: ReportType | undefined): Mode => t?.equipment_mode ?? "REQUIRED";

/** Is the labor section on screen? */
export function laborVisible(t: ReportType | undefined, s: FormState): boolean {
  if (!t) return false;
  const mode = laborMode(t);
  return mode === "REQUIRED" || (mode === "OPTIONAL" && s.laborOpened);
}

export function equipmentVisible(t: ReportType | undefined, s: FormState): boolean {
  if (!t) return false;
  const mode = equipmentMode(t);
  return mode === "REQUIRED" || (mode === "OPTIONAL" && s.equipmentOpened);
}

/** The equipment that will actually be sent: the selected one, but only while the type shows the equipment field. */
export const effectiveEquipment = (t: ReportType | undefined, s: FormState) => (equipmentVisible(t, s) ? s.equipment : null);

/** A general report (no equipment sent) needs an explicit group. */
export const needsGroup = (t: ReportType | undefined, s: FormState) => !!t && equipmentMode(t) !== "REQUIRED" && !effectiveEquipment(t, s);

/** Context for "who may be listed": the equipment's group, or the explicit group of a general report. */
export function participantContext(t: ReportType | undefined, s: FormState): { equipment_id?: number; group_id?: number } | null {
  const eq = effectiveEquipment(t, s);
  if (eq) return { equipment_id: eq.id };
  return needsGroup(t, s) && s.groupId !== "" ? { group_id: s.groupId } : null;
}

export const rowMinutes = (r: LaborRow) => toMinutes(r.hours, r.minutes);

export function authorRow(author: { id: number; full_name: string }, minutes: number): LaborRow {
  return { key: newRowKey(), userId: author.id, name: author.full_name, ...splitMinutes(minutes) };
}

/**
 * Called when the type changes or the labor section opens: a visible, empty labor section starts with the author and
 * the default minutes pre-filled, unless the author removed themselves on purpose. This is only a pre-fill the author
 * sees and can edit — the server never invents labor.
 */
export function withDefaultLabor(s: FormState, t: ReportType | undefined, author: { id: number; full_name: string }, defaultMinutes: number): FormState {
  if (!laborVisible(t, s) || s.labor.length > 0 || s.authorRemoved) return s;
  return { ...s, labor: [authorRow(author, defaultMinutes)] };
}

/** What the NEW type hides of what the author already entered and could see (shown to them, never silently dropped or sent). */
export function hiddenByTypeChange(prev: ReportType | undefined, next: ReportType | undefined, s: FormState): string[] {
  const out: string[] = [];
  if (s.labor.some((r) => r.userId !== null) && laborVisible(prev, s) && !laborVisible(next, s)) {
    out.push(laborMode(next) === "NONE"
      ? "این نوع گزارش ساعت کار ندارد؛ ساعت‌های واردشده ارسال نمی‌شود."
      : "ساعت‌های واردشده در این نوع نمایش داده نمی‌شود و ارسال نخواهد شد؛ با «اضافه کردن ساعات افراد» یا بازگشت به نوع قبلی برمی‌گردد.");
  }
  if (s.equipment && equipmentVisible(prev, s) && !equipmentVisible(next, s)) {
    out.push(equipmentMode(next) === "NONE"
      ? "این نوع گزارش تجهیز ندارد؛ تجهیز انتخاب‌شده ارسال نمی‌شود."
      : "تجهیز انتخاب‌شده در این نوع نمایش داده نمی‌شود و ارسال نخواهد شد؛ با «افزودن تجهیز» یا بازگشت به نوع قبلی برمی‌گردد.");
  }
  return out;
}

export function validate(s: FormState, t: ReportType | undefined, cfg: EntryConfig, now: Date = new Date()): Issue[] {
  const issues: Issue[] = [];
  if (!t) issues.push({ field: "type", message: "نوع گزارش را انتخاب کنید." });

  if (t) {
    if (equipmentMode(t) === "REQUIRED" && !s.equipment) issues.push({ field: "equipment", message: "تجهیز را انتخاب کنید." });
    if (needsGroup(t, s) && s.groupId === "") issues.push({ field: "group", message: "گروه را انتخاب کنید." });
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
export function buildCreateBody(s: FormState, t: ReportType, draftId: number | null, clientRequestId?: string): ReportCreateBody {
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
  const eq = effectiveEquipment(t, s);
  if (eq) body.equipment_id = eq.id;
  else if (s.groupId !== "") body.group_id = s.groupId;
  if (draftId !== null) body.draft_id = draftId;
  if (clientRequestId) body.client_request_id = clientRequestId;
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
    participants: s.labor.map((r) => ({ user_id: r.userId, name: r.name || null, minutes: Math.min(Math.max(rowMinutes(r) ?? 0, 0), MAX_MINUTES) })),
  };
}

/** A draft with nothing in it is not worth a server row (the clock-defaulted date alone does not count). */
export function isBlank(s: FormState): boolean {
  // groupId is deliberately ignored: it is auto-selected when the user has a single group
  return !s.equipment && s.typeId === "" && !s.description.trim() && s.labor.length === 0;
}

/**
 * Draft -> form. Ids in a draft are untrusted: equipment is re-resolved by the caller (it may have been moved or
 * deactivated since). Names come from the server lookup when possible, else from the name remembered in the draft
 * (display only; submit sends ids), else a placeholder.
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
      key: newRowKey(), userId: x.user_id, name: x.user_id !== null ? resolve.names[x.user_id] ?? x.name ?? `کاربر ${x.user_id}` : "",
      ...(x.minutes > 0 ? splitMinutes(x.minutes) : { hours: "", minutes: "" }),
    })),
    laborOpened: (p.participants ?? []).length > 0,
    equipmentOpened: resolve.equipment !== null,
  };
}
