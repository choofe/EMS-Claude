import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { json, makeUser, mockFetch, renderApp, resetClientState, tokenBody } from "../../test/utils";
import type { Group, User } from "../../api/types";

const reset = () => { resetClientState(); sessionStorage.clear(); };
beforeEach(reset);
afterEach(reset);

const ts = "2026-03-20T20:30:00";
const page = <T,>(items: T[]) => json(200, { items, total: items.length, limit: 25, offset: 0 });
const group: Group = { id: 1, code: "ELV", name: "آسانسور", description: null, is_active: true, equipment_count: 2, member_count: 3, created_at: ts, updated_at: ts };
const user = (o: Partial<User> = {}): User => ({
  id: 2, username: "ali", full_name: "علی رضایی", first_name: null, last_name: null, personnel_code: 1234, mobile: "09121234567", has_login: true,
  login_enabled: true, role_code: "USER", role_label_fa: "تکنسین کاربر", is_active: true, must_change_password: false, group_ids: [1], needs_group: false,
  created_at: ts, updated_at: ts, ...o,
});
const person = (o: Partial<User> = {}) => user({ id: 5, username: null, full_name: "سارا نظری", has_login: false, login_enabled: false, role_code: null, role_label_fa: null, personnel_code: 7, mobile: "09151112233", ...o });
const ROLES = [
  { code: "USER", label_fa: "تکنسین کاربر" }, { code: "EXPERT", label_fa: "کارشناس" }, { code: "MANAGEMENT", label_fa: "مدیریت" }, { code: "AUDITOR", label_fa: "بازرس ارشد" },
];
const routes = (users: User[], extra: Record<string, () => Response | Promise<Response>> = {}) => ({
  "POST /auth/refresh": () => json(200, tokenBody(makeUser())), "GET /roles": () => json(200, ROLES), "GET /groups": () => page([group]),
  "GET /users": () => page(users), "GET /users/no-group-alert": () => json(200, { count: 0, show: false }), ...extra,
});
const bodyOf = (m: ReturnType<typeof mockFetch>, method: string, path: string) => m.calls.find((c) => c.method === method && c.path === path)!.body;

async function openNewPerson() {
  await userEvent.click(await screen.findByRole("button", { name: "فرد جدید" }));
  return await screen.findByRole("dialog");
}
async function fillPerson(dialog: HTMLElement, mobile = "09121234567", code = "132") {
  await userEvent.type(within(dialog).getByLabelText("نام", { exact: true }), "رضا");
  await userEvent.type(within(dialog).getByLabelText("نام خانوادگی"), "کریمی");
  await userEvent.type(within(dialog).getByLabelText("کد پرسنلی"), code);
  await userEvent.type(within(dialog).getByLabelText("شماره موبایل"), mobile);
}

describe("creating a person (Pk)", () => {
  it("creates a person without an account: the four identity fields and the groups, no profile", async () => {
    const m = mockFetch(routes([user()], { "POST /users/people": () => json(201, person({ id: 9 })) }));
    renderApp("/users");
    const dialog = await openNewPerson();
    expect(within(dialog).getByRole("button", { name: "ثبت" })).toBeDisabled();
    await fillPerson(dialog);
    await userEvent.click(within(dialog).getByRole("combobox", { name: "گروه‌ها" }));
    await userEvent.click(await screen.findByRole("option", { name: "آسانسور (ELV)" }));
    await userEvent.keyboard("{Escape}");
    await userEvent.click(within(dialog).getByRole("button", { name: "ثبت" }));
    await waitFor(() => expect(m.count("POST /users/people")).toBe(1));
    expect(bodyOf(m, "POST", "/users/people")).toEqual({ first_name: "رضا", last_name: "کریمی", personnel_code: "132", mobile: "09121234567", group_ids: [1] });
  });

  it("with the account switch on, nothing can be saved until a password method is chosen; the random password is what is sent", async () => {
    const m = mockFetch(routes([user()], { "POST /users/people": () => json(201, person({ id: 9 })) }));
    renderApp("/users");
    const dialog = await openNewPerson();
    await fillPerson(dialog);
    await userEvent.click(within(dialog).getByLabelText("ساخت حساب ورود"));
    await userEvent.type(within(dialog).getByLabelText(/نام کاربری/), "Reza.K");
    expect(within(dialog).getByRole("button", { name: "ثبت" })).toBeDisabled();  // no method yet
    expect(within(dialog).getByRole("radio", { name: "تصادفی" })).not.toBeChecked();
    await userEvent.click(within(dialog).getByRole("radio", { name: "تصادفی" }));
    const shown = (within(dialog).getByLabelText("رمز تولیدشده") as HTMLInputElement).value;
    expect(shown).toMatch(/^[abcdefghjkmnpqrstuvwxyz23456789]{8,10}$/);
    await userEvent.click(within(dialog).getByRole("button", { name: "ثبت" }));
    await waitFor(() => expect(m.count("POST /users/people")).toBe(1));
    expect(bodyOf(m, "POST", "/users/people")).toEqual({
      first_name: "رضا", last_name: "کریمی", personnel_code: "132", mobile: "09121234567", group_ids: [],
      profile: { username: "Reza.K", password: shown, role_code: "USER", must_change_password: true },
    });
  });

  it("switching the account off and on again forgets the old password: a method must be chosen again", async () => {
    mockFetch(routes([user()]));
    renderApp("/users");
    const dialog = await openNewPerson();
    await fillPerson(dialog);
    await userEvent.click(within(dialog).getByLabelText("ساخت حساب ورود"));
    await userEvent.type(within(dialog).getByLabelText(/نام کاربری/), "reza.k");
    await userEvent.click(within(dialog).getByRole("radio", { name: "تصادفی" }));
    expect(within(dialog).getByRole("button", { name: "ثبت" })).toBeEnabled();
    await userEvent.click(within(dialog).getByLabelText("ساخت حساب ورود"));
    await userEvent.click(within(dialog).getByLabelText("ساخت حساب ورود"));
    await userEvent.type(within(dialog).getByLabelText(/نام کاربری/), "reza.k");
    expect(within(dialog).getByRole("radio", { name: "تصادفی" })).not.toBeChecked();
    expect(within(dialog).getByRole("button", { name: "ثبت" })).toBeDisabled();
  });

  it("offers only the two profile types", async () => {
    mockFetch(routes([user()]));
    renderApp("/users");
    const dialog = await openNewPerson();
    await userEvent.click(within(dialog).getByLabelText("ساخت حساب ورود"));
    await userEvent.click(within(dialog).getByRole("combobox", { name: "نوع حساب" }));
    expect(await screen.findByRole("option", { name: "تکنسین کاربر" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "کارشناس" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "مدیریت" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "بازرس ارشد" })).not.toBeInTheDocument();
  });

  it("the mobile and derived methods follow what is typed: disabled without a valid mobile / code, derived replaces the last four digits", async () => {
    const m = mockFetch(routes([user()], { "POST /users/people": () => json(201, person({ id: 9 })) }));
    renderApp("/users");
    const dialog = await openNewPerson();
    await userEvent.type(within(dialog).getByLabelText("نام", { exact: true }), "رضا");
    await userEvent.type(within(dialog).getByLabelText("نام خانوادگی"), "کریمی");
    await userEvent.click(within(dialog).getByLabelText("ساخت حساب ورود"));
    await userEvent.type(within(dialog).getByLabelText(/نام کاربری/), "reza.k");
    expect(within(dialog).getByRole("radio", { name: "شمارهٔ موبایل" })).toBeDisabled();
    expect(within(dialog).getByRole("radio", { name: "مشتق از موبایل و کد پرسنلی" })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("شماره موبایل"), "۰۹۱۲۱۲۳۴۵۶۷");
    expect(within(dialog).getByRole("radio", { name: "شمارهٔ موبایل" })).toBeEnabled();
    expect(within(dialog).getByRole("radio", { name: "مشتق از موبایل و کد پرسنلی" })).toBeDisabled();  // no code yet
    await userEvent.type(within(dialog).getByLabelText("کد پرسنلی"), "۱۳۲");
    await userEvent.click(within(dialog).getByRole("radio", { name: "مشتق از موبایل و کد پرسنلی" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "ثبت" }));
    await waitFor(() => expect(m.count("POST /users/people")).toBe(1));
    expect((bodyOf(m, "POST", "/users/people") as { profile: { password: string } }).profile.password).toBe("09121230132");
  });

  it("shows the server's reason for a taken personnel code and keeps the dialog open", async () => {
    mockFetch(routes([user()], { "POST /users/people": () => json(409, { detail: "personnel_code_taken" }) }));
    renderApp("/users");
    const dialog = await openNewPerson();
    await fillPerson(dialog);
    await userEvent.click(within(dialog).getByRole("button", { name: "ثبت" }));
    expect(await within(dialog).findByText("این کد پرسنلی قبلاً برای فرد دیگری ثبت شده است.")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("opens clean the second time", async () => {
    mockFetch(routes([user()]));
    renderApp("/users");
    let dialog = await openNewPerson();
    await userEvent.type(within(dialog).getByLabelText("نام", { exact: true }), "رضا");
    await userEvent.click(within(dialog).getByRole("button", { name: "انصراف" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    dialog = await openNewPerson();
    expect((within(dialog).getByLabelText("نام", { exact: true }) as HTMLInputElement).value).toBe("");
  });
});

describe("account for an existing person (Pk)", () => {
  const openMenu = async (name: string) => { await userEvent.click(await screen.findByRole("button", { name })); };

  it("is offered only for an active person without an account", async () => {
    mockFetch(routes([person(), person({ id: 6, full_name: "غیرفعال", is_active: false }), user()]));
    renderApp("/users");
    await openMenu("عملیات سارا نظری");
    expect(await screen.findByRole("menuitem", { name: "ساخت حساب ورود" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menuitem")).not.toBeInTheDocument());
    await openMenu("عملیات غیرفعال");
    expect(screen.queryByRole("menuitem", { name: "ساخت حساب ورود" })).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menuitem")).not.toBeInTheDocument());
    await openMenu("عملیات ali");
    expect(screen.queryByRole("menuitem", { name: "ساخت حساب ورود" })).not.toBeInTheDocument();
  });

  it("sends username, chosen type and password with the mobile-number method taken from the person", async () => {
    const m = mockFetch(routes([person()], { "POST /users/5/profile": () => json(201, user({ id: 5 })) }));
    renderApp("/users");
    await userEvent.click(await screen.findByRole("button", { name: "عملیات سارا نظری" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "ساخت حساب ورود" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "ساخت حساب" })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/نام کاربری/), "sara.n");
    await userEvent.click(within(dialog).getByRole("combobox", { name: "نوع حساب" }));
    await userEvent.click(await screen.findByRole("option", { name: "کارشناس" }));
    await userEvent.click(within(dialog).getByRole("radio", { name: "شمارهٔ موبایل" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "ساخت حساب" }));
    await waitFor(() => expect(m.count("POST /users/5/profile")).toBe(1));
    expect(bodyOf(m, "POST", "/users/5/profile")).toEqual({ username: "sara.n", password: "09151112233", role_code: "EXPERT", must_change_password: true });
  });
});

describe("temporary password dialog (Pk)", () => {
  async function openReset(target: User) {
    mockFetch(routes([target], { [`POST /users/${target.id}/reset-password`]: () => json(200, target) }));
    renderApp("/users");
    await userEvent.click(await screen.findByRole("button", { name: `عملیات ${target.username}` }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "تعیین رمز موقت" }));
    return await screen.findByRole("dialog");
  }

  it("has the same methods, none preselected and saving disabled until one is chosen", async () => {
    const dialog = await openReset(user({ id: 3, username: "reza", role_code: "USER" }));
    expect(within(dialog).getByRole("button", { name: "ذخیره" })).toBeDisabled();
    for (const r of within(dialog).getAllByRole("radio")) expect(r).not.toBeChecked();
    await userEvent.click(within(dialog).getByRole("radio", { name: "تایپ دستی" }));
    await userEvent.type(within(dialog).getByLabelText("رمز عبور موقت"), "temporary-pass-9");
    expect(within(dialog).getByRole("button", { name: "ذخیره" })).toBeEnabled();
  });

  it("locks the forced change on, with a warning, for a guessable password on a manager or auditor account", async () => {
    const dialog = await openReset(user({ id: 3, username: "boss2", role_code: "MANAGEMENT", role_label_fa: "مدیریت" }));
    const forced = within(dialog).getByLabelText("کاربر در اولین ورود باید رمز را تغییر دهد");
    await userEvent.click(forced);  // the manager switches it off first
    expect(forced).not.toBeChecked();
    await userEvent.click(within(dialog).getByRole("radio", { name: "شمارهٔ موبایل" }));
    expect(forced).toBeChecked();
    expect(forced).toBeDisabled();
    expect(within(dialog).getByText(/قابل حدس است/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("radio", { name: "تصادفی" }));  // a random password releases the lock
    expect(forced).toBeEnabled();
    expect(within(dialog).queryByText(/قابل حدس است/)).not.toBeInTheDocument();
  });

  it("what is sent for a manager account is the forced change ON, even if the switch was turned off first", async () => {
    const target = user({ id: 3, username: "boss2", role_code: "MANAGEMENT", role_label_fa: "مدیریت" });
    const m = mockFetch(routes([target], { "POST /users/3/reset-password": () => json(200, target) }));
    renderApp("/users");
    await userEvent.click(await screen.findByRole("button", { name: "عملیات boss2" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "تعیین رمز موقت" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByLabelText("کاربر در اولین ورود باید رمز را تغییر دهد"));
    await userEvent.click(within(dialog).getByRole("radio", { name: "مشتق از موبایل و کد پرسنلی" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "ذخیره" }));
    await waitFor(() => expect(m.count("POST /users/3/reset-password")).toBe(1));
    expect(bodyOf(m, "POST", "/users/3/reset-password")).toEqual({ password: "09121231234", must_change_password: true });
  });

  it("does not lock the forced change for an EXPERT account", async () => {
    const dialog = await openReset(user({ id: 3, username: "kar", role_code: "EXPERT", role_label_fa: "کارشناس" }));
    await userEvent.click(within(dialog).getByRole("radio", { name: "شمارهٔ موبایل" }));
    const forced = within(dialog).getByLabelText("کاربر در اولین ورود باید رمز را تغییر دهد");
    expect(forced).toBeEnabled();
    expect(within(dialog).queryByText(/قابل حدس است/)).not.toBeInTheDocument();
  });
});
