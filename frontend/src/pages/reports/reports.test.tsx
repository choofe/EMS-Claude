import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { render } from "@testing-library/react";
import { ThemeProvider } from "@mui/material";
import { theme } from "../../theme/theme";
import { ReportDetailPage } from "./ReportDetailPage";
import { json, makeUser, mockFetch, renderApp, resetClientState, tokenBody } from "../../test/utils";
import type { ReportColumn, ReportDetail, ReportListItem } from "../../api/types";
import { dayBound } from "./ReportsListPage";

beforeEach(() => resetClientState());
afterEach(() => resetClientState());

const ts = "2026-03-20T10:00:00Z";
const col = (key: string, label_fa: string, o: Partial<ReportColumn> = {}): ReportColumn => ({ key, label_fa, default_visible: true, sortable: false, ...o });
const COLUMNS = [
  col("report_number", "شماره گزارش"), col("event_datetime", "زمان رخداد", { sortable: true }), col("report_type", "نوع گزارش"), col("equipment", "تجهیز"),
  col("creator", "ثبت‌کننده"), col("description_summary", "شرح"), col("created_at", "زمان ثبت", { default_visible: false, sortable: true }),
  col("my_minutes", "زمان من"), col("total_minutes", "جمع زمان کار", { default_visible: false }),
];
const item = (o: Partial<ReportListItem> = {}): ReportListItem => ({
  id: 1, report_number: "05-ELV-001", event_datetime: ts, created_at: ts, group: { id: 1, code: "ELV", name: "آسانسور" },
  report_type: { id: 5, code: "MINOR", name_fa: "خرابی جزئی", is_failure: true }, equipment: { id: 10, code: "ELV-001" }, is_general: false,
  creator: { id: 2, full_name: "علی رضایی" }, description_summary: "تعویض فیوز", is_locked: false, my_minutes: 90, total_minutes: null, people_count: null, ...o,
});
const detail = (o: Partial<ReportDetail> = {}): ReportDetail => ({
  ...item(), description: "شرح کامل گزارش", locked_at: null, participants: [{ user_id: 1, full_name: "مدیر سامانه", minutes: 90, is_me: true }], participants_complete: false, ...o,
});
const page = (items: ReportListItem[], next_cursor: string | null = null, other = false) => ({ items, next_cursor, other_group_reports_may_exist: other });
const routes = (role = "EXPERT") => ({
  "POST /auth/refresh": () => json(200, tokenBody(makeUser({ role_code: role, username: role.toLowerCase() }))),
  "GET /reports/columns": () => json(200, COLUMNS),
  "GET /report-types": () => json(200, []),
  "GET /groups": () => json(200, { items: [], total: 0, limit: 100, offset: 0 }),
});
const listCalls = (m: ReturnType<typeof mockFetch>) => m.calls.filter((c) => c.method === "GET" && c.path === "/reports");

describe("reports list", () => {
  it("shows only the default columns from the server registry, a general report with its marker, and a dash for hidden labor", async () => {
    mockFetch({ ...routes(), "GET /reports": () => json(200, page([item(), item({ id: 2, report_number: "05-ELV-002", equipment: null, is_general: true, my_minutes: null })])) });
    renderApp("/reports");
    expect(await screen.findByText("05-ELV-001")).toHaveAttribute("dir", "ltr");
    expect(screen.getByRole("columnheader", { name: "زمان من" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "زمان ثبت" })).not.toBeInTheDocument();   // default_visible = false
    expect(screen.queryByRole("columnheader", { name: "جمع زمان کار" })).not.toBeInTheDocument();
    expect(screen.getAllByText("عمومی (بدون تجهیز)")).toHaveLength(1);
    expect(screen.getByText("۱ ساعت و ۳۰ دقیقه")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "05-ELV-001" })).toHaveAttribute("href", "/reports/1");
  });

  it("«بیشتر» appends the next page using the cursor and disappears when there is none", async () => {
    let n = 0;
    const m = mockFetch({ ...routes(), "GET /reports": (c) => (c.query.get("cursor") ? (++n, json(200, page([item({ id: 2, report_number: "05-ELV-002" })]))) : json(200, page([item()], "CUR1"))) });
    renderApp("/reports");
    await screen.findByText("05-ELV-001");
    await userEvent.click(screen.getByRole("button", { name: "بیشتر" }));
    expect(await screen.findByText("05-ELV-002")).toBeInTheDocument();
    expect(screen.getByText("05-ELV-001")).toBeInTheDocument();
    expect(listCalls(m).some((c) => c.query.get("cursor") === "CUR1")).toBe(true);
    expect(screen.queryByRole("button", { name: "بیشتر" })).not.toBeInTheDocument();
  });

  it("a «بیشتر» answer that arrives after the filters changed is dropped (it belongs to the old list)", async () => {
    let release: (r: Response) => void = () => {};
    mockFetch({
      ...routes(),
      "GET /reports": (c) => (c.query.get("cursor") ? new Promise<Response>((res) => { release = res; }) : json(200, page(c.query.get("mine") ? [item({ id: 9, report_number: "05-ELV-009" })] : [item()], c.query.get("mine") ? null : "CUR1"))),
    });
    renderApp("/reports");
    await screen.findByText("05-ELV-001");
    await userEvent.click(screen.getByRole("button", { name: "بیشتر" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "مشارکت من" }));
    expect(await screen.findByText("05-ELV-009")).toBeInTheDocument();
    release(json(200, page([item({ id: 2, report_number: "05-ELV-002" })])));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("05-ELV-002")).not.toBeInTheDocument();
  });

  it("a failing «بیشتر» that settles after the filters changed neither shows its error nor blocks the new list's button", async () => {
    let fail: (r: Response) => void = () => {};
    mockFetch({
      ...routes(),
      "GET /reports": (c) => (c.query.get("cursor") ? new Promise<Response>((res) => { fail = res; }) : json(200, page([item({ id: c.query.get("mine") ? 9 : 1, report_number: c.query.get("mine") ? "05-ELV-009" : "05-ELV-001" })], "CUR1"))),
    });
    renderApp("/reports");
    await screen.findByText("05-ELV-001");
    await userEvent.click(screen.getByRole("button", { name: "بیشتر" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "مشارکت من" }));
    await screen.findByText("05-ELV-009");
    expect(screen.getByRole("button", { name: "بیشتر" })).toBeEnabled();   // the old request is still pending, yet the new list is not blocked
    fail(json(422, { detail: "invalid_cursor" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/صفحه‌بندی نامعتبر/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "بیشتر" })).toBeEnabled();
  });

  it("sends filters to the API, reloads from page one, and sorts by a sortable header", async () => {
    const m = mockFetch({ ...routes(), "GET /reports": () => json(200, page([item()], "CUR1")) });
    renderApp("/reports");
    await screen.findByText("05-ELV-001");
    await userEvent.type(screen.getByLabelText("شماره گزارش"), "ELV-0");
    await userEvent.click(screen.getByRole("checkbox", { name: "مشارکت من" }));
    await waitFor(() => expect(listCalls(m).some((c) => c.query.get("report_number") === "ELV-0" && c.query.get("mine") === "true" && !c.query.get("cursor"))).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "زمان رخداد" }));
    await waitFor(() => expect(listCalls(m).some((c) => c.query.get("order") === "asc" && c.query.get("sort_by") === "event_datetime")).toBe(true));
  });

  it("the sort selector (the only sort control on a phone) sends sort_by/order", async () => {
    const m = mockFetch({ ...routes(), "GET /reports": () => json(200, page([item()])) });
    renderApp("/reports");
    await screen.findByText("05-ELV-001");
    await userEvent.click(screen.getByRole("combobox", { name: "مرتب‌سازی" }));
    await userEvent.click(screen.getByRole("option", { name: "قدیمی‌ترین ثبت" }));
    await waitFor(() => expect(listCalls(m).some((c) => c.query.get("sort_by") === "created_at" && c.query.get("order") === "asc")).toBe(true));
  });

  it("an invalid Jalali date is reported and NOT sent; a valid one is sent as an aware UTC instant", async () => {
    const m = mockFetch({ ...routes(), "GET /reports": () => json(200, page([item()])) });
    renderApp("/reports");
    await screen.findByText("05-ELV-001");
    await userEvent.type(screen.getByLabelText("از تاریخ (شمسی)"), "1405/13/40");
    expect(await screen.findByText(/تاریخ شمسی معتبر نیست/)).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 450));
    expect(listCalls(m).every((c) => !c.query.get("date_from"))).toBe(true);
    await userEvent.clear(screen.getByLabelText("از تاریخ (شمسی)"));
    await userEvent.type(screen.getByLabelText("از تاریخ (شمسی)"), "1405/01/01");
    await waitFor(() => expect(listCalls(m).some((c) => /^\d{4}-\d\d-\d\dT.*Z$/.test(c.query.get("date_from") ?? ""))).toBe(true));
    expect(dayBound("", false)).toBe("");
    expect(dayBound("1405/01/01", true)! > dayBound("1405/01/01", false)!).toBe(true);
  });

  it("equipment history = the same list filtered by equipment_id, with a removable chip and the moved-equipment notice", async () => {
    const m = mockFetch({ ...routes(), "GET /reports": (c) => json(200, page([item()], null, c.query.get("equipment_id") === "10")) });
    renderApp("/reports?equipment_id=10&equipment=ELV-001");
    expect(await screen.findByText("تاریخچه تجهیز ELV-001")).toBeInTheDocument();
    expect(await screen.findByText("ممکن است گزارش‌هایی از گروه قبلی وجود داشته باشد.")).toBeInTheDocument();
    expect(listCalls(m)[0].query.get("equipment_id")).toBe("10");
    await userEvent.click(within(screen.getByText("تاریخچه تجهیز ELV-001").closest(".MuiChip-root") as HTMLElement).getByTestId("CancelIcon"));
    await waitFor(() => expect(screen.queryByText("تاریخچه تجهیز ELV-001")).not.toBeInTheDocument());
    expect(screen.queryByText(/گروه قبلی/)).not.toBeInTheDocument();
  });

  it("on a phone the same rows render as cards (number, equipment or general marker, summary, own minutes) linking to the detail", async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
    try {
      mockFetch({ ...routes(), "GET /reports": () => json(200, page([item(), item({ id: 2, report_number: "05-ELV-002", equipment: null, is_general: true })])) });
      renderApp("/reports");
      const card = (await screen.findByText("05-ELV-001")).closest("a") as HTMLElement;
      expect(card).toHaveAttribute("href", "/reports/1");
      expect(within(card).getByText("تعویض فیوز")).toBeInTheDocument();
      expect(within(card).getByText(/زمان من: ۱ ساعت و ۳۰ دقیقه/)).toBeInTheDocument();
      expect(screen.getAllByText("عمومی (بدون تجهیز)")).toHaveLength(1);
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
      // filters start hidden on a phone behind one button; the badge counts active filters; «پاک کردن» resets them
      expect(screen.queryByLabelText("شماره گزارش")).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "فیلتر و مرتب‌سازی" }));
      await userEvent.type(screen.getByLabelText("شماره گزارش"), "ELV");
      await userEvent.click(screen.getByRole("checkbox", { name: "فقط عمومی" }));
      expect(screen.getByText("2")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "پاک کردن فیلترها" }));
      expect(screen.getByLabelText("شماره گزارش")).toHaveValue("");
      expect(screen.queryByRole("button", { name: "پاک کردن فیلترها" })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "فیلتر و مرتب‌سازی" }));
      expect(screen.queryByLabelText("شماره گزارش")).not.toBeInTheDocument();
    } finally { window.matchMedia = original; }
  });

  it("the report-entry button is for roles that may report, never for the auditor", async () => {
    mockFetch({ ...routes("AUDITOR"), "GET /reports": () => json(200, page([])) });
    renderApp("/reports");
    expect(await screen.findByText("گزارشی پیدا نشد.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ثبت گزارش" })).not.toBeInTheDocument();
  });

  it("shows the server error in Persian and keeps the page usable", async () => {
    mockFetch({ ...routes(), "GET /reports": () => json(422, { detail: "invalid_cursor" }) });
    renderApp("/reports");
    expect(await screen.findByText(/صفحه‌بندی نامعتبر/)).toBeInTheDocument();
  });
});

describe("report detail", () => {
  it("labor is collapsed behind a button; a viewer who may see only his own row gets «my» wording and the note after opening", async () => {
    mockFetch({ ...routes(), "GET /reports/1": () => json(200, detail()), "GET /reports": () => json(200, page([])) });
    renderApp("/reports/1");
    expect(await screen.findByRole("heading", { name: "گزارش 05-ELV-001" })).toBeInTheDocument();
    expect(screen.queryByText(/مدیر سامانه/)).not.toBeInTheDocument();                           // collapsed by default
    await userEvent.click(screen.getByRole("button", { name: "دیدن ساعت کاری من" }));
    expect(screen.getByText("فقط ردیف مربوط به خودتان نمایش داده می‌شود.")).toBeInTheDocument();
    expect(screen.getByText(/مدیر سامانه \(شما\)/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "پنهان کردن ساعات کاری" }));
    expect(screen.queryByText(/مدیر سامانه/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ELV-001" })).toHaveAttribute("href", "/reports?equipment_id=10&equipment=ELV-001");
    expect(screen.queryByText("عمومی (بدون تجهیز)")).not.toBeInTheDocument();
  });

  it("a viewer who may see NO labor row gets no labor section at all (neither a button nor a «no labor» claim); general reports carry the marker", async () => {
    mockFetch({ ...routes(), "GET /reports/1": () => json(200, detail({ participants: [], participants_complete: false, equipment: null, is_general: true })) });
    renderApp("/reports/1");
    expect(await screen.findByText("عمومی (بدون تجهیز)")).toBeInTheDocument();
    expect(screen.queryByText(/ساعت کاری|ساعات کاری|زمان کار/)).not.toBeInTheDocument();
  });

  it("a report with a complete, empty labor list says so instead of showing a button", async () => {
    mockFetch({ ...routes(), "GET /reports/1": () => json(200, detail({ participants: [], participants_complete: true })) });
    renderApp("/reports/1");
    expect(await screen.findByText("برای این گزارش ساعت کاری ثبت نشده است.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /ساعات کاری|ساعت کاری/ })).not.toBeInTheDocument();
  });

  it("a complete list opens with all participants and no «own row only» note", async () => {
    mockFetch({ ...routes(), "GET /reports/2": () => json(200, detail({ id: 2, participants_complete: true, participants: [{ user_id: 7, full_name: "حسین", minutes: 60, is_me: false }] })) });
    renderApp("/reports/2");
    await userEvent.click(await screen.findByRole("button", { name: "دیدن ساعات کاری ثبت‌شده" }));
    expect(screen.getByText("حسین")).toBeInTheDocument();
    expect(screen.queryByText(/فقط ردیف/)).not.toBeInTheDocument();
  });

  it("a failed load never leaves a previously shown report on screen", async () => {
    mockFetch({ ...routes(), "GET /reports/1": () => json(404, { detail: "report_not_found" }) });
    renderApp("/reports/1");
    expect(await screen.findByText("گزارش پیدا نشد یا اجازهٔ دیدن آن را ندارید.")).toBeInTheDocument();
    expect(screen.queryByText("شرح کامل گزارش")).not.toBeInTheDocument();
  });

  it("a 404 (missing, not yours, or deleted) shows one neutral message; a non-numeric id never calls the API", async () => {
    const m = mockFetch({ ...routes(), "GET /reports/9": () => json(404, { detail: "report_not_found" }) });
    renderApp("/reports/9");
    expect(await screen.findByText("گزارش پیدا نشد یا اجازهٔ دیدن آن را ندارید.")).toBeInTheDocument();
    resetClientState();
    const m2 = mockFetch(routes());
    renderApp("/reports/abc");
    expect(await screen.findByText("گزارش پیدا نشد یا اجازهٔ دیدن آن را ندارید.")).toBeInTheDocument();
    expect(m2.calls.some((c) => c.path.startsWith("/reports/"))).toBe(false);
    expect(m.count("GET /reports/9")).toBe(1);
  });

  it("navigating from one report to another never shows the first report under the second URL, even if the second answer is slow or fails", async () => {
    let answer2: (r: Response) => void = () => {};
    mockFetch({ "GET /reports/1": () => json(200, detail()), "GET /reports/2": () => new Promise<Response>((res) => { answer2 = res; }) });
    const Go = () => { const nav = useNavigate(); return <button onClick={() => nav("/reports/2")}>go</button>; };
    render(
      <ThemeProvider theme={theme}>
        <MemoryRouter initialEntries={["/reports/1"]}>
          <Routes><Route path="/reports/:id" element={<><Go /><ReportDetailPage /></>} /></Routes>
        </MemoryRouter>
      </ThemeProvider>,
    );
    expect(await screen.findByText("شرح کامل گزارش")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "go" }));
    await waitFor(() => expect(screen.queryByText("شرح کامل گزارش")).not.toBeInTheDocument());   // while 2 is loading
    answer2(json(404, { detail: "report_not_found" }));
    expect(await screen.findByText("گزارش پیدا نشد یا اجازهٔ دیدن آن را ندارید.")).toBeInTheDocument();
    expect(screen.queryByText("شرح کامل گزارش")).not.toBeInTheDocument();                         // and after 2 failed
  });
});
