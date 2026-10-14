import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { json, makeUser, mockFetch, renderApp, resetClientState, tokenBody } from "./test/utils";

const summary = { active_users: 5, inactive_users: 1, active_equipment: 7, inactive_equipment: 0, active_groups: 2, groups: [{ id: 1, code: "ELV", name: "آسانسور", active_equipment: 7, active_members: 3 }] };
const emptyPage = { items: [], total: 0, limit: 25, offset: 0 };

beforeEach(() => resetClientState());
afterEach(() => resetClientState());

const baseRoutes = (user = makeUser()) => ({
  "POST /auth/refresh": () => json(200, tokenBody(user)),
  "GET /dashboard/summary": () => json(200, summary),
  "GET /groups": () => json(200, emptyPage),
  "GET /equipment": () => json(200, emptyPage),
  "GET /report-types": () => json(200, []),
  "GET /users": () => json(200, emptyPage),
  "GET /roles": () => json(200, []),
});

describe("session bootstrap and route guards", () => {
  it("anonymous visitor is sent to the login page", async () => {
    mockFetch({ "POST /auth/refresh": () => json(401, { detail: "invalid_refresh_token" }) });
    renderApp("/users");
    expect(await screen.findByRole("heading", { name: "ورود به سامانه" })).toBeInTheDocument();
    expect(screen.getByText(/با مدیر سیستم تماس بگیرید/)).toBeInTheDocument();
  });

  it("restores the session from the refresh cookie and shows the dashboard (MANAGEMENT)", async () => {
    mockFetch(baseRoutes());
    renderApp("/");
    expect(await screen.findByText("کاربران فعال")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "تنظیمات" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "کاربران" })).toBeInTheDocument();
  });

  it("React StrictMode double-mount performs only ONE refresh (rotation would otherwise log the user out)", async () => {
    const m = mockFetch(baseRoutes());
    renderApp("/", { strict: true });
    await screen.findByText("کاربران فعال");
    expect(m.count("POST /auth/refresh")).toBe(1);
  });

  it("a pending forced password change redirects every page to /change-password", async () => {
    mockFetch(baseRoutes(makeUser({ must_change_password: true })));
    renderApp("/users");
    expect(await screen.findByRole("heading", { name: "تغییر رمز عبور" })).toBeInTheDocument();
    expect(screen.getByText("برای ادامه باید رمز عبور خود را تغییر دهید.")).toBeInTheDocument();
  });

  it("AUDITOR: sees users/dashboard but not settings; cannot open /settings; no write buttons", async () => {
    mockFetch({ ...baseRoutes(makeUser({ username: "aud", role_code: "AUDITOR", role_label_fa: "بازرس ارشد" })), "GET /users": () => json(200, { ...emptyPage, items: [], total: 0 }) });
    renderApp("/settings");
    expect(await screen.findByText("کاربران فعال")).toBeInTheDocument();           // bounced to the dashboard
    expect(screen.queryByRole("link", { name: "تنظیمات" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "کاربران" }));
    expect(await screen.findByRole("heading", { name: "کاربران" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /کاربر جدید/ })).not.toBeInTheDocument();
  });

  it("USER/EXPERT land on equipment and get no admin navigation", async () => {
    mockFetch(baseRoutes(makeUser({ username: "ali", role_code: "USER", role_label_fa: "کاربر" })));
    renderApp("/");
    expect(await screen.findByRole("heading", { name: "تجهیزات" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "کاربران" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "تنظیمات" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /تجهیز جدید/ })).not.toBeInTheDocument();
  });
});

describe("login", () => {
  it("shows the Persian message for wrong credentials and lets the user retry", async () => {
    let ok = false;
    mockFetch({
      "POST /auth/refresh": () => json(401, { detail: "invalid_refresh_token" }),
      "POST /auth/login": () => (ok ? json(200, tokenBody(makeUser())) : json(401, { detail: "invalid_credentials" })),
      "GET /dashboard/summary": () => json(200, summary),
    });
    renderApp("/");
    await userEvent.type(await screen.findByLabelText("نام کاربری"), "boss");
    await userEvent.type(screen.getByLabelText("رمز عبور"), "wrong-pass");
    await userEvent.click(screen.getByRole("button", { name: "ورود" }));
    expect(await screen.findByText("نام کاربری یا رمز عبور نادرست است.")).toBeInTheDocument();
    ok = true;
    await userEvent.click(screen.getByRole("button", { name: "ورود" }));
    expect(await screen.findByText("کاربران فعال")).toBeInTheDocument();
  });

  it("explains lockout using Retry-After", async () => {
    mockFetch({
      "POST /auth/refresh": () => json(401, { detail: "x" }),
      "POST /auth/login": () => json(429, { detail: "too_many_attempts" }, { "Retry-After": "600" }),
    });
    renderApp("/login");
    await userEvent.type(await screen.findByLabelText("نام کاربری"), "boss");
    await userEvent.type(screen.getByLabelText("رمز عبور"), "pw");
    await userEvent.click(screen.getByRole("button", { name: "ورود" }));
    expect(await screen.findByText(/۱۰ دقیقه/)).toBeInTheDocument();
  });

  it("logout clears the session and returns to the login page", async () => {
    const m = mockFetch({ ...baseRoutes(), "POST /auth/logout": () => json(204) });
    renderApp("/");
    await screen.findByText("کاربران فعال");
    await userEvent.click(screen.getByRole("button", { name: "حساب کاربری" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "خروج" }));
    expect(await screen.findByRole("heading", { name: "ورود به سامانه" })).toBeInTheDocument();
    expect(m.count("POST /auth/logout")).toBe(1);
    expect(m.calls.find((c) => c.path === "/auth/logout")!.headers.get("X-Requested-With")).toBe("ems-web");
  });
});

describe("forced password change flow", () => {
  it("validates the confirmation, shows policy errors in Persian, then enters the app", async () => {
    let attempts = 0;
    mockFetch({
      ...baseRoutes(makeUser({ must_change_password: true })),
      "POST /auth/change-password": () => (++attempts === 1
        ? json(422, { detail: { code: "password_policy", errors: ["too_short"] } })
        : json(200, tokenBody(makeUser()))),
    });
    renderApp("/");
    await userEvent.type(await screen.findByLabelText("رمز عبور فعلی"), "old-password-1");
    await userEvent.type(screen.getByLabelText("رمز عبور جدید"), "short");
    await userEvent.type(screen.getByLabelText("تکرار رمز عبور جدید"), "different");
    expect(screen.getByText("تکرار رمز با رمز جدید یکسان نیست.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ذخیره رمز جدید" })).toBeDisabled();
    await userEvent.clear(screen.getByLabelText("تکرار رمز عبور جدید"));
    await userEvent.type(screen.getByLabelText("تکرار رمز عبور جدید"), "short");
    await userEvent.click(screen.getByRole("button", { name: "ذخیره رمز جدید" }));
    expect(await screen.findByText(/کوتاه‌تر از حد مجاز/)).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("رمز عبور جدید"));
    await userEvent.clear(screen.getByLabelText("تکرار رمز عبور جدید"));
    await userEvent.type(screen.getByLabelText("رمز عبور جدید"), "a-much-longer-passphrase");
    await userEvent.type(screen.getByLabelText("تکرار رمز عبور جدید"), "a-much-longer-passphrase");
    await userEvent.click(screen.getByRole("button", { name: "ذخیره رمز جدید" }));
    await waitFor(() => expect(screen.getByText("کاربران فعال")).toBeInTheDocument());
  });
});
