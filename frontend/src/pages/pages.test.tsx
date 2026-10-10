import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { json, makeUser, mockFetch, renderApp, resetClientState, tokenBody } from "../test/utils";
import type { Equipment, Group, ReportType, Setting, User } from "../api/types";

beforeEach(() => resetClientState());
afterEach(() => resetClientState());

const page = <T,>(items: T[]) => ({ items, total: items.length, limit: 25, offset: 0 });
const ts = "2026-03-20T20:30:00";
const group = (o: Partial<Group> = {}): Group => ({ id: 1, code: "ELV", name: "آسانسور", description: null, is_active: true, equipment_count: 2, member_count: 3, created_at: ts, updated_at: ts, ...o });
const equipment = (o: Partial<Equipment> = {}): Equipment => ({ id: 10, equipment_code: "ELV-001", group_id: 1, group_code: "ELV", group_name: "آسانسور", description: null, is_active: true, created_at: ts, updated_at: ts, ...o });
const rtype = (o: Partial<ReportType> = {}): ReportType => ({ id: 5, code: "MINOR_FAILURE", name_fa: "خرابی جزئی", is_failure: true, is_active: true, created_at: ts, updated_at: ts, ...o });
const user = (o: Partial<User> = {}): User => ({ id: 2, username: "ali", full_name: "علی رضایی", role_code: "USER", role_label_fa: "کاربر", is_active: true, must_change_password: false, group_ids: [1], created_at: ts, updated_at: ts, ...o });
const setting = (o: Partial<Setting> = {}): Setting => ({ key: "REPORT_EDIT_WINDOW_HOURS", label_fa: "مهلت ویرایش گزارش", description: "d", value: 24, default: 24, minimum: 0, maximum: 720, special_values: [-1], is_default: true, updated_at: null, updated_by: null, ...o });
const roles = [{ code: "USER", label_fa: "کاربر" }, { code: "MANAGEMENT", label_fa: "مدیریت" }];

const session = (u = makeUser()) => ({ "POST /auth/refresh": () => json(200, tokenBody(u)) });

describe("settings page", () => {
  it("shows sentinel values as words, sets 'unlimited' as -1, and reports out-of-range errors in Persian", async () => {
    let n = 0;
    const m = mockFetch({
      ...session(),
      "GET /settings": () => json(200, [setting({ value: -1, is_default: false, updated_at: ts })]),
      "PUT /settings/REPORT_EDIT_WINDOW_HOURS": () => (++n === 1
        ? json(422, { detail: { code: "setting_out_of_range", key: "REPORT_EDIT_WINDOW_HOURS", minimum: 0, maximum: 720, special: [-1] } })
        : json(200, setting({ value: -1 }))),
    });
    renderApp("/settings");
    expect(await screen.findByText("نامحدود", { selector: "p" })).toBeInTheDocument();     // current value -1 -> "unlimited"
    expect(screen.queryByText("-۱")).not.toBeInTheDocument();                            // the raw sentinel is never shown
    await userEvent.click(screen.getByRole("button", { name: "ویرایش مهلت ویرایش گزارش" }));
    const input = await screen.findByLabelText("مقدار");
    await userEvent.clear(input);
    await userEvent.type(input, "999");
    await userEvent.click(screen.getByRole("button", { name: "ذخیره" }));
    expect(await screen.findByText(/مقدار باید بین ۰ و ۷۲۰/)).toBeInTheDocument();       // dialog stays open with the server message
    await userEvent.click(screen.getByRole("button", { name: "نامحدود" }));
    await userEvent.click(screen.getByRole("button", { name: "ذخیره" }));
    await waitFor(() => expect(m.count("PUT /settings/REPORT_EDIT_WINDOW_HOURS")).toBe(2));
    expect(m.calls.filter((c) => c.method === "PUT")[1].body).toEqual({ value: -1 });
  });

  it("is not reachable for non-management roles (never even requests /settings)", async () => {
    const m = mockFetch({ ...session(makeUser({ role_code: "EXPERT", username: "exp" })), "GET /equipment": () => json(200, page([])), "GET /groups": () => json(200, page([])) });
    renderApp("/settings");
    expect(await screen.findByRole("heading", { name: "تجهیزات" })).toBeInTheDocument();
    expect(m.count("GET /settings")).toBe(0);
  });
});

describe("groups page", () => {
  it("keeps the dialog open and explains why a group with active equipment cannot be deactivated", async () => {
    const m = mockFetch({
      ...session(),
      "GET /groups": () => json(200, page([group()])),
      "POST /groups/1/deactivate": () => json(409, { detail: { code: "group_has_active_equipment", count: 2 } }),
    });
    renderApp("/groups");
    await userEvent.click(await screen.findByRole("button", { name: "غیرفعال‌سازی ELV" }));
    await userEvent.click(screen.getByRole("button", { name: "تأیید" }));
    expect(await screen.findByText(/این گروه ۲ تجهیز فعال دارد/)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(m.count("POST /groups/1/deactivate")).toBe(1);
  });

  it("creates a group with the typed code (the server canonicalises) and reloads the list", async () => {
    const m = mockFetch({ ...session(), "GET /groups": () => json(200, page([group()])), "POST /groups": () => json(201, group({ id: 2, code: "ESC" })) });
    renderApp("/groups");
    await userEvent.click(await screen.findByRole("button", { name: /گروه جدید/ }));
    await userEvent.type(screen.getByLabelText(/کد گروه/), "esc");
    await userEvent.type(screen.getByLabelText("نام"), "پله برقی");
    await userEvent.click(screen.getByRole("button", { name: "ذخیره" }));
    await waitFor(() => expect(m.count("POST /groups")).toBe(1));
    expect(m.calls.find((c) => c.method === "POST" && c.path === "/groups")!.body).toEqual({ code: "esc", name: "پله برقی", description: null });
    await waitFor(() => expect(m.count("GET /groups")).toBeGreaterThanOrEqual(2));
  });
});

describe("read-only roles", () => {
  it("see the group list without any create / edit / deactivate controls", async () => {
    mockFetch({ ...session(makeUser({ role_code: "EXPERT", username: "exp" })), "GET /groups": () => json(200, page([group()])) });
    renderApp("/groups");
    await screen.findByText("آسانسور");
    expect(screen.queryByRole("button", { name: /گروه جدید|ویرایش|غیرفعال|فعال‌سازی/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("نمایش گروه‌های غیرفعال")).not.toBeInTheDocument();
  });
});

describe("equipment page", () => {
  it("passes the search term to the API and shows codes left-to-right", async () => {
    const m = mockFetch({ ...session(), "GET /groups": () => json(200, page([group()])), "GET /equipment": () => json(200, page([equipment()])) });
    renderApp("/equipment");
    expect(await screen.findByText("ELV-001")).toHaveAttribute("dir", "ltr");
    await userEvent.type(screen.getByLabelText("جستجوی کد"), "elv-0");
    await waitFor(() => expect(m.calls.some((c) => c.path === "/equipment" && c.query.get("q") === "elv-0")).toBe(true));
  });

  it("moves equipment to another group", async () => {
    const m = mockFetch({
      ...session(),
      "GET /groups": () => json(200, page([group(), group({ id: 2, code: "DOOR", name: "درب" })])),
      "GET /equipment": () => json(200, page([equipment()])),
      "POST /equipment/10/move": () => json(200, equipment({ group_id: 2, group_code: "DOOR" })),
    });
    renderApp("/equipment");
    await userEvent.click(await screen.findByRole("button", { name: "انتقال ELV-001" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("combobox"));
    await userEvent.click(await screen.findByRole("option", { name: "درب (DOOR)" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "انتقال" }));
    await waitFor(() => expect(m.count("POST /equipment/10/move")).toBe(1));
    expect(m.calls.find((c) => c.path === "/equipment/10/move")!.body).toEqual({ group_id: 2 });
  });

  it("read-only roles get no action buttons", async () => {
    mockFetch({ ...session(makeUser({ role_code: "EXPERT", username: "exp" })), "GET /groups": () => json(200, page([group()])), "GET /equipment": () => json(200, page([equipment()])) });
    renderApp("/equipment");
    await screen.findByText("ELV-001");
    expect(screen.queryByRole("button", { name: /انتقال|ویرایش|غیرفعال/ })).not.toBeInTheDocument();
  });
});

describe("report types page", () => {
  it("sends only the changed fields and explains a frozen failure flag", async () => {
    const m = mockFetch({
      ...session(),
      "GET /report-types": () => json(200, [rtype()]),
      "PATCH /report-types/5": (c) => ((c.body as Record<string, unknown>).is_failure !== undefined ? json(409, { detail: "report_type_in_use" }) : json(200, rtype({ name_fa: "جزئی" }))),
    });
    renderApp("/report-types");
    await userEvent.click(await screen.findByRole("button", { name: "ویرایش MINOR_FAILURE" }));
    const name = await screen.findByLabelText("عنوان فارسی");
    await userEvent.clear(name);
    await userEvent.type(name, "جزئی");
    await userEvent.click(screen.getByRole("button", { name: "ذخیره" }));
    await waitFor(() => expect(m.count("PATCH /report-types/5")).toBe(1));
    expect(m.calls.find((c) => c.method === "PATCH")!.body).toEqual({ name_fa: "جزئی" });   // is_failure untouched -> not sent

    await userEvent.click(await screen.findByRole("button", { name: "ویرایش MINOR_FAILURE" }));
    await userEvent.click(await screen.findByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "ذخیره" }));
    expect(await screen.findByText(/دیگر قابل تغییر نیست/)).toBeInTheDocument();
  });
});

describe("users page", () => {
  const routes = () => ({
    ...session(),
    "GET /roles": () => json(200, roles),
    "GET /groups": () => json(200, page([group()])),
    "GET /users": () => json(200, page([user({ id: 1, username: "boss", role_code: "MANAGEMENT", role_label_fa: "مدیریت" }), user()])),
  });

  it("offers no deactivate / reset-password for the signed-in manager's own row, but does for others", async () => {
    mockFetch(routes());
    renderApp("/users");
    await userEvent.click(await screen.findByRole("button", { name: "عملیات boss" }));
    expect(await screen.findByRole("menuitem", { name: "ویرایش نام و نقش" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "غیرفعال‌سازی" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "تعیین رمز موقت" })).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(await screen.findByRole("button", { name: "عملیات ali" }));
    expect(await screen.findByRole("menuitem", { name: "غیرفعال‌سازی" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "تعیین رمز موقت" })).toBeInTheDocument();
  });

  it("creates a user: sends exactly what was typed plus groups and the forced-change flag", async () => {
    const m = mockFetch({ ...routes(), "POST /users": () => json(201, user({ id: 9, username: "newbie" })) });
    renderApp("/users");
    await userEvent.click(await screen.findByRole("button", { name: /کاربر جدید/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/نام کاربری/), "NewBie");
    await userEvent.type(within(dialog).getByLabelText("نام کامل"), "کاربر جدید");
    await userEvent.click(within(dialog).getByRole("combobox", { name: "گروه‌ها" }));
    await userEvent.click(await screen.findByRole("option", { name: "آسانسور (ELV)" }));
    await userEvent.keyboard("{Escape}");
    await userEvent.type(within(dialog).getByLabelText("رمز عبور موقت"), "temporary-pass-9");
    await userEvent.click(within(dialog).getByRole("button", { name: "ذخیره" }));
    await waitFor(() => expect(m.count("POST /users")).toBe(1));
    expect(m.calls.find((c) => c.method === "POST" && c.path === "/users")!.body).toEqual({
      username: "NewBie", full_name: "کاربر جدید", role_code: "USER", password: "temporary-pass-9", group_ids: [1], must_change_password: true,
    });
  });

  it("shows the server's reason (username taken) without closing the dialog", async () => {
    mockFetch({ ...routes(), "POST /users": () => json(409, { detail: "username_taken" }) });
    renderApp("/users");
    await userEvent.click(await screen.findByRole("button", { name: /کاربر جدید/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/نام کاربری/), "ali");
    await userEvent.click(within(dialog).getByRole("button", { name: "ذخیره" }));
    expect(await within(dialog).findByText("این نام کاربری قبلاً ثبت شده است.")).toBeInTheDocument();
  });

  it("'force change for everyone' needs an explicit confirmation", async () => {
    const m = mockFetch({ ...routes(), "POST /users/force-password-change-all": () => json(200, { users_affected: 2 }) });
    renderApp("/users");
    await userEvent.click(await screen.findByRole("button", { name: "اجبار تغییر رمز همه" }));
    expect(m.count("POST /users/force-password-change-all")).toBe(0);
    await userEvent.click(await screen.findByRole("button", { name: "اجبار برای همه" }));
    await waitFor(() => expect(m.count("POST /users/force-password-change-all")).toBe(1));
  });
});
