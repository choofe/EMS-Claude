import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { json, makeUser, mockFetch, renderApp, resetClientState, tokenBody } from "../test/utils";
import { emptyState } from "../pages/report/reportForm";
import { makeSnapshot, saveLocal, saveUndo } from "../lib/localDraft";

beforeEach(() => resetClientState());
afterEach(() => resetClientState());

const ts = "2026-03-20T20:30:00";
const cfg = { default_labor_minutes: 30, max_participant_minutes: 1440, max_participants: 30, max_description_length: 5000, future_tolerance_minutes: 5, groups: [] };
const ali = makeUser({ id: 2, username: "ali", full_name: "علی رضایی", role_code: "USER", role_label_fa: "کاربر", group_ids: [1] });
const sara = makeUser({ id: 8, username: "sara", full_name: "سارا", role_code: "USER", role_label_fa: "کاربر", group_ids: [1] });
const work = (text: string) => ({ ...emptyState(new Date("2026-03-21T11:00:00Z")), description: text, typeId: 5 as const });
const keep = (userId: number, text: string) => { saveLocal(makeSnapshot(userId, work(text), { draftId: null, version: null })); saveUndo(makeSnapshot(userId, work("undo " + text), { draftId: null, version: null })); };

const app = (user = ali, over: Record<string, () => Response | Promise<Response>> = {}) => ({
  "POST /auth/refresh": () => json(200, tokenBody(user)),
  "GET /reports/entry-config": () => json(200, cfg),
  "GET /report-types": () => json(200, [{ id: 5, code: "T", name_fa: "تعمیر خرابی جزئی", is_failure: true, labor_mode: "REQUIRED", equipment_mode: "REQUIRED", help_fa: null, is_active: true, created_at: ts, updated_at: ts }]),
  "GET /reports/drafts": () => json(200, []),
  "GET /reports/equipment-quick-pick": () => json(200, { recent: [], frequent: [] }),
  "GET /equipment": () => json(200, { items: [], total: 0, limit: 20, offset: 0 }),
  "POST /reports/heartbeat": () => json(200, { ok: true, server_time: ts }),
  "POST /auth/logout": () => json(204),
  ...over,
}) as never;

const openMenu = async () => userEvent.click(await screen.findByRole("button", { name: "حساب کاربری" }));

describe("explicit sign-out discards the report draft (server + this device)", () => {
  it("with unsaved work on this device it asks first; cancelling changes nothing", async () => {
    keep(2, "کار نیمه‌تمام");
    const m = mockFetch(app());
    renderApp("/reports/new");
    await openMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: "خروج" }));
    expect(await screen.findByText(/با خروج حذف می‌شود/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "انصراف" }));
    await waitFor(() => expect(screen.queryByText(/با خروج حذف می‌شود/)).not.toBeInTheDocument());
    expect(m.count("POST /auth/logout")).toBe(0);
    expect(localStorage.getItem("ems.reportForm.2")).not.toBeNull();
  });

  it("confirming deletes the server draft, the local copy and the undo copy, and signs out", async () => {
    keep(2, "کار نیمه‌تمام");
    const m = mockFetch(app(ali, {
      "GET /reports/drafts": () => json(200, [{ id: 5, payload: {}, version: 2, created_at: ts, updated_at: ts }]),
      "DELETE /reports/drafts/5": () => json(204),
    }));
    renderApp("/reports/new");
    await openMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: "خروج" }));
    await userEvent.click(await screen.findByRole("button", { name: "خروج و حذف پیش‌نویس" }));
    expect(await screen.findByRole("heading", { name: "ورود به سامانه" })).toBeInTheDocument();
    expect(m.count("DELETE /reports/drafts/5")).toBe(1);
    expect(m.count("POST /auth/logout")).toBe(1);
    expect(localStorage.getItem("ems.reportForm.2")).toBeNull();
    expect(localStorage.getItem("ems.reportForm.undo.2")).toBeNull();
  });

  it("without local work no question is asked; the server draft is still removed", async () => {
    const m = mockFetch(app(ali, {
      "GET /reports/drafts": () => json(200, [{ id: 5, payload: {}, version: 2, created_at: ts, updated_at: ts }]),
      "DELETE /reports/drafts/5": () => json(204),
    }));
    renderApp("/reports/new");
    await openMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: "خروج" }));
    expect(await screen.findByRole("heading", { name: "ورود به سامانه" })).toBeInTheDocument();
    expect(m.count("DELETE /reports/drafts/5")).toBe(1);
  });

  it("offline or slow: signing out still works (the server draft just stays)", async () => {
    const m = mockFetch(app(ali, { "GET /reports/drafts": () => json(503, {}), "POST /auth/logout": () => json(204) }));
    renderApp("/reports/new");
    await openMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: "خروج" }));
    expect(await screen.findByRole("heading", { name: "ورود به سامانه" })).toBeInTheDocument();
    expect(m.count("POST /auth/logout")).toBe(1);
  });
});

describe("session end vs another person signing in", () => {
  it("an EXPIRED session keeps the local copy, and the same user gets it back after signing in again", async () => {
    keep(2, "متن نیمه‌تمام قبل از انقضا");
    let loggedIn = false;
    mockFetch(app(ali, {
      "POST /auth/refresh": () => (loggedIn ? json(200, tokenBody(ali)) : json(401, { detail: "invalid_refresh_token" })),
      "POST /auth/login": () => { loggedIn = true; return json(200, tokenBody(ali)); },
    }));
    renderApp("/reports/new");
    await userEvent.type(await screen.findByLabelText("نام کاربری"), "ali");
    expect(localStorage.getItem("ems.reportForm.2")).not.toBeNull(); // login page shown, copy untouched
    await userEvent.type(screen.getByLabelText("رمز عبور"), "pw-pw-pw-pw");
    await userEvent.click(screen.getByRole("button", { name: "ورود" }));
    expect(await screen.findByText(/نسخه‌ی ذخیره‌نشده‌ی این دستگاه .* بازیابی شد/)).toBeInTheDocument();
    expect(screen.getByLabelText("شرح گزارش")).toHaveValue("متن نیمه‌تمام قبل از انقضا");
  });

  it("a DIFFERENT user signing in deletes the previous user's copy (and never sees it)", async () => {
    keep(2, "متن علی");
    let loggedIn = false;
    mockFetch(app(sara, {
      "POST /auth/refresh": () => (loggedIn ? json(200, tokenBody(sara)) : json(401, { detail: "invalid_refresh_token" })),
      "POST /auth/login": () => { loggedIn = true; return json(200, tokenBody(sara)); },
    }));
    renderApp("/reports/new");
    await userEvent.type(await screen.findByLabelText("نام کاربری"), "sara");
    await userEvent.type(screen.getByLabelText("رمز عبور"), "pw-pw-pw-pw");
    await userEvent.click(screen.getByRole("button", { name: "ورود" }));
    expect(await screen.findByRole("radiogroup", { name: "نوع گزارش" })).toBeInTheDocument();
    expect(screen.queryByLabelText("شرح گزارش")).not.toBeInTheDocument();
    expect(localStorage.getItem("ems.reportForm.2")).toBeNull();
    expect(localStorage.getItem("ems.reportForm.undo.2")).toBeNull();
  });
});

describe("the report-types page is for management/auditor only", () => {
  it("a USER has no menu entry and is redirected away from /report-types", async () => {
    mockFetch(app());
    renderApp("/report-types");
    await screen.findByRole("navigation", { name: "منوی اصلی" });
    expect(screen.queryByRole("link", { name: "انواع گزارش" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "انواع گزارش" })).not.toBeInTheDocument();
  });
  it("MANAGEMENT keeps it", async () => {
    mockFetch({ ...(app(makeUser()) as object), "GET /report-types": () => json(200, []), "GET /dashboard/summary": () => json(200, { active_users: 0, inactive_users: 0, active_equipment: 0, inactive_equipment: 0, active_groups: 0, groups: [] }) } as never);
    renderApp("/report-types");
    expect(await screen.findByRole("heading", { name: "انواع گزارش" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "انواع گزارش" })).toBeInTheDocument();
  });
});
