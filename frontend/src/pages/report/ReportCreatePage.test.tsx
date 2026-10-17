import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { json, makeUser, mockFetch, renderApp, resetClientState, tokenBody } from "../../test/utils";
import type { Draft, EntryConfig, ReportType } from "../../api/types";
import { jalaliToDate } from "../../lib/jalali";
import { HEARTBEAT_MS } from "./ReportCreatePage";

beforeEach(() => resetClientState());
afterEach(() => { vi.useRealTimers(); resetClientState(); });

const ts = "2026-03-20T20:30:00";
const cfg = (o: Partial<EntryConfig> = {}): EntryConfig => ({
  default_labor_minutes: 30, max_participant_minutes: 1440, max_participants: 30, max_description_length: 5000, future_tolerance_minutes: 5,
  groups: [{ id: 1, code: "ELV", name: "آسانسور" }], ...o,
});
const rtype = (o: Partial<ReportType> = {}): ReportType => ({ id: 5, code: "MINOR", name_fa: "تعمیر خرابی جزئی", is_failure: true, labor_mode: "REQUIRED", equipment_required: true, is_active: true, created_at: ts, updated_at: ts, ...o });
const equip = { id: 9, equipment_code: "ELV-001", group_id: 1, group_code: "ELV", group_name: "آسانسور", description: "آسانسور شمالی", is_active: true, created_at: ts, updated_at: ts };
const ali = makeUser({ id: 2, username: "ali", full_name: "علی رضایی", role_code: "USER", role_label_fa: "کاربر", group_ids: [1] });
const draftOf = (o: Partial<Draft> = {}): Draft => ({ id: 1, payload: {}, version: 1, created_at: ts, updated_at: ts, ...o });
const created = { id: 100, report_number: "05-ELV-001", equipment_id: 9, equipment_code: "ELV-001", group_id: 1, group_code: "ELV", report_type_id: 5, is_general: false, event_datetime: ts, created_at: ts, description: "x", participants: [] };

function routes(over: Record<string, (c: never) => Response | Promise<Response>> = {}, o: { types?: ReportType[]; drafts?: Draft[]; cfgOver?: Partial<EntryConfig> } = {}) {
  return {
    "POST /auth/refresh": () => json(200, tokenBody(ali)),
    "GET /reports/entry-config": () => json(200, cfg(o.cfgOver)),
    "GET /report-types": () => json(200, o.types ?? [rtype()]),
    "GET /reports/drafts": () => json(200, o.drafts ?? []),
    "GET /reports/equipment-quick-pick": () => json(200, { recent: [], frequent: [] }),
    "GET /equipment": () => json(200, { items: [equip], total: 1, limit: 20, offset: 0 }),
    "GET /reports/participant-candidates": () => json(200, [{ id: 2, full_name: "علی رضایی" }, { id: 3, full_name: "سعید احمدی" }]),
    "POST /reports/heartbeat": () => json(200, { ok: true, server_time: ts }),
    "POST /reports/drafts": () => json(201, draftOf()),
    ...over,
  } as Parameters<typeof mockFetch>[0];
}

async function chooseType(name: string) {
  await userEvent.click(await screen.findByRole("combobox", { name: "نوع گزارش" }));
  await userEvent.click(await screen.findByRole("option", { name }));
}
async function chooseEquipment() {
  const box = await screen.findByRole("combobox", { name: /^تجهیز/ });
  await userEvent.click(box);
  await userEvent.click(await screen.findByRole("option", { name: /ELV-001/ }));
}
const describeIt = async (text = "تعویض بلبرینگ") => userEvent.type(await screen.findByLabelText("شرح گزارش"), text);
const posts = (m: ReturnType<typeof mockFetch>, path: string) => m.calls.filter((c) => c.method === "POST" && c.path === path);

describe("report entry page", () => {
  it("REQUIRED type: the author is pre-filled with the default minutes; submitting sends exactly the form", async () => {
    const m = mockFetch(routes({ "POST /reports": () => json(201, created) }));
    renderApp("/reports/new");
    await chooseType("تعمیر خرابی جزئی");
    const row = await screen.findByRole("group", { name: "ردیف 1" });
    expect(within(row).getByRole("combobox", { name: "نام فرد" })).toHaveValue("علی رضایی");
    expect(within(row).getByLabelText(/^دقیقه/)).toHaveValue("30");
    expect(within(row).getByText("مجموع: ۳۰ دقیقه")).toBeInTheDocument();
    await chooseEquipment();
    await describeIt();
    await userEvent.click(screen.getByRole("button", { name: "ثبت گزارش" }));

    expect(await screen.findByText(/گزارش ثبت شد/)).toBeInTheDocument();
    expect(screen.getByText("05-ELV-001")).toBeInTheDocument();
    const body = posts(m, "/reports")[0].body as Record<string, unknown>;
    expect(body).toMatchObject({ report_type_id: 5, equipment_id: 9, description: "تعویض بلبرینگ", participants: [{ user_id: 2, minutes: 30 }] });
    expect(body).not.toHaveProperty("group_id");
    expect(typeof body.event_datetime).toBe("string");
    expect(new Date(String(body.event_datetime)).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("editing hours+minutes converts to minutes; invalid numbers are caught before sending", async () => {
    const m = mockFetch(routes({ "POST /reports": () => json(201, created) }));
    renderApp("/reports/new");
    await chooseType("تعمیر خرابی جزئی");
    await chooseEquipment();
    await describeIt();
    const row = await screen.findByRole("group", { name: "ردیف 1" });
    await userEvent.clear(within(row).getByLabelText(/^ساعت/));
    await userEvent.type(within(row).getByLabelText(/^ساعت/), "2");
    await userEvent.clear(within(row).getByLabelText(/^دقیقه/));
    await userEvent.type(within(row).getByLabelText(/^دقیقه/), "15");
    expect(within(row).getByText("مجموع: ۲ ساعت و ۱۵ دقیقه")).toBeInTheDocument();
    await userEvent.clear(within(row).getByLabelText(/^دقیقه/));
    await userEvent.type(within(row).getByLabelText(/^دقیقه/), "1.5");
    await userEvent.click(screen.getByRole("button", { name: "ثبت گزارش" }));
    expect(await screen.findByText(/باید عددی صحیح و بیشتر از صفر باشد/)).toBeInTheDocument();
    expect(posts(m, "/reports")).toHaveLength(0);
    await userEvent.clear(within(row).getByLabelText(/^دقیقه/));
    await userEvent.type(within(row).getByLabelText(/^دقیقه/), "15");
    await userEvent.click(screen.getByRole("button", { name: "ثبت گزارش" }));
    await waitFor(() => expect(posts(m, "/reports")).toHaveLength(1));
    expect((posts(m, "/reports")[0].body as { participants: unknown }).participants).toEqual([{ user_id: 2, minutes: 135 }]);
  });

  it("removing the author warns (and offers to re-add); an empty REQUIRED list blocks submission with the 'no hours' error", async () => {
    const m = mockFetch(routes({ "POST /reports": () => json(201, created) }));
    renderApp("/reports/new");
    await chooseType("تعمیر خرابی جزئی");
    await chooseEquipment();
    await describeIt();
    await userEvent.click(await screen.findByRole("button", { name: "حذف ردیف 1" }));
    expect(await screen.findByText(/شما \(تولیدکنندهٔ گزارش\) از فهرست ساعت‌ها حذف شده‌اید/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "ثبت گزارش" }));
    expect(await screen.findByText(/ساعت کاری وارد نشده است/)).toBeInTheDocument();
    expect(posts(m, "/reports")).toHaveLength(0); // blocked: nothing sent

    await userEvent.click(screen.getByRole("button", { name: "افزودن خودم" }));
    expect(screen.queryByText(/از فهرست ساعت‌ها حذف شده‌اید/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "ثبت گزارش" }));
    await waitFor(() => expect(posts(m, "/reports")).toHaveLength(1));
  });

  it("removing someone else gives no warning", async () => {
    mockFetch(routes());
    renderApp("/reports/new");
    await chooseType("تعمیر خرابی جزئی");
    await userEvent.click(await screen.findByRole("button", { name: "افزودن نفر" }));
    await userEvent.click(await screen.findByRole("button", { name: "حذف ردیف 2" }));
    expect(screen.queryByText(/از فهرست ساعت‌ها حذف شده‌اید/)).not.toBeInTheDocument();
  });

  it("a participant can be picked from the server's candidate list for the selected equipment; each person only once", async () => {
    const m = mockFetch(routes({ "POST /reports": () => json(201, created) }));
    renderApp("/reports/new");
    await chooseType("تعمیر خرابی جزئی");
    await chooseEquipment();
    await describeIt();
    await userEvent.click(await screen.findByRole("button", { name: "افزودن نفر" }));
    const row2 = await screen.findByRole("group", { name: "ردیف 2" });
    await userEvent.click(within(row2).getByRole("combobox", { name: "نام فرد" }));
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["سعید احمدی"]); // the author is already in row 1
    await userEvent.click(options[0]);
    await userEvent.click(within(row2).getByRole("button", { name: "۱ ساعت" }));
    await userEvent.click(screen.getByRole("button", { name: "ثبت گزارش" }));
    await waitFor(() => expect(posts(m, "/reports")).toHaveLength(1));
    expect((posts(m, "/reports")[0].body as { participants: unknown }).participants).toEqual([{ user_id: 2, minutes: 30 }, { user_id: 3, minutes: 60 }]);
    const asked = m.calls.filter((c) => c.path === "/reports/participant-candidates");
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((c) => c.query.get("equipment_id") === "9")).toBe(true);
  });

  const equip2 = { ...equip, id: 10, equipment_code: "DOOR-001", group_id: 2, group_code: "DOOR", group_name: "درب", description: null };
  const twoEquipment = () => ({
    "GET /equipment": () => json(200, { items: [equip, equip2], total: 2, limit: 20, offset: 0 }),
    "POST /reports": () => json(201, created),
  });
  async function pickPerson(name: string) {
    await userEvent.click(await screen.findByRole("button", { name: "افزودن نفر" }));
    const row2 = await screen.findByRole("group", { name: "ردیف 2" });
    await userEvent.click(within(row2).getByRole("combobox", { name: "نام فرد" }));
    await userEvent.click(await screen.findByRole("option", { name }));
  }
  async function switchEquipment(code: RegExp) {
    await userEvent.click(screen.getByRole("combobox", { name: /^تجهیز/ }));
    await userEvent.click(await screen.findByRole("option", { name: code }));
  }

  it("changing the equipment to another group removes people who are not eligible there, says so, and keeps the rest", async () => {
    const m = mockFetch(routes({
      ...twoEquipment(),
      "GET /reports/participant-candidates": (c: { query: URLSearchParams }) => json(200,
        c.query.get("equipment_id") === "10" ? [{ id: 2, full_name: "علی رضایی" }] // DOOR: only the author is a member
          : [{ id: 2, full_name: "علی رضایی" }, { id: 3, full_name: "سعید احمدی" }]),
    } as never));
    renderApp("/reports/new");
    await chooseType("تعمیر خرابی جزئی");
    await chooseEquipment();
    await describeIt();
    await pickPerson("سعید احمدی");
    await switchEquipment(/DOOR-001/);
    expect(await screen.findByText(/این افراد در گروه جدید مجاز نیستند.*سعید احمدی/)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "ردیف 2" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "ردیف 1" })).getByRole("combobox", { name: "نام فرد" })).toHaveValue("علی رضایی");
    await userEvent.click(screen.getByRole("button", { name: "ثبت گزارش" }));
    await waitFor(() => expect(posts(m, "/reports")).toHaveLength(1));
    expect(posts(m, "/reports")[0].body).toMatchObject({ equipment_id: 10, participants: [{ user_id: 2, minutes: 30 }] });
  });

  it("changing to equipment in the SAME group, or an unrestricted candidate list, removes nobody and asks the server nothing extra", async () => {
    const m = mockFetch(routes({ ...twoEquipment(), "GET /equipment": () => json(200, { items: [equip, { ...equip, id: 11, equipment_code: "ELV-002" }], total: 2, limit: 20, offset: 0 }) } as never));
    renderApp("/reports/new");
    await chooseType("تعمیر خرابی جزئی");
    await chooseEquipment();
    await describeIt();
    await pickPerson("سعید احمدی");
    const before = m.calls.filter((c) => c.path === "/reports/participant-candidates").length;
    await switchEquipment(/ELV-002/);
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    expect(screen.queryByText(/این افراد در گروه جدید مجاز نیستند/)).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "ردیف 2" })).toBeInTheDocument();
    // only the picker's own refresh may have asked; no re-validation call (group unchanged)
    expect(m.calls.filter((c) => c.path === "/reports/participant-candidates" && c.query.get("limit") === "100")).toHaveLength(0);
    expect(m.calls.filter((c) => c.path === "/reports/participant-candidates").length).toBeGreaterThanOrEqual(before);
  });

  it("an incomplete (100-entry) candidate list is never used to remove people; the server decides", async () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, full_name: `کاربر ${i}` }));
    const m = mockFetch(routes({
      ...twoEquipment(),
      "GET /reports/participant-candidates": (c: { query: URLSearchParams }) => json(200,
        c.query.get("limit") === "100" ? many : [{ id: 2, full_name: "علی رضایی" }, { id: 3, full_name: "سعید احمدی" }]),
    } as never));
    renderApp("/reports/new");
    await chooseType("تعمیر خرابی جزئی");
    await chooseEquipment();
    await describeIt();
    await pickPerson("سعید احمدی");
    await switchEquipment(/DOOR-001/);
    await waitFor(() => expect(m.calls.some((c) => c.path === "/reports/participant-candidates" && c.query.get("limit") === "100")).toBe(true));
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
    expect(screen.getByRole("group", { name: "ردیف 2" })).toBeInTheDocument();
    expect(screen.queryByText(/این افراد در گروه جدید مجاز نیستند/)).not.toBeInTheDocument();
  });

  it("ON_REQUEST: the labor section is hidden until the optional button is pressed, then the author is pre-filled", async () => {
    const m = mockFetch(routes({ "POST /reports": () => json(201, created) }, { types: [rtype({ id: 6, name_fa: "گزارش تفصیلی", labor_mode: "ON_REQUEST" })] }));
    renderApp("/reports/new");
    await chooseType("گزارش تفصیلی");
    await chooseEquipment();
    await describeIt();
    expect(screen.queryByRole("group", { name: "ساعت کار افراد" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "اضافه کردن ساعات افراد - اختیاری" }));
    expect(await screen.findByRole("group", { name: "ردیف 1" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "حذف ردیف 1" }));
    await userEvent.click(screen.getByRole("button", { name: "ثبت گزارش" })); // optional: empty is fine
    await waitFor(() => expect(posts(m, "/reports")).toHaveLength(1));
    expect((posts(m, "/reports")[0].body as { participants: unknown }).participants).toEqual([]);
  });

  it("OPTIONAL: section visible, not pre-filled, may stay empty", async () => {
    const m = mockFetch(routes({ "POST /reports": () => json(201, created) }, { types: [rtype({ labor_mode: "OPTIONAL" })] }));
    renderApp("/reports/new");
    await chooseType("تعمیر خرابی جزئی");
    expect(await screen.findByRole("group", { name: "ساعت کار افراد" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "ردیف 1" })).not.toBeInTheDocument();
    await chooseEquipment();
    await describeIt();
    await userEvent.click(screen.getByRole("button", { name: "ثبت گزارش" }));
    await waitFor(() => expect(posts(m, "/reports")).toHaveLength(1));
  });

  it("general type with NONE labor: equipment optional, group preselected when it is the only one, no labor section, sends group_id", async () => {
    const m = mockFetch(routes({ "POST /reports": () => json(201, { ...created, equipment_id: null, equipment_code: null, is_general: true }) },
      { types: [rtype({ id: 7, name_fa: "درخواست قطعه یدکی", labor_mode: "NONE", equipment_required: false })] }));
    renderApp("/reports/new");
    await chooseType("درخواست قطعه یدکی");
    expect(screen.getByRole("combobox", { name: "تجهیز (اختیاری)" })).toBeInTheDocument();
    expect(await screen.findByRole("combobox", { name: "گروه" })).toHaveTextContent("آسانسور (ELV)");
    expect(screen.queryByRole("group", { name: "ساعت کار افراد" })).not.toBeInTheDocument();
    await describeIt("نیاز به بلبرینگ");
    await userEvent.click(screen.getByRole("button", { name: "ثبت گزارش" }));
    await waitFor(() => expect(posts(m, "/reports")).toHaveLength(1));
    const body = posts(m, "/reports")[0].body as Record<string, unknown>;
    expect(body).toMatchObject({ report_type_id: 7, group_id: 1, participants: [] });
    expect(body).not.toHaveProperty("equipment_id");
  });

  it("a normal type without equipment is blocked client-side; nothing is sent", async () => {
    const m = mockFetch(routes());
    renderApp("/reports/new");
    await chooseType("تعمیر خرابی جزئی");
    await describeIt();
    await userEvent.click(screen.getByRole("button", { name: "ثبت گزارش" }));
    expect(await screen.findByText("تجهیز را انتخاب کنید.")).toBeInTheDocument();
    expect(posts(m, "/reports")).toHaveLength(0);
  });

  it("rejects an impossible Jalali date and a future time without calling the server", async () => {
    const m = mockFetch(routes());
    renderApp("/reports/new");
    await chooseType("تعمیر خرابی جزئی");
    await chooseEquipment();
    await describeIt();
    await userEvent.clear(screen.getByLabelText("تاریخ رویداد (شمسی)"));
    await userEvent.type(screen.getByLabelText("تاریخ رویداد (شمسی)"), "۱۴۰۵/۰۷/۳۱");
    await userEvent.click(screen.getByRole("button", { name: "ثبت گزارش" }));
    expect(await screen.findByText(/تاریخ \(مثلاً ۱۴۰۵\/۰۷\/۲۵\) و ساعت/)).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("تاریخ رویداد (شمسی)"));
    await userEvent.type(screen.getByLabelText("تاریخ رویداد (شمسی)"), "1499/01/01");
    await userEvent.click(screen.getByRole("button", { name: "ثبت گزارش" }));
    expect(await screen.findByText("زمان رویداد نمی‌تواند در آینده باشد.")).toBeInTheDocument();
    expect(posts(m, "/reports")).toHaveLength(0);
  });

  it("shows the server's Persian reason when it refuses, keeps the form, and allows a retry", async () => {
    let n = 0;
    const m = mockFetch(routes({ "POST /reports": () => (++n === 1 ? json(422, { detail: { code: "participant_not_allowed", user_ids: [2] } }) : json(201, created)) }));
    renderApp("/reports/new");
    await chooseType("تعمیر خرابی جزئی");
    await chooseEquipment();
    await describeIt();
    await userEvent.click(screen.getByRole("button", { name: "ثبت گزارش" }));
    expect(await screen.findByText(/اجازهٔ ثبت در این گزارش را ندارند/)).toBeInTheDocument();
    expect(screen.getByLabelText("شرح گزارش")).toHaveValue("تعویض بلبرینگ");
    await userEvent.click(screen.getByRole("button", { name: "ثبت گزارش" }));
    await waitFor(() => expect(posts(m, "/reports")).toHaveLength(2));
  });
});

describe("drafts and heartbeat", () => {
  it("the manual button saves the draft to the server at once and shows the status", async () => {
    const m = mockFetch(routes());
    renderApp("/reports/new");
    await describeIt("شروع شرح");
    await userEvent.click(screen.getByRole("button", { name: "ذخیرهٔ پیش‌نویس" }));
    expect(await screen.findByText(/پیش‌نویس ذخیره شد/)).toBeInTheDocument();
    const body = posts(m, "/reports/drafts")[0].body as { payload: Record<string, unknown> };
    expect(body.payload).toMatchObject({ description: "شروع شرح", equipment_id: null, report_type_id: null });
    expect(typeof body.payload.event_datetime).toBe("string");
  });

  it("autosaves ~1.5 s after the last edit: first a POST, later edits PUT with the version it last saw", async () => {
    const m = mockFetch(routes({ "PUT /reports/drafts/1": () => json(200, draftOf({ version: 2 })) }));
    renderApp("/reports/new");
    await describeIt("الف");
    await waitFor(() => expect(posts(m, "/reports/drafts")).toHaveLength(1), { timeout: 4000 });
    await userEvent.type(screen.getByLabelText("شرح گزارش"), "ب");
    await waitFor(() => expect(m.calls.filter((c) => c.method === "PUT")).toHaveLength(1), { timeout: 4000 });
    expect(m.calls.find((c) => c.method === "PUT")!.body).toMatchObject({ version: 1, payload: { description: "الفب" } });
  });

  it("does not create a draft for an untouched form", async () => {
    const m = mockFetch(routes());
    renderApp("/reports/new");
    await screen.findByRole("combobox", { name: "نوع گزارش" });
    await act(async () => { await new Promise((r) => setTimeout(r, 1800)); });
    expect(posts(m, "/reports/drafts")).toHaveLength(0);
  });

  it("restores the latest server draft (equipment re-resolved, participants named) and submits from it", async () => {
    const draft = draftOf({ id: 4, version: 3, payload: {
      equipment_id: 9, report_type_id: 5, description: "نیمه‌کاره", event_datetime: jalaliToDate({ year: 1405, month: 7, day: 20, hour: 9, minute: 15 })!.toISOString(),
      participants: [{ user_id: 3, minutes: 90 }] } });
    const m = mockFetch(routes({ "GET /equipment/9": () => json(200, equip), "POST /reports": () => json(201, created) }, { drafts: [draft] }));
    renderApp("/reports/new");
    expect(await screen.findByText("پیش‌نویس قبلی شما بازیابی شد.")).toBeInTheDocument();
    expect(screen.getByLabelText("شرح گزارش")).toHaveValue("نیمه‌کاره");
    expect(screen.getByLabelText("تاریخ رویداد (شمسی)")).toHaveValue("1405/07/20");
    expect(screen.getByLabelText("ساعت رویداد")).toHaveValue("09:15");
    expect(screen.getByRole("combobox", { name: /^تجهیز/ })).toHaveValue("ELV-001");
    const row = screen.getByRole("group", { name: "ردیف 1" });
    expect(within(row).getByRole("combobox", { name: "نام فرد" })).toHaveValue("سعید احمدی");
    expect(within(row).getByLabelText(/^ساعت/)).toHaveValue("1");
    await userEvent.click(screen.getByRole("button", { name: "ثبت گزارش" }));
    await waitFor(() => expect(posts(m, "/reports")).toHaveLength(1));
    expect(posts(m, "/reports")[0].body).toMatchObject({ draft_id: 4, equipment_id: 9, participants: [{ user_id: 3, minutes: 90 }] });
  });

  it("drops restored equipment that is no longer available instead of submitting a stale id", async () => {
    const draft = draftOf({ payload: { equipment_id: 9, report_type_id: 5, description: "x" } });
    mockFetch(routes({ "GET /equipment/9": () => json(404, { detail: "equipment_not_found" }) }, { drafts: [draft] }));
    renderApp("/reports/new");
    await screen.findByText("پیش‌نویس قبلی شما بازیابی شد.");
    expect(screen.getByRole("combobox", { name: /^تجهیز/ })).toHaveValue("");
  });

  it("a stale save (another tab changed the draft) halts autosave, says so, and never overwrites", async () => {
    const m = mockFetch(routes({ "PUT /reports/drafts/1": () => json(409, { detail: { code: "draft_version_conflict", current_version: 5 } }) }, { drafts: [draftOf({ payload: { description: "a" } })] }));
    renderApp("/reports/new");
    await screen.findByText("پیش‌نویس قبلی شما بازیابی شد.");
    await userEvent.type(screen.getByLabelText("شرح گزارش"), "z");
    expect(await screen.findByText(/ذخیرهٔ خودکار متوقف شد/, undefined, { timeout: 4000 })).toBeInTheDocument();
    const puts = m.calls.filter((c) => c.method === "PUT").length;
    await userEvent.type(screen.getByLabelText("شرح گزارش"), "y");
    await act(async () => { await new Promise((r) => setTimeout(r, 1800)); });
    expect(m.calls.filter((c) => c.method === "PUT")).toHaveLength(puts); // no further attempts
  });

  it("while a submit is in flight no autosave can create a stray draft (the report would then leave an orphan draft behind)", async () => {
    const m = mockFetch(routes({ "POST /reports": async () => { await new Promise((r) => setTimeout(r, 2200)); return json(201, created); } }));
    renderApp("/reports/new");
    await chooseType("تعمیر خرابی جزئی");
    await chooseEquipment();
    await describeIt();
    await userEvent.click(screen.getByRole("button", { name: "ثبت گزارش" }));
    await userEvent.type(screen.getByLabelText("شرح گزارش"), "!"); // typing while the request is pending schedules an autosave
    expect(await screen.findByText(/گزارش ثبت شد/, undefined, { timeout: 5000 })).toBeInTheDocument();
    await act(async () => { await new Promise((r) => setTimeout(r, 1800)); });
    expect(posts(m, "/reports/drafts")).toHaveLength(0);
    expect(posts(m, "/reports")).toHaveLength(1);
  }, 15_000);

  it("discarding the restored draft deletes it on the server and starts clean", async () => {
    const m = mockFetch(routes({ "DELETE /reports/drafts/1": () => json(204) }, { drafts: [draftOf({ payload: { description: "قدیمی" } })] }));
    renderApp("/reports/new");
    await userEvent.click(await screen.findByRole("button", { name: "دورانداختن پیش‌نویس" }));
    await waitFor(() => expect(m.count("DELETE /reports/drafts/1")).toBe(1));
  });

  it("heartbeat pings while the form is open and warns when the server cannot be reached", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let fail = false;
    const m = mockFetch(routes({ "POST /reports/heartbeat": () => (fail ? json(503, {}) : json(200, { ok: true, server_time: ts })) }));
    renderApp("/reports/new");
    await screen.findByRole("combobox", { name: "نوع گزارش" });
    await act(async () => { await vi.advanceTimersByTimeAsync(HEARTBEAT_MS + 100); });
    expect(m.count("POST /reports/heartbeat")).toBe(1);
    fail = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(HEARTBEAT_MS); });
    expect(await screen.findByText(/ارتباط با سرور قطع است/)).toBeInTheDocument();
    fail = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(HEARTBEAT_MS); });
    await waitFor(() => expect(screen.queryByText(/ارتباط با سرور قطع است/)).not.toBeInTheDocument());
  });
});

describe("access", () => {
  it("AUDITOR has no entry in the menu and is sent away from /reports/new", async () => {
    const aud = makeUser({ id: 9, username: "aud", role_code: "AUDITOR", role_label_fa: "بازرس ارشد" });
    mockFetch({
      "POST /auth/refresh": () => json(200, tokenBody(aud)),
      "GET /dashboard/summary": () => json(200, { active_users: 0, inactive_users: 0, active_equipment: 0, inactive_equipment: 0, active_groups: 0, groups: [] }),
    });
    renderApp("/reports/new");
    await screen.findByRole("navigation", { name: "منوی اصلی" });
    expect(screen.queryByRole("link", { name: "ثبت گزارش" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "ثبت گزارش" })).not.toBeInTheDocument();
  });

  it("USER sees the menu entry", async () => {
    mockFetch(routes());
    renderApp("/reports/new");
    expect(await screen.findByRole("link", { name: "ثبت گزارش" })).toBeInTheDocument();
  });
});
