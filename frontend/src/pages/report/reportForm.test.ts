import { describe, expect, it } from "vitest";
import type { EntryConfig, ReportType } from "../../api/types";
import { jalaliToDate } from "../../lib/jalali";
import { authorRow, buildCreateBody, emptyState, fromDraftPayload, isBlank, laborVisible, toDraftPayload, validate, withDefaultLabor, type FormState } from "./reportForm";

const cfg: EntryConfig = { default_labor_minutes: 30, max_participant_minutes: 1440, max_participants: 30, max_description_length: 5000, future_tolerance_minutes: 5, groups: [{ id: 1, code: "ELV", name: "آسانسور" }] };
const type = (o: Partial<ReportType> = {}): ReportType => ({ id: 5, code: "T", name_fa: "نوع", is_failure: false, labor_mode: "REQUIRED", equipment_required: true, is_active: true, created_at: "", updated_at: "", ...o });
const author = { id: 7, full_name: "علی" };
const NOW = jalaliToDate({ year: 1405, month: 7, day: 25, hour: 12, minute: 0 })!;
const equipment = { id: 9, equipment_code: "ELV-1", group_id: 1, group_code: "ELV", description: null };
const ok = (o: Partial<FormState> = {}): FormState => ({ ...emptyState(NOW), equipment, typeId: 5, description: "تعویض بلبرینگ", labor: [authorRow(author, 30)], ...o });
const fields = (s: FormState, t: ReportType) => validate(s, t, cfg, NOW).map((i) => i.field);

describe("which sections a type shows", () => {
  it("labor visibility by mode", () => {
    const s = emptyState(NOW);
    expect(laborVisible(type({ labor_mode: "REQUIRED" }), s)).toBe(true);
    expect(laborVisible(type({ labor_mode: "OPTIONAL" }), s)).toBe(true);
    expect(laborVisible(type({ labor_mode: "NONE" }), s)).toBe(false);
    expect(laborVisible(type({ labor_mode: "ON_REQUEST" }), s)).toBe(false);
    expect(laborVisible(type({ labor_mode: "ON_REQUEST" }), { ...s, laborOpened: true })).toBe(true);
    expect(laborVisible(undefined, s)).toBe(false);
  });
});

describe("default labor pre-fill", () => {
  it("REQUIRED pre-fills the author with the configured default minutes", () => {
    const s = withDefaultLabor(emptyState(NOW), type(), author, 45);
    expect(s.labor).toHaveLength(1);
    expect(s.labor[0]).toMatchObject({ userId: 7, name: "علی", hours: "0", minutes: "45" });
  });
  it("does not pre-fill OPTIONAL, NONE, a closed ON_REQUEST, or after the author removed themselves, or over existing rows", () => {
    for (const mode of ["OPTIONAL", "NONE", "ON_REQUEST"] as const) expect(withDefaultLabor(emptyState(NOW), type({ labor_mode: mode }), author, 30).labor).toEqual([]);
    expect(withDefaultLabor({ ...emptyState(NOW), authorRemoved: true }, type(), author, 30).labor).toEqual([]);
    const existing = ok();
    expect(withDefaultLabor(existing, type(), author, 30)).toBe(existing);
  });
  it("an opened ON_REQUEST section is pre-filled", () => {
    const s = withDefaultLabor({ ...emptyState(NOW), laborOpened: true }, type({ labor_mode: "ON_REQUEST" }), author, 30);
    expect(s.labor).toHaveLength(1);
  });
});

describe("validation", () => {
  it("accepts a complete form", () => expect(validate(ok(), type(), cfg, NOW)).toEqual([]));

  it("requires type, equipment, description", () => {
    expect(fields(ok({ typeId: "", description: "  " }), undefined as unknown as ReportType)).toEqual(["type", "description"]);
    expect(fields(ok({ equipment: null }), type())).toContain("equipment");
  });

  it("general types: equipment optional, group required without it", () => {
    const general = type({ equipment_required: false, labor_mode: "NONE" });
    expect(fields(ok({ equipment: null, labor: [] }), general)).toEqual(["group"]);
    expect(fields(ok({ equipment: null, groupId: 1, labor: [] }), general)).toEqual([]);
    expect(fields(ok({ labor: [] }), general)).toEqual([]);
  });

  it("date/time: malformed, impossible and future (beyond 5 minutes) are rejected", () => {
    expect(fields(ok({ dateText: "1405/07/31" }), type())).toEqual(["datetime"]); // Mehr has 30 days
    expect(fields(ok({ timeText: "25:00" }), type())).toEqual(["datetime"]);
    expect(fields(ok({ dateText: "1405/07/25", timeText: "12:04" }), type())).toEqual([]); // 4 min ahead: tolerated
    expect(fields(ok({ dateText: "1405/07/25", timeText: "12:10" }), type())).toEqual(["datetime"]);
  });

  it("description length uses the server limit", () => {
    expect(fields(ok({ description: "x".repeat(5001) }), type())).toEqual(["description"]);
  });

  it("REQUIRED: nobody named -> blocking 'no hours entered' error; a row without a person is flagged", () => {
    const none = validate(ok({ labor: [] }), type(), cfg, NOW);
    expect(none.map((i) => i.field)).toEqual(["labor"]);
    expect(none[0].message).toContain("ساعت کاری وارد نشده");
    const blank = ok({ labor: [{ key: "x", userId: null, name: "", hours: "1", minutes: "" }] });
    expect(validate(blank, type(), cfg, NOW).some((i) => i.message.includes("فرد انتخاب نشده"))).toBe(true);
  });

  it("minutes per person: whole, > 0, <= 24h; no duplicates", () => {
    const row = (minutes: string, hours = "0", id = 7) => ({ ...authorRow({ id, full_name: "p" + id }, 1), hours, minutes });
    expect(fields(ok({ labor: [row("0")] }), type())).toEqual(["labor"]);
    expect(fields(ok({ labor: [row("x")] }), type())).toEqual(["labor"]);
    expect(fields(ok({ labor: [row("1", "24")] }), type())).toEqual(["labor"]); // 24h01m
    expect(fields(ok({ labor: [row("0", "24")] }), type())).toEqual([]); // exactly 24h is the cap
    expect(fields(ok({ labor: [row("10"), row("20")] }), type())).toEqual(["labor"]); // same person twice
    expect(fields(ok({ labor: [row("10", "0", 1), row("20", "0", 2)] }), type())).toEqual([]);
  });

  it("OPTIONAL / ON_REQUEST may stay empty; NONE ignores leftover rows entirely", () => {
    expect(fields(ok({ labor: [] }), type({ labor_mode: "OPTIONAL" }))).toEqual([]);
    expect(fields(ok({ labor: [] }), type({ labor_mode: "ON_REQUEST" }))).toEqual([]);
    expect(fields(ok({ labor: [] }), type({ labor_mode: "ON_REQUEST" }))).toEqual([]);
    expect(fields(ok(), type({ labor_mode: "NONE" }))).toEqual([]);
  });
});

describe("API body", () => {
  it("sends equipment XOR group, participants only when the section is visible, and the draft id", () => {
    const b = buildCreateBody(ok(), type(), 12);
    expect(b).toMatchObject({ report_type_id: 5, equipment_id: 9, draft_id: 12, description: "تعویض بلبرینگ" });
    expect(b.group_id).toBeUndefined();
    expect(b.participants).toEqual([{ user_id: 7, minutes: 30 }]);
    expect(Date.parse(b.event_datetime)).toBe(NOW.getTime());

    const general = buildCreateBody(ok({ equipment: null, groupId: 1 }), type({ labor_mode: "NONE", equipment_required: false }), null);
    expect(general.group_id).toBe(1);
    expect(general.equipment_id).toBeUndefined();
    expect(general.draft_id).toBeUndefined();
    expect(general.participants).toEqual([]); // hidden section => never sent, even if rows linger in state

    const closed = buildCreateBody(ok(), type({ labor_mode: "ON_REQUEST" }), null);
    expect(closed.participants).toEqual([]);
  });
  it("refuses to build from an invalid form", () => {
    expect(() => buildCreateBody(ok({ dateText: "nope" }), type(), null)).toThrow();
  });
});

describe("drafts", () => {
  it("round-trips the form through the draft payload", () => {
    const s = ok({ labor: [authorRow(author, 90)] });
    const back = fromDraftPayload(toDraftPayload(s), { equipment, names: { 7: "علی" } }, NOW);
    expect(back).toMatchObject({ typeId: 5, description: s.description, dateText: s.dateText, timeText: s.timeText, laborOpened: true });
    expect(back.equipment?.id).toBe(9);
    expect(back.labor[0]).toMatchObject({ userId: 7, name: "علی", hours: "1", minutes: "30" });
  });
  it("a participant's name is remembered in the draft and used when the server cannot resolve it (server name wins)", () => {
    const payload = toDraftPayload(ok({ labor: [authorRow(author, 90)] }));
    expect(payload.participants![0]).toMatchObject({ user_id: 7, name: "علی", minutes: 90 });
    const offline = fromDraftPayload(payload, { equipment: null, names: {} }, NOW);
    expect(offline.labor[0].name).toBe("علی"); // no lookup possible (e.g. no equipment yet): stored name, not "کاربر 7"
    const renamed = fromDraftPayload(payload, { equipment: null, names: { 7: "علی رضایی" } }, NOW);
    expect(renamed.labor[0].name).toBe("علی رضایی");
  });
  it("a half-filled form is a valid draft (incomplete labor row, no equipment, bad date)", () => {
    const s = ok({ equipment: null, dateText: "garbage", labor: [{ key: "k", userId: null, name: "", hours: "", minutes: "" }] });
    expect(toDraftPayload(s)).toMatchObject({ equipment_id: null, event_datetime: null, participants: [{ user_id: null, name: null, minutes: 0 }] });
  });
  it("unknown participants fall back to a placeholder name; equipment that no longer resolves is dropped", () => {
    const back = fromDraftPayload({ equipment_id: 9, group_id: 1, participants: [{ user_id: 99, minutes: 15 }] }, { equipment: null, names: {} }, NOW);
    expect(back.equipment).toBeNull();
    expect(back.groupId).toBe(1);
    expect(back.labor[0].name).toBe("کاربر 99");
  });
  it("blank detection ignores the clock-defaulted date", () => {
    expect(isBlank(emptyState(NOW))).toBe(true);
    expect(isBlank({ ...emptyState(NOW), description: "x" })).toBe(false);
    expect(isBlank({ ...emptyState(NOW), typeId: 5 })).toBe(false);
    expect(isBlank({ ...emptyState(NOW), groupId: 1 })).toBe(true); // an auto-selected group alone is not user input
  });
});
