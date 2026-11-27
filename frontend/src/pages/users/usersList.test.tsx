import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { json, makeUser, mockFetch, renderApp, resetClientState, tokenBody } from "../../test/utils";
import type { Group, User } from "../../api/types";
import { clearNoGroupBannerFlags } from "./NoGroupBanner";
import { HelpHint } from "../../components/HelpHint";

const reset = () => { resetClientState(); sessionStorage.clear(); };
beforeEach(reset);
afterEach(() => { reset(); vi.useRealTimers(); });

const ts = "2026-03-20T20:30:00";
const page = <T,>(items: T[], total = items.length) => json(200, { items, total, limit: 25, offset: 0 });
const group = (o: Partial<Group> = {}): Group => ({ id: 1, code: "ELV", name: "آسانسور", description: null, is_active: true, equipment_count: 2, member_count: 3, created_at: ts, updated_at: ts, ...o });
const user = (o: Partial<User> = {}): User => ({
  id: 2, username: "ali", full_name: "علی رضایی", first_name: null, last_name: null, personnel_code: 1234, mobile: "09121234567", has_login: true,
  login_enabled: true, role_code: "USER", role_label_fa: "تکنسین کاربر", is_active: true, must_change_password: false, group_ids: [1], needs_group: false,
  created_at: ts, updated_at: ts, ...o,
});
const session = (u = makeUser()) => ({ "POST /auth/refresh": () => json(200, tokenBody(u)) });
const base = (users: User[], extra: Record<string, () => Response | Promise<Response>> = {}) => ({
  ...session(), "GET /roles": () => json(200, [{ code: "USER", label_fa: "تکنسین کاربر" }]), "GET /groups": () => page([group()]),
  "GET /users": () => page(users), "GET /users/no-group-alert": () => json(200, { count: 0, show: false }), ...extra,
});
/** MUI's `down("sm")` is a max-width query: matching it means «phone». The shared test setup matches everything. */
const screenSize = (phone: boolean) => {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({ matches: query.includes("max-width") ? phone : true, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
  return () => { window.matchMedia = original; };
};

describe("users list (Pf)", () => {
  it("shows personnel code, mobile, group tags and state tags; people who need a group are marked", async () => {
    const restore = screenSize(false);
    try {
      mockFetch(base([
        user({ id: 3, username: null, full_name: "سارا نظری", has_login: false, login_enabled: false, role_code: null, role_label_fa: null, group_ids: [], needs_group: true, personnel_code: 7 }),
        user(), user({ id: 4, username: "boss2", full_name: "مدیر دوم", role_code: "MANAGEMENT", role_label_fa: "مدیریت", group_ids: [], personnel_code: null, login_enabled: false }),
      ]));
      renderApp("/users");
      const sara = (await screen.findByText("سارا نظری")).closest("tr")!;
      expect(sara).toHaveAttribute("data-needs-group", "true");
      expect(within(sara).getByText("بدون گروه")).toBeInTheDocument();
      expect(within(sara).getByText("بدون حساب")).toBeInTheDocument();
      expect(within(sara).getByText("۷")).toBeInTheDocument();
      const ali = screen.getByText("علی رضایی").closest("tr")!;
      expect(ali).toHaveAttribute("data-needs-group", "false");
      expect(within(ali).getByText("ELV")).toBeInTheDocument();
      expect(within(ali).getByText("۱۲۳۴")).toBeInTheDocument();
      expect(within(ali).getByText("09121234567")).toBeInTheDocument();
      expect(within(ali).getByText("تکنسین کاربر")).toBeInTheDocument();
      const boss = screen.getByText("مدیر دوم").closest("tr")!;  // organisation-wide: its own word, never «بدون گروه»
      expect(within(boss).getByText("مدیر")).toBeInTheDocument();
      expect(within(boss).queryByText("بدون گروه")).not.toBeInTheDocument();
      expect(within(boss).getByText("ورود خاموش")).toBeInTheDocument();
    } finally { restore(); }
  });

  it("account tags use different faded colours and «بدون گروه» its own", async () => {
    const restore = screenSize(false);
    try {
      mockFetch(base([user({ id: 3, username: null, full_name: "سارا نظری", has_login: false, login_enabled: false, role_code: null, role_label_fa: null, group_ids: [], needs_group: true }), user()]));
      renderApp("/users");
      await screen.findByText("سارا نظری");
      const bg = (el: HTMLElement) => getComputedStyle(el.closest(".MuiChip-root")!).backgroundColor;
      const has = bg(screen.getByText("دارای حساب")), none = bg(screen.getByText("بدون حساب")), nog = bg(screen.getByText("بدون گروه"));
      expect(new Set([has, none, nog]).size).toBe(3);
    } finally { restore(); }
  });

  it("AUDITOR gets no mobile column and no write controls", async () => {
    const restore = screenSize(false);
    try {
      mockFetch(base([user({ mobile: null })]));
      mockFetch({ ...base([user({ mobile: null })]), ...session(makeUser({ id: 9, username: "aud", role_code: "AUDITOR", role_label_fa: "بازرس ارشد" })) });
      renderApp("/users");
      await screen.findByText("علی رضایی");
      expect(screen.queryByText("شماره موبایل")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /عملیات/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "نمایش شماره‌ها" })).not.toBeInTheDocument();
    } finally { restore(); }
  });

  it("on a phone the mobile column appears only after «نمایش شماره‌ها»", async () => {
    const restore = screenSize(true);
    try {
      mockFetch(base([user()]));
      renderApp("/users");
      await screen.findByText("علی رضایی");
      expect(screen.queryByText("09121234567")).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "نمایش شماره‌ها" }));
      expect(await screen.findByText("09121234567")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "پنهان‌کردن شماره‌ها" }));
      expect(screen.queryByText("09121234567")).not.toBeInTheDocument();
    } finally { restore(); }
  });

  it("the account filter and the search are sent to the server", async () => {
    const restore = screenSize(false);
    try {
      const m = mockFetch(base([user()]));
      renderApp("/users");
      await screen.findByText("علی رضایی");
      await userEvent.click(screen.getByRole("combobox", { name: "حساب" }));
      await userEvent.click(await screen.findByRole("option", { name: "بدون حساب" }));
      await waitFor(() => expect(m.calls.some((c) => c.path === "/users" && c.query.get("has_login") === "false")).toBe(true));
      await userEvent.type(screen.getByLabelText("جستجوی نام، نام کاربری یا کد پرسنلی"), "1234");
      await waitFor(() => expect(m.calls.some((c) => c.path === "/users" && c.query.get("q") === "1234")).toBe(true));
    } finally { restore(); }
  });
});

describe("no-group banner (Pf)", () => {
  const due = { "GET /users/no-group-alert": () => json(200, { count: 3, show: true }) };

  it("is shown to MANAGEMENT with a link, and «×» hides it for the session without calling the server", async () => {
    const restore = screenSize(false);
    try {
      const m = mockFetch(base([user()], due));
      renderApp("/users");
      const banner = await screen.findByRole("status");
      expect(banner).toHaveTextContent("۳ نفر");
      expect(within(banner).getByRole("link", { name: "مشاهده در لیست کاربران" })).toHaveAttribute("href", "/users");
      await userEvent.click(within(banner).getByRole("button", { name: "بستن" }));
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(m.count("POST /users/no-group-alert/dismiss")).toBe(0);
      expect(sessionStorage.getItem("ems.noGroupBanner.hidden.1")).toBe("1");
    } finally { restore(); }
  });

  it("«دیگر نشان نده» tells the server once and hides the banner", async () => {
    const restore = screenSize(false);
    try {
      const m = mockFetch(base([user()], { ...due, "POST /users/no-group-alert/dismiss": () => json(200, { count: 3, show: false }) }));
      renderApp("/users");
      await userEvent.click(await screen.findByRole("button", { name: "دیگر نشان نده" }));
      await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
      expect(m.count("POST /users/no-group-alert/dismiss")).toBe(1);
      expect(sessionStorage.getItem("ems.noGroupBanner.hidden.1")).toBe("1");
    } finally { restore(); }
  });

  it("a failed «دیگر نشان نده» keeps the banner visible and says it was not saved", async () => {
    const restore = screenSize(false);
    try {
      const m = mockFetch(base([user()], { ...due, "POST /users/no-group-alert/dismiss": () => json(500, { detail: "x" }) }));
      renderApp("/users");
      await userEvent.click(await screen.findByRole("button", { name: "دیگر نشان نده" }));
      expect(await screen.findByRole("button", { name: "ثبت نشد" })).toBeDisabled();
      expect(screen.getByRole("status")).toBeInTheDocument();
      expect(m.count("POST /users/no-group-alert/dismiss")).toBe(1);
      expect(sessionStorage.getItem("ems.noGroupBanner.hidden.1")).toBeNull();
    } finally { restore(); }
  });

  it("is read again after the users list changed (the server lowers its stored count only when it sees the lower count)", async () => {
    const restore = screenSize(false);
    try {
      const m = mockFetch(base([user()], { ...due, "PUT /users/2/groups": () => json(200, user({ group_ids: [1] })) }));
      renderApp("/users");
      await screen.findByRole("status");
      const before = m.count("GET /users/no-group-alert");
      await userEvent.click(await screen.findByRole("button", { name: /عملیات/ }));
      await userEvent.click(await screen.findByRole("menuitem", { name: /گروه/ }));
      await userEvent.click(await screen.findByRole("button", { name: /ذخیره/ }));
      await waitFor(() => expect(m.count("GET /users/no-group-alert")).toBeGreaterThan(before));
    } finally { restore(); }
  });

  it("«closed for this session» is cleared by sign-out and sign-in", () => {
    sessionStorage.setItem("ems.noGroupBanner.hidden.1", "1");
    sessionStorage.setItem("other", "x");
    clearNoGroupBannerFlags();
    expect(sessionStorage.getItem("ems.noGroupBanner.hidden.1")).toBeNull();
    expect(sessionStorage.getItem("other")).toBe("x");
  });

  it("is not shown (and not requested) for AUDITOR", async () => {
    const restore = screenSize(false);
    try {
      const m = mockFetch({ ...base([user({ mobile: null })], due), ...session(makeUser({ id: 9, username: "aud", role_code: "AUDITOR", role_label_fa: "بازرس ارشد" })) });
      renderApp("/users");
      await screen.findByText("علی رضایی");
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(m.count("GET /users/no-group-alert")).toBe(0);
    } finally { restore(); }
  });

  it("also appears on the landing page (reports list) for MANAGEMENT", async () => {
    mockFetch({
      ...session(), "GET /users/no-group-alert": () => json(200, { count: 2, show: true }),
      "GET /reports": () => json(200, { items: [], next_cursor: null, other_group_reports_may_exist: false }),
      "GET /reports/columns": () => json(200, []), "GET /groups": () => page([group()]), "GET /report-types": () => json(200, []),
    });
    renderApp("/reports");
    expect(await screen.findByRole("status")).toHaveTextContent("۲ نفر");
  });
});

describe("HelpHint", () => {
  const open = async () => { render(<HelpHint label="راهنما">متن راهنما</HelpHint>); await userEvent.click(screen.getByRole("button", { name: "راهنما" })); return screen.findByRole("dialog"); };

  it("a click opens a dialog with the text, and it stays (no timer)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const dlg = await open();
    expect(within(dlg).getByText("متن راهنما")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("hovering opens nothing", async () => {
    render(<HelpHint label="راهنما">متن راهنما</HelpHint>);
    await userEvent.hover(screen.getByRole("button", { name: "راهنما" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("متن راهنما")).not.toBeInTheDocument();
  });

  it.each([["بستن"], ["×"]])("closes with the «%s» button", async (name) => {
    const dlg = await open();
    await userEvent.click(within(dlg).getByRole("button", { name }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("closes with Esc", async () => {
    await open();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("closes with a click outside the dialog", async () => {
    await open();
    await userEvent.click(document.querySelector(".MuiBackdrop-root") as Element);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
