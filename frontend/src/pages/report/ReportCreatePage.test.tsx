import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
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
const rtype = (o: Partial<ReportType> = {}): ReportType => ({ id: 5, code: "MINOR", name_fa: "تعمیر خرابی جزئی", is_failure: true, labor_mode: "REQUIRED", equipment_mode: "REQUIRED", help_fa: null, is_active: true, created_at: ts, updated_at: ts, ...o });
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
  await userEvent.click(await screen.findByRole("radio", { name: new RegExp(name) }));
}
async function chooseEquipment() {
  const box = await screen.findByRole("combobox", { name: /^تجهیز/ });
  await userEvent.click(box);
  await userEvent.click(await screen.findByRole("option", { name: /ELV-001/ }));
}
const pasteText = async (text: string) => { await userEvent.click(await screen.findByLabelText("شرح گزارش")); await userEvent.paste(text); };
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
    await userEvent.click(await screen.findByRole("button", { name: "بله، حذف شود" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByText(/شما \(تولیدکنندهٔ گزارش\) از فهرست ساعت‌ها حذف شده‌اید/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "ثبت گزارش" }));
    expect(await screen.findByText(/ساعت کاری وارد نشده است/)).toBeInTheDocument();
    expect(posts(m, "/reports")).toHaveLength(0); // blocked: nothing sent

    await userEvent.click(screen.getByRole("button", { name: "افزودن خودم" }));
    expect(screen.queryByText(/از فهرست ساعت‌ها حذف شده‌اید/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "ثبت گزارش" }));
    await waitFor(() => expect(posts(m, "/reports")).toHaveLength(1));
  });

  it("removing yourself asks first: cancel keeps the row, confirm removes it", async () => {
    mockFetch(routes());
    renderApp("/reports/new");
    await chooseType("تعمیر خرابی جزئی");
    await userEvent.click(await screen.findByRole("button", { name: "حذف ردیف 1" }));
    expect(await screen.findByText(/اگر خودتان را حذف کنید، ساعت کار شما در این گزارش ثبت نمی‌شود/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "انصراف" }));
    await waitFor(() => expect(screen.queryByText(/اگر خودتان را حذف کنید/)).not.toBeInTheDocument());
    expect(screen.getByRole("group", { name: "ردیف 1" })).toBeInTheDocument();
    expect(screen.queryByText(/از فهرست ساعت‌ها حذف شده‌اید/)).not.toBeInTheDocument(); // cancelled: nothing happened
    await userEvent.click(screen.getByRole("button", { name: "حذف ردیف 1" }));
    await userEvent.click(await screen.findByRole("button", { name: "بله، حذف شود" }));
    expect(screen.queryByRole("group", { name: "ردیف 1" })).not.toBeInTheDocument();
  });

  it("removing someone else needs no confirmation and gives no warning", async () => {
    mockFetch(routes());
    renderApp("/reports/new");
    await chooseType("تعمیر خرابی جزئی");
    await userEvent.click(await screen.findByRole("button", { name: "افزودن نفر" }));
    await userEvent.click(await screen.findByRole("button", { name: "حذف ردیف 2" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "ردیف 2" })).not.toBeInTheDocument();
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

  it("OPTIONAL labor: hidden until the optional button is pressed, then the author is pre-filled; empty is fine", async () => {
    const m = mockFetch(routes({ "POST /reports": () => json(201, created) }, { types: [rtype({ id: 6, name_fa: "گزارش تفصیلی", labor_mode: "OPTIONAL" })] }));
    renderApp("/reports/new");
    await chooseType("گزارش تفصیلی");
    await chooseEquipment();
    await describeIt();
    expect(screen.queryByRole("group", { name: "ساعت کار افراد" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "اضافه کردن ساعات افراد - اختیاری" }));
    expect(await screen.findByRole("group", { name: "ردیف 1" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "حذف ردیف 1" }));
    await userEvent.click(await screen.findByRole("button", { name: "بله، حذف شود" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "ثبت گزارش" }));
    await waitFor(() => expect(posts(m, "/reports")).toHaveLength(1));
    expect((posts(m, "/reports")[0].body as { participants: unknown }).participants).toEqual([]);
  });

  it("OPTIONAL equipment: hidden behind «افزودن تجهیز - اختیاری»; without it a group is needed and group_id is sent; with it equipment_id", async () => {
    const m = mockFetch(routes({ "POST /reports": () => json(201, created) }, { types: [rtype({ id: 8, name_fa: "گزارش تفصیلی", equipment_mode: "OPTIONAL", labor_mode: "NONE" })] }));
    renderApp("/reports/new");
    await chooseType("گزارش تفصیلی");
    expect(screen.queryByRole("combobox", { name: /^تجهیز/ })).not.toBeInTheDocument();
    expect(await screen.findByRole("combobox", { name: "گروه" })).toHaveTextContent("آسانسور (ELV)"); // the only group, preselected
    await describeIt();
    await userEvent.click(screen.getByRole("button", { name: "ثبت گزارش" }));
    await waitFor(() => expect(posts(m, "/reports")).toHaveLength(1));
    expect(posts(m, "/reports")[0].body).toMatchObject({ group_id: 1 });
    expect(posts(m, "/reports")[0].body).not.toHaveProperty("equipment_id");
    await userEvent.click(await screen.findByRole("button", { name: "ثبت گزارش جدید" }));
    await chooseType("گزارش تفصیلی");
    await userEvent.click(await screen.findByRole("button", { name: "افزودن تجهیز - اختیاری" }));
    await chooseEquipment();
    expect(screen.queryByRole("combobox", { name: "گروه" })).not.toBeInTheDocument(); // equipment decides the group
    await describeIt();
    await userEvent.click(screen.getByRole("button", { name: "ثبت گزارش" }));
    await waitFor(() => expect(posts(m, "/reports")).toHaveLength(2));
    expect(posts(m, "/reports")[1].body).toMatchObject({ equipment_id: 9 });
  });

  it("general type with NONE labor and NONE equipment: no equipment field, group preselected when it is the only one, no labor section, sends group_id", async () => {
    const m = mockFetch(routes({ "POST /reports": () => json(201, { ...created, equipment_id: null, equipment_code: null, is_general: true }) },
      { types: [rtype({ id: 7, name_fa: "درخواست قطعه یدکی", labor_mode: "NONE", equipment_mode: "NONE" })] }));
    renderApp("/reports/new");
    await chooseType("درخواست قطعه یدکی");
    expect(screen.queryByRole("combobox", { name: /^تجهیز/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "افزودن تجهیز - اختیاری" })).not.toBeInTheDocument();
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
    await chooseType("تعمیر خرابی جزئی");
    await describeIt("شروع شرح");
    await userEvent.click(screen.getByRole("button", { name: "ذخیرهٔ پیش‌نویس" }));
    expect(await screen.findByText(/پیش‌نویس ذخیره شد/)).toBeInTheDocument();
    const body = posts(m, "/reports/drafts")[0].body as { payload: Record<string, unknown> };
    expect(body.payload).toMatchObject({ description: "شروع شرح", equipment_id: null, report_type_id: 5 });
    expect(typeof body.payload.event_datetime).toBe("string");
  });

  it("server saves follow the schedule: nothing for a few words, the first at 100 changed characters, later ones at fewer (70)", async () => {
    const m = mockFetch(routes({ "PUT /reports/drafts/1": () => json(200, draftOf({ version: 2 })) }));
    renderApp("/reports/new");
    await chooseType("تعمیر خرابی جزئی");
    await pasteText("ا".repeat(99));
    await act(async () => { await new Promise((r) => setTimeout(r, 1500)); });
    expect(posts(m, "/reports/drafts")).toHaveLength(0); // 99 characters: not yet
    await userEvent.type(screen.getByLabelText("شرح گزارش"), "ب");
    await waitFor(() => expect(posts(m, "/reports/drafts")).toHaveLength(1), { timeout: 2500 }); // the 100th character
    await pasteText("ج".repeat(69));
    await act(async () => { await new Promise((r) => setTimeout(r, 1500)); });
    expect(m.calls.filter((c) => c.method === "PUT")).toHaveLength(0); // 69 changed characters since the save: not yet
    await userEvent.type(screen.getByLabelText("شرح گزارش"), "د");
    await waitFor(() => expect(m.calls.filter((c) => c.method === "PUT")).toHaveLength(1), { timeout: 2500 });
    expect(m.calls.find((c) => c.method === "PUT")!.body).toMatchObject({ version: 1 });
  }, 20_000);

  it("a short note is still saved by time: ~25 s after typing started (first), the floor later is ~10 s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const m = mockFetch(routes());
    renderApp("/reports/new");
    await chooseType("تعمیر خرابی جزئی");
    await describeIt("لامپ سوخته");
    await act(async () => { await vi.advanceTimersByTimeAsync(24_000); });
    expect(posts(m, "/reports/drafts")).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    await waitFor(() => expect(posts(m, "/reports/drafts")).toHaveLength(1));
  }, 20_000);

  it("choosing a type, equipment and people alone never creates a server draft — only report text does", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const m = mockFetch(routes());
    renderApp("/reports/new");
    await chooseType("تعمیر خرابی جزئی");
    await chooseEquipment();
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(posts(m, "/reports/drafts")).toHaveLength(0);
  }, 20_000);

  it("does not create a draft for an untouched form", async () => {
    const m = mockFetch(routes());
    renderApp("/reports/new");
    await screen.findByRole("radiogroup", { name: "نوع گزارش" });
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

  it("a restored draft shows names, not 'کاربر N', even when no equipment was chosen yet (the author is known; others come from the draft)", async () => {
    const draft = draftOf({ payload: { report_type_id: 5, description: "x", participants: [{ user_id: 2, minutes: 30 }, { user_id: 3, name: "سعید احمدی", minutes: 15 }] } });
    mockFetch(routes({}, { drafts: [draft] }));
    renderApp("/reports/new");
    await screen.findByText("پیش‌نویس قبلی شما بازیابی شد.");
    const r1 = screen.getByRole("group", { name: "ردیف 1" });
    const r2 = screen.getByRole("group", { name: "ردیف 2" });
    expect(within(r1).getByRole("combobox", { name: "نام فرد" })).toHaveValue("علی رضایی"); // the signed-in author
    expect(within(r2).getByRole("combobox", { name: "نام فرد" })).toHaveValue("سعید احمدی"); // remembered in the draft
    expect(screen.queryByDisplayValue(/کاربر \d/)).not.toBeInTheDocument();
  });

  it("drops restored equipment that is no longer available instead of submitting a stale id", async () => {
    const draft = draftOf({ payload: { equipment_id: 9, report_type_id: 5, description: "x" } });
    mockFetch(routes({ "GET /equipment/9": () => json(404, { detail: "equipment_not_found" }) }, { drafts: [draft] }));
    renderApp("/reports/new");
    await screen.findByText("پیش‌نویس قبلی شما بازیابی شد.");
    expect(screen.getByRole("combobox", { name: /^تجهیز/ })).toHaveValue("");
  });

  it("a stale save (another tab changed the draft) halts autosave, says so, and never overwrites", async () => {
    const m = mockFetch(routes({ "PUT /reports/drafts/1": () => json(409, { detail: { code: "draft_version_conflict", current_version: 5 } }) }, { drafts: [draftOf({ payload: { description: "a", report_type_id: 5 } })] }));
    renderApp("/reports/new");
    await screen.findByText("پیش‌نویس قبلی شما بازیابی شد.");
    await pasteText("z".repeat(25));
    expect(await screen.findByText(/ذخیرهٔ خودکار متوقف شد/, undefined, { timeout: 4000 })).toBeInTheDocument();
    const puts = m.calls.filter((c) => c.method === "PUT").length;
    await pasteText("y".repeat(25));
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
    fireEvent.change(screen.getByLabelText("شرح گزارش"), { target: { value: "متن نهایی" + "!".repeat(130) } }); // a late edit (the UI now locks the form; this simulates one anyway)
    expect(await screen.findByText(/گزارش ثبت شد/, undefined, { timeout: 5000 })).toBeInTheDocument();
    await act(async () => { await new Promise((r) => setTimeout(r, 1800)); });
    expect(posts(m, "/reports/drafts")).toHaveLength(1); // exactly the one made before the submit, none created by typing during it
    expect(posts(m, "/reports")).toHaveLength(1);
  }, 15_000);

  it("a first-time submit still goes through a draft, so a retry after a lost response cannot create a second report", async () => {
    let n = 0;
    const m = mockFetch(routes({
      "POST /reports": () => (++n === 1 ? json(503, {}) : json(404, { detail: "draft_not_found" })), // 1st: response lost; 2nd: server already consumed the draft
    }));
    renderApp("/reports/new");
    await chooseType("تعمیر خرابی جزئی");
    await chooseEquipment();
    await describeIt();
    await userEvent.click(screen.getByRole("button", { name: "ثبت گزارش" }));
    await waitFor(() => expect(posts(m, "/reports")).toHaveLength(1));
    expect(posts(m, "/reports/drafts")).toHaveLength(1);
    expect(posts(m, "/reports")[0].body).toMatchObject({ draft_id: 1 });
    await userEvent.click(await screen.findByRole("button", { name: "ثبت گزارش" }));
    expect(await screen.findByText(/پیش‌نویس پیدا نشد؛ ممکن است قبلاً ثبت یا حذف شده باشد/)).toBeInTheDocument();
    expect(posts(m, "/reports")[1].body).toMatchObject({ draft_id: 1 }); // same draft id on the retry
  });

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
    await screen.findByRole("radiogroup", { name: "نوع گزارش" });
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

describe("fixes found in Amin's PC test", () => {
  const eqDraft = (o: Record<string, unknown> = {}) => draftOf({ payload: { report_type_id: 5, equipment_id: 9, description: "قدیمی", participants: [{ user_id: 2, minutes: 30 }], ...o } });

  it("discarding the restored draft needs ONE click: the old text and banner are gone at once (no stale data while reloading)", async () => {
    let deleted = false;
    const m = mockFetch(routes({
      "GET /reports/drafts": () => json(200, deleted ? [] : [draftOf({ payload: { report_type_id: 5, description: "قدیمی" } })]),
      "DELETE /reports/drafts/1": () => { deleted = true; return json(204); },
    }));
    renderApp("/reports/new");
    await userEvent.click(await screen.findByRole("button", { name: "دورانداختن پیش‌نویس" }));
    await waitFor(() => expect(m.count("DELETE /reports/drafts/1")).toBe(1));
    expect(await screen.findByRole("radiogroup", { name: "نوع گزارش" })).toBeInTheDocument(); // fresh, empty form: type chooser again
    expect(screen.queryByText("پیش‌نویس قبلی شما بازیابی شد.")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("شرح گزارش")).not.toBeInTheDocument();
    expect(m.count("DELETE /reports/drafts/1")).toBe(1);
  });

  it("«بارگذاری نسخهٔ ذخیره‌شده» after a conflict shows the saved draft from the server, not the stale page", async () => {
    let reloaded = false;
    const m = mockFetch(routes({
      "GET /reports/drafts": () => json(200, [reloaded ? draftOf({ version: 5, payload: { report_type_id: 5, description: "نسخهٔ تب دیگر" } }) : draftOf({ payload: { report_type_id: 5, description: "الف" } })]),
      "PUT /reports/drafts/1": () => { reloaded = true; return json(409, { detail: { code: "draft_version_conflict", current_version: 5 } }); },
    }));
    renderApp("/reports/new");
    await screen.findByText("پیش‌نویس قبلی شما بازیابی شد.");
    await pasteText("z".repeat(25));
    await userEvent.click(await screen.findByRole("button", { name: "بارگذاری نسخهٔ ذخیره‌شده" }, { timeout: 4000 }));
    await waitFor(() => expect(screen.getByLabelText("شرح گزارش")).toHaveValue("نسخهٔ تب دیگر"));
    expect(m.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  }, 15_000);

  it("a draft that another tab/device already submitted (404) is NEVER recreated by this stale tab", async () => {
    const m = mockFetch(routes({
      "GET /reports/drafts": () => json(200, [draftOf({ payload: { report_type_id: 5, description: "الف" } })]),
      "PUT /reports/drafts/1": () => json(404, { detail: "draft_not_found" }),
    }));
    renderApp("/reports/new");
    await screen.findByText("پیش‌نویس قبلی شما بازیابی شد.");
    await pasteText("x".repeat(25));
    expect(await screen.findByText(/ثبت یا حذف شد/, undefined, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "شروع فرم جدید" })).toBeInTheDocument();
    await act(async () => { await new Promise((r) => setTimeout(r, 1800)); });
    expect(posts(m, "/reports/drafts")).toHaveLength(0);
    expect(m.calls.filter((c) => c.method === "PUT")).toHaveLength(1); // and it stopped trying
  }, 15_000);

  it("only one draft exists: creating a second one (another device made it) is a conflict, not an error chip", async () => {
    const m = mockFetch(routes({ "POST /reports/drafts": () => json(409, { detail: { code: "draft_limit_reached", limit: 1 } }) }));
    renderApp("/reports/new");
    await chooseType("تعمیر خرابی جزئی");
    await describeIt("شروع");
    await userEvent.click(screen.getByRole("button", { name: "ذخیرهٔ پیش‌نویس" }));
    expect(await screen.findByText(/ذخیرهٔ خودکار متوقف شد تا نسخهٔ دیگر بازنویسی نشود/)).toBeInTheDocument();
    expect(posts(m, "/reports/drafts")).toHaveLength(1);
  });

  it("OFFLINE: a never-answered autosave does not freeze the submit (it waits a bounded time, then submits)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const m = mockFetch(routes({
      "GET /reports/drafts": () => json(200, [eqDraft()]),
      "GET /equipment/9": () => json(200, equip),
      "PUT /reports/drafts/1": () => new Promise<Response>(() => undefined), // the request never completes
      "POST /reports": () => json(201, created),
    }));
    renderApp("/reports/new");
    await screen.findByText("پیش‌نویس قبلی شما بازیابی شد.");
    await pasteText("x".repeat(25));
    await act(async () => { await vi.advanceTimersByTimeAsync(1700); }); // autosave fires and hangs
    await userEvent.click(screen.getByRole("button", { name: "ثبت گزارش" }));
    expect(posts(m, "/reports")).toHaveLength(0); // still waiting for the hung save...
    await act(async () => { await vi.advanceTimersByTimeAsync(8200); });
    await waitFor(() => expect(posts(m, "/reports")).toHaveLength(1)); // ...but not forever
    expect(await screen.findByText(/گزارش ثبت شد/)).toBeInTheDocument();
  }, 20_000);

  it("hiding the page (switching app / locking the phone) saves the draft immediately instead of waiting for the debounce", async () => {
    const m = mockFetch(routes());
    renderApp("/reports/new");
    await chooseType("تعمیر خرابی جزئی");
    await describeIt("شرح نیمه");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
      await waitFor(() => expect(posts(m, "/reports/drafts")).toHaveLength(1), { timeout: 800 }); // far below the 1.5 s debounce
      expect((posts(m, "/reports/drafts")[0].body as { payload: { description: string } }).payload.description).toBe("شرح نیمه");
    } finally {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    }
  });
});

describe("device-local working copy, restore decisions, undo", () => {
  const view = (o: Partial<{ id: number; version: number; description: string }> = {}) =>
    draftOf({ id: o.id ?? 1, version: o.version ?? 1, updated_at: "2026-03-20T10:05:00", payload: { report_type_id: 5, description: o.description ?? "نسخه‌ی سرور" } });
  const snap = (description: string, base: { draftId: number | null; version: number | null }, at = "2026-03-20T10:09:00Z") => ({
    v: 1, userId: 2, savedAt: at, baseDraftId: base.draftId, baseVersion: base.version,
    form: { equipment: null, groupId: "", typeId: 5, dateText: "1405/01/01", timeText: "10:00", description, labor: [], laborOpened: false, equipmentOpened: false, authorRemoved: false },
  });
  const putLocal = (value: unknown, key = "ems.reportForm.2") => localStorage.setItem(key, JSON.stringify(value));

  it("what is typed survives a reload even though no server draft was ever made (a short note, offline, killed tab)", async () => {
    const m = mockFetch(routes());
    const first = renderApp("/reports/new");
    await chooseType("تعمیر خرابی جزئی");
    await describeIt("لامپ راهرو سوخته");
    await act(async () => { await new Promise((r) => setTimeout(r, 600)); }); // the local copy is written ~0.3 s after the last edit
    expect(posts(m, "/reports/drafts")).toHaveLength(0);
    first.unmount();
    renderApp("/reports/new");
    expect(await screen.findByText(/نسخه‌ی ذخیره‌نشده‌ی این دستگاه .* بازیابی شد/)).toBeInTheDocument();
    expect(screen.getByLabelText("شرح گزارش")).toHaveValue("لامپ راهرو سوخته");
  });

  it("AMIN'S OFFLINE CASE: edits made while the network was down are NOT replaced by the older server draft after a reload", async () => {
    putLocal(snap("متن قدیمی و بخشی که آفلاین نوشتم", { draftId: 1, version: 1 })); // based on server draft v1, still v1 on the server
    mockFetch(routes({}, { drafts: [view({ version: 1, description: "متن قدیمی" })] }));
    renderApp("/reports/new");
    expect(await screen.findByText(/نسخه‌ی ذخیره‌نشده‌ی این دستگاه/)).toBeInTheDocument();
    expect(screen.getByLabelText("شرح گزارش")).toHaveValue("متن قدیمی و بخشی که آفلاین نوشتم");
  });

  it("only a server draft (made on another device): restored automatically, nothing to lose", async () => {
    mockFetch(routes({}, { drafts: [view()] }));
    renderApp("/reports/new");
    expect(await screen.findByText("پیش‌نویس قبلی شما بازیابی شد.")).toBeInTheDocument();
    expect(screen.getByLabelText("شرح گزارش")).toHaveValue("نسخه‌ی سرور");
  });

  it("both exist and the server moved on (another device saved): the author chooses; the other version is kept and can be brought back", async () => {
    putLocal(snap("نسخه‌ی این دستگاه", { draftId: 1, version: 1 }));
    mockFetch(routes({}, { drafts: [view({ version: 3, description: "نسخه‌ی تازه‌ی سرور" })] }));
    renderApp("/reports/new");
    expect(await screen.findByText(/از این گزارش دو نسخه دارید/)).toBeInTheDocument();
    expect(screen.queryByLabelText("شرح گزارش")).not.toBeInTheDocument(); // nothing is shown (or saved) until the author decides
    await userEvent.click(screen.getByRole("button", { name: /نسخه‌ی این دستگاه/ }));
    expect(await screen.findByLabelText("شرح گزارش")).toHaveValue("نسخه‌ی این دستگاه");
    expect(screen.getByText(/نسخه‌ی دیگری از این گزارش .* نگه داشته شده است/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "بازگرداندن" })); // undo: the server's version comes back
    await waitFor(() => expect(screen.getByLabelText("شرح گزارش")).toHaveValue("نسخه‌ی تازه‌ی سرور"));
    await userEvent.click(screen.getByRole("button", { name: "بازگرداندن" })); // and back again: nothing is ever lost
    await waitFor(() => expect(screen.getByLabelText("شرح گزارش")).toHaveValue("نسخه‌ی این دستگاه"));
  });

  it("choosing the server version keeps this device's version for undo", async () => {
    putLocal(snap("نسخه‌ی این دستگاه", { draftId: null, version: null })); // never reached the server, but a draft exists there
    mockFetch(routes({}, { drafts: [view({ description: "نسخه‌ی سرور" })] }));
    renderApp("/reports/new");
    await userEvent.click(await screen.findByRole("button", { name: /نسخه‌ی سرور/ }));
    expect(await screen.findByLabelText("شرح گزارش")).toHaveValue("نسخه‌ی سرور");
    expect(JSON.parse(localStorage.getItem("ems.reportForm.undo.2")!).form.description).toBe("نسخه‌ی این دستگاه");
    await userEvent.click(screen.getByRole("button", { name: "بازگرداندن" }));
    await waitFor(() => expect(screen.getByLabelText("شرح گزارش")).toHaveValue("نسخه‌ی این دستگاه"));
  });

  it("a local copy built on a draft that no longer exists (submitted/deleted elsewhere) is restored but cannot be re-submitted by accident", async () => {
    const gone = snap("ممکن است قبلاً ثبت شده باشد", { draftId: 9, version: 4 });
    Object.assign(gone.form, { equipment: { id: 9, equipment_code: "ELV-001", group_id: 1, group_code: "ELV", description: null }, equipmentOpened: true,
      labor: [{ key: "k", userId: 2, name: "علی رضایی", hours: "0", minutes: "30" }], laborOpened: true });
    putLocal(gone);
    const m = mockFetch(routes({ "POST /reports": () => json(201, created) }));
    renderApp("/reports/new");
    expect(await screen.findByText(/ممکن است همین گزارش قبلاً ثبت شده باشد/)).toBeInTheDocument();
    expect(screen.getByLabelText("شرح گزارش")).toHaveValue("ممکن است قبلاً ثبت شده باشد");
    expect(screen.getByRole("button", { name: "ثبت گزارش" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "ثبت به‌عنوان گزارش جدید" })); // explicit decision
    await waitFor(() => expect(posts(m, "/reports")).toHaveLength(1));
  });

  it("submit success clears the local copy and the undo slot", async () => {
    putLocal(snap("x", { draftId: null, version: null }), "ems.reportForm.undo.2");
    mockFetch(routes({ "POST /reports": () => json(201, created) }));
    renderApp("/reports/new");
    await chooseType("تعمیر خرابی جزئی");
    await chooseEquipment();
    await describeIt();
    await act(async () => { await new Promise((r) => setTimeout(r, 500)); });
    expect(localStorage.getItem("ems.reportForm.2")).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "ثبت گزارش" }));
    await screen.findByText(/گزارش ثبت شد/);
    expect(localStorage.getItem("ems.reportForm.2")).toBeNull();
    expect(localStorage.getItem("ems.reportForm.undo.2")).toBeNull();
  });
});

describe("a submitted report never comes back as an unsaved copy", () => {
  it("after a successful submit, hiding the page or a late timer writes nothing to the local copy and nothing to the server", async () => {
    const m = mockFetch(routes({ "POST /reports": () => json(201, created) }));
    renderApp("/reports/new");
    await chooseType("تعمیر خرابی جزئی");
    await chooseEquipment();
    await describeIt("متن گزارش");
    await userEvent.click(screen.getByRole("button", { name: "ثبت گزارش" }));
    await screen.findByText(/گزارش ثبت شد/);
    const drafts = posts(m, "/reports/drafts").length;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
      await act(async () => { await new Promise((r) => setTimeout(r, 800)); });
    } finally {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    }
    expect(localStorage.getItem("ems.reportForm.2")).toBeNull();
    expect(posts(m, "/reports/drafts")).toHaveLength(drafts);
  });
});

describe("nothing can be edited while a submission is pending", () => {
  it("the form is locked during the request (edits would be lost on success), and editable again if it fails", async () => {
    let n = 0;
    mockFetch(routes({ "POST /reports": async () => { await new Promise((r) => setTimeout(r, 600)); return ++n === 1 ? json(503, {}) : json(201, created); } }));
    renderApp("/reports/new");
    await chooseType("تعمیر خرابی جزئی");
    await chooseEquipment();
    await describeIt("متن من");
    await userEvent.click(screen.getByRole("button", { name: "ثبت گزارش" }));
    await waitFor(() => expect(screen.getByLabelText("شرح گزارش")).toBeDisabled());
    await userEvent.setup({ pointerEventsCheck: 0 }).type(screen.getByLabelText("شرح گزارش"), "اضافه"); // ignored: the control is disabled
    expect(screen.getByLabelText("شرح گزارش")).toHaveValue("متن من");
    await waitFor(() => expect(screen.getByLabelText("شرح گزارش")).toBeEnabled(), { timeout: 3000 }); // request failed (503)
    expect(screen.getByLabelText("شرح گزارش")).toHaveValue("متن من");
    expect(screen.getByRole("button", { name: "ثبت گزارش" })).toBeEnabled();
  });
});

describe("every control that could change the form is locked while a submission is pending", () => {
  it("undo, discard and the conflict/gone buttons are disabled during the request", async () => {
    localStorage.setItem("ems.reportForm.undo.2", JSON.stringify({ v: 1, userId: 2, savedAt: "2026-03-20T10:00:00Z", baseDraftId: null, baseVersion: null,
      form: { equipment: null, groupId: "", typeId: 5, dateText: "1405/01/01", timeText: "10:00", description: "نسخه‌ی دیگر", labor: [], laborOpened: false, equipmentOpened: false, authorRemoved: false } }));
    const draft = draftOf({ payload: { report_type_id: 5, equipment_id: 9, description: "از سرور", participants: [{ user_id: 2, minutes: 30 }] } });
    mockFetch(routes({ "GET /equipment/9": () => json(200, equip), "POST /reports": async () => { await new Promise((r) => setTimeout(r, 700)); return json(201, created); } }, { drafts: [draft] }));
    renderApp("/reports/new");
    await screen.findByText("پیش‌نویس قبلی شما بازیابی شد.");
    const undo = screen.getByRole("button", { name: "بازگرداندن" });
    const discard = screen.getByRole("button", { name: "دورانداختن پیش‌نویس" });
    expect(undo).toBeEnabled();
    expect(discard).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "ثبت گزارش" }));
    await waitFor(() => expect(undo).toBeDisabled());
    expect(discard).toBeDisabled();
    await screen.findByText(/گزارش ثبت شد/);
  });
});

describe("one submission = one report (idempotency key)", () => {
  async function fillAndSubmit() {
    await chooseType("تعمیر خرابی جزئی");
    await chooseEquipment();
    await describeIt();
    await userEvent.click(screen.getByRole("button", { name: "ثبت گزارش" }));
  }

  it("every attempt of one submission carries the SAME key; a repeated key echoes the first report instead of a second", async () => {
    let n = 0;
    const m = mockFetch(routes({ "POST /reports": () => (++n === 1 ? json(503, {}) : json(200, { ...created, already_created: true })) }));
    renderApp("/reports/new");
    await fillAndSubmit();
    await waitFor(() => expect(posts(m, "/reports")).toHaveLength(1));
    await userEvent.click(await screen.findByRole("button", { name: "ثبت گزارش" })); // the author retries after the failure
    expect(await screen.findByText(/گزارش تکراری ساخته نشد/)).toBeInTheDocument();
    const [a, b] = posts(m, "/reports").map((c) => (c.body as { client_request_id: string }).client_request_id);
    expect(a).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(b).toBe(a);
  });

  it("a second report from the same page gets a NEW key", async () => {
    const m = mockFetch(routes({ "POST /reports": () => json(201, created) }));
    renderApp("/reports/new");
    await fillAndSubmit();
    await userEvent.click(await screen.findByRole("button", { name: "ثبت گزارش جدید" }));
    await fillAndSubmit();
    await waitFor(() => expect(posts(m, "/reports")).toHaveLength(2));
    const keys = posts(m, "/reports").map((c) => (c.body as { client_request_id: string }).client_request_id);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("pressing Enter / tapping twice sends ONE request", async () => {
    const m = mockFetch(routes({ "POST /reports": async () => { await new Promise((r) => setTimeout(r, 400)); return json(201, created); } }));
    renderApp("/reports/new");
    await chooseType("تعمیر خرابی جزئی");
    await chooseEquipment();
    await describeIt();
    const form = screen.getByRole("button", { name: "ثبت گزارش" }).closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    fireEvent.submit(form);
    await screen.findByText(/گزارش ثبت شد/);
    expect(posts(m, "/reports")).toHaveLength(1);
  });

  it("'draft not found' on submit (the draft was consumed elsewhere) blocks a plain retry; only an explicit confirmation sends it again, with a new key", async () => {
    let n = 0;
    const m = mockFetch(routes({ "POST /reports": () => (++n === 1 ? json(404, { detail: "draft_not_found" }) : json(201, created)) }));
    renderApp("/reports/new");
    await fillAndSubmit();
    expect(await screen.findByText(/ممکن است همین گزارش قبلاً ثبت شده باشد/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ثبت گزارش" })).toBeDisabled();
    expect(posts(m, "/reports")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "ثبت به‌عنوان گزارش جدید" }));
    await waitFor(() => expect(posts(m, "/reports")).toHaveLength(2));
    const [a, b] = posts(m, "/reports").map((c) => c.body as { client_request_id: string; draft_id?: number });
    expect(b.client_request_id).not.toBe(a.client_request_id);
  });
});

describe("labor «افزودن خودم» uses the configured default minutes", () => {
  it("45, not a hard-coded 30", async () => {
    mockFetch(routes({}, { cfgOver: { default_labor_minutes: 45 } }));
    renderApp("/reports/new");
    await chooseType("تعمیر خرابی جزئی");
    await userEvent.click(await screen.findByRole("button", { name: "حذف ردیف 1" }));
    await userEvent.click(await screen.findByRole("button", { name: "بله، حذف شود" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await userEvent.click(await screen.findByRole("button", { name: "افزودن خودم" }));
    expect(within(await screen.findByRole("group", { name: "ردیف 1" })).getByLabelText(/^دقیقه/)).toHaveValue("45");
  });
});

describe("type first, three modes", () => {
  it("shows only the type chooser until a type is picked; every type lists its rules and a guide behind «؟»", async () => {
    mockFetch(routes({}, { types: [rtype({ help_fa: "برای خرابی‌های کوچک" }), rtype({ id: 6, name_fa: "درخواست قطعه", labor_mode: "OPTIONAL", equipment_mode: "NONE", help_fa: null })] }));
    renderApp("/reports/new");
    expect(await screen.findByRole("radiogroup", { name: "نوع گزارش" })).toBeInTheDocument();
    expect(screen.queryByLabelText("شرح گزارش")).not.toBeInTheDocument();
    expect(screen.getByText("ساعت کار: الزامی · تجهیز: الزامی")).toBeInTheDocument();
    expect(screen.getByText("ساعت کار: اختیاری · تجهیز: ندارد")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "راهنمای تعمیر خرابی جزئی" }));
    expect(screen.getByText(/برای خرابی‌های کوچک/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "راهنمای درخواست قطعه" }));
    expect(screen.getByText(/راهنمای ویژه‌ای ثبت نشده/)).toBeInTheDocument();
  });

  it("highlights the last used type, and «تغییر نوع» brings the chooser back without losing what was typed", async () => {
    localStorage.setItem("ems.lastReportType.2", "5");
    mockFetch(routes());
    renderApp("/reports/new");
    expect(await screen.findByText("آخرین استفاده")).toBeInTheDocument();
    await chooseType("تعمیر خرابی جزئی");
    await describeIt("متن من");
    await userEvent.click(screen.getByRole("button", { name: "تغییر نوع" }));
    expect(await screen.findByRole("radiogroup", { name: "نوع گزارش" })).toBeInTheDocument();
    await chooseType("تعمیر خرابی جزئی");
    expect(screen.getByLabelText("شرح گزارش")).toHaveValue("متن من");
  });

  it("switching to a type that hides labor/equipment says so, never sends the hidden data, and the button brings it back", async () => {
    const m = mockFetch(routes({ "POST /reports": () => json(201, created) }, { types: [rtype(), rtype({ id: 6, name_fa: "گزارش تفصیلی", labor_mode: "OPTIONAL", equipment_mode: "OPTIONAL" })] }));
    renderApp("/reports/new");
    await chooseType("تعمیر خرابی جزئی");
    await chooseEquipment();
    await describeIt();
    expect(screen.getByRole("group", { name: "ردیف 1" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "تغییر نوع" }));
    await chooseType("گزارش تفصیلی");
    expect(await screen.findByText(/ساعت‌های واردشده در این نوع نمایش داده نمی‌شود/)).toBeInTheDocument();
    expect(screen.getByText(/تجهیز انتخاب‌شده در این نوع نمایش داده نمی‌شود/)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "ردیف 1" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /^تجهیز/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "ثبت گزارش" })); // single group is preselected: submit works with nothing hidden sent
    await waitFor(() => expect(posts(m, "/reports")).toHaveLength(1));
    expect(posts(m, "/reports")[0].body).toMatchObject({ report_type_id: 6, group_id: 1, participants: [] });
    expect(posts(m, "/reports")[0].body).not.toHaveProperty("equipment_id");
  });

  it("the previously entered labor comes back when the author asks for it on the OPTIONAL type", async () => {
    mockFetch(routes({}, { types: [rtype(), rtype({ id: 6, name_fa: "گزارش تفصیلی", labor_mode: "OPTIONAL" })] }));
    renderApp("/reports/new");
    await chooseType("تعمیر خرابی جزئی");
    await userEvent.click(screen.getByRole("button", { name: "تغییر نوع" }));
    await chooseType("گزارش تفصیلی");
    await userEvent.click(await screen.findByRole("button", { name: "اضافه کردن ساعات افراد - اختیاری" }));
    const row = await screen.findByRole("group", { name: "ردیف 1" });
    expect(within(row).getByRole("combobox", { name: "نام فرد" })).toHaveValue("علی رضایی");
    expect(screen.getAllByRole("group", { name: /^ردیف/ })).toHaveLength(1); // not duplicated
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
