import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { json, makeUser, mockFetch, renderApp, resetClientState, tokenBody } from "../test/utils";

beforeEach(() => resetClientState());
afterEach(() => resetClientState());

const session = (u = makeUser()) => ({ "POST /auth/refresh": () => json(200, tokenBody(u)) });
const reports = { "GET /reports": () => json(200, { items: [], next_cursor: null, other_group_reports_may_exist: false }), "GET /reports/columns": () => json(200, []) };
const nav = () => screen.getByRole("navigation", { name: "منوی اصلی" });

describe("bulk-import menu group", () => {
  it("MANAGEMENT: one collapsed group «ورود گروهی» that opens to the three import pages", async () => {
    mockFetch({ ...session(), ...reports });
    renderApp("/reports");
    const group = await screen.findByRole("button", { name: "ورود گروهی" });
    expect(group).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "ورود گروهی افراد" })).not.toBeInTheDocument();
    await userEvent.click(group);
    expect(group).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: "ورود گروهی تجهیزات" })).toHaveAttribute("href", "/equipment/import");
    expect(screen.getByRole("link", { name: "ورود گروهی افراد" })).toHaveAttribute("href", "/personnel/import");
    expect(screen.getByRole("link", { name: "تاریخچهٔ ورود گروهی افراد" })).toHaveAttribute("href", "/personnel/import/history");
    await userEvent.click(group);
    expect(group).toHaveAttribute("aria-expanded", "false");
  });

  it("the group opens by itself on an import page and only the current page is highlighted", async () => {
    mockFetch({ ...session(), "GET /personnel/import/batches": () => json(200, { items: [], total: 0, limit: 25, offset: 0 }) });
    renderApp("/personnel/import/history");
    const history = await screen.findByRole("link", { name: "تاریخچهٔ ورود گروهی افراد" });
    expect(history).toHaveClass("active");
    expect(screen.getByRole("link", { name: "ورود گروهی افراد" })).not.toHaveClass("active");
    expect(screen.getByRole("button", { name: "ورود گروهی" })).toHaveAttribute("aria-expanded", "true");
  });

  it("moving into an import page from the page's own link re-opens a group the manager had closed", async () => {
    mockFetch({
      ...session(),
      "GET /groups": () => json(200, { items: [], total: 0, limit: 100, offset: 0 }),
      "GET /personnel/import/batches": () => json(200, { items: [], total: 0, limit: 25, offset: 0 }),
    });
    renderApp("/personnel/import");
    const group = await screen.findByRole("button", { name: "ورود گروهی" });
    await userEvent.click(group);
    expect(group).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(screen.getByRole("link", { name: "تاریخچهٔ ورود گروهی" }));
    await screen.findByText("هنوز ورود گروهی انجام نشده است.");
    expect(screen.getByRole("button", { name: "ورود گروهی" })).toHaveAttribute("aria-expanded", "true");
  });

  it("people who are not MANAGEMENT see no import entries", async () => {
    mockFetch({ ...session(makeUser({ role_code: "EXPERT", username: "ex" })), ...reports });
    renderApp("/reports");
    await screen.findByRole("link", { name: "گزارش‌ها" });
    expect(nav()).not.toHaveTextContent("ورود گروهی");
  });
});
