import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { json, makeUser, mockFetch, renderApp, resetClientState, tokenBody } from "../../test/utils";
import type { PersonnelBatchPerson, PersonnelCancelPreview, PersonnelImportBatch } from "../../api/types";
import { canCancel, exemptLines, importedOfTotal, personName, reloadSize, statusLabel } from "./personnelHistory";
import { personnelErrorMessage } from "./personnelImportMessages";
import { ApiError } from "../../api/http";

beforeEach(() => resetClientState());
afterEach(() => resetClientState());

const ts = "2026-03-20T20:30:00";
const batch = (o: Partial<PersonnelImportBatch> = {}): PersonnelImportBatch => ({
  id: 1, kind: "PERSONNEL", file_name: "staff.xlsx", created_at: ts, created_by_name: "مدیر سامانه", created_count: 25, rejected_count: 2,
  removed_count: 0, remaining_count: 25, status: "complete", undone_at: null, ...o,
});
const person = (o: Partial<PersonnelBatchPerson> = {}): PersonnelBatchPerson => ({
  id: 7, first_name: "علی", last_name: "رضایی", full_name: "علی رضایی", personnel_code: 1234, group_codes: ["ELV"], is_active: true, has_profile: false, mobile: "09121234567", ...o,
});
const preview = (o: Partial<PersonnelCancelPreview> = {}): PersonnelCancelPreview => ({
  batch_id: 1, remaining_count: 25, removable_count: 22, exempt_count: 3, exempt_reasons: { profile: 1, reports: 2, participation: 0, stars: 0 }, fingerprint: "f".repeat(64), ...o,
});
const page = <T,>(items: T[], total = items.length, offset = 0) => json(200, { items, total, limit: 25, offset });
const open = async (name = "staff.xlsx") => userEvent.click(await screen.findByRole("button", { name: `جزئیات ورود ${name}` }));
const empty = () => page([]);
const session = (u = makeUser()) => ({ "POST /auth/refresh": () => json(200, tokenBody(u)) });

const asPhone = () => { const original = window.matchMedia; window.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia; return () => { window.matchMedia = original; }; };

describe("import history helpers", () => {
  it("shows imported rows out of all rows, the status labels and when a cancel is possible", () => {
    expect(importedOfTotal({ created_count: 25, rejected_count: 2 })).toBe("۲۵ از ۲۷");
    expect(statusLabel("complete")).toBe("بدون لغو");
    expect(statusLabel("partial")).toBe("بخشی لغو شده");
    expect(statusLabel("cancelled")).toBe("کامل لغو شده");
    expect(canCancel({ remaining_count: 1 })).toBe(true);
    expect(canCancel({ remaining_count: 0 })).toBe(false);
  });

  it("lists only the reasons that apply; names show the code when there is one; a reload keeps what is shown within the server limit", () => {
    expect(exemptLines({ profile: 0, reports: 0, participation: 0, stars: 0 })).toEqual([]);
    expect(exemptLines({ profile: 1, reports: 2, participation: 3, stars: 4 })).toHaveLength(4);
    expect(exemptLines({ profile: 0, reports: 0, participation: 3, stars: 0 })).toEqual(["۳ نفر در گزارشی ساعت کار دارند"]);
    expect(personName({ full_name: "علی رضایی", personnel_code: 12 })).toBe("علی رضایی (۱۲)");
    expect(personName({ full_name: "علی رضایی", personnel_code: null })).toBe("علی رضایی");
    expect(reloadSize(3)).toBe(25);
    expect(reloadSize(60)).toBe(60);
    expect(reloadSize(500)).toBe(100);
  });

  it("has Persian texts for the three history error codes", () => {
    for (const code of ["batch_changed", "nothing_to_cancel", "import_batch_not_found"]) {
      expect(personnelErrorMessage(new ApiError(409, code))).not.toBe(code);
    }
  });
});

describe("import history page", () => {
  it("lists batches with «X از Y» and an explicit status on every row; the details of a fully cancelled batch offer no cancel", async () => {
    mockFetch({
      ...session(),
      "GET /personnel/import/batches": () => page([
        batch({ id: 1 }),
        batch({ id: 2, file_name: "b.xlsx", status: "partial", removed_count: 5, remaining_count: 20 }),
        batch({ id: 3, file_name: "c.xlsx", status: "cancelled", removed_count: 25, remaining_count: 0 }),
      ]),
      "GET /personnel/import/batches/3/people": empty,
    });
    renderApp("/personnel/import/history");
    await screen.findByText("staff.xlsx");
    expect(screen.getAllByText(/۲۵ از ۲۷ ردیف وارد شد/)).toHaveLength(3);
    expect(screen.getByText("بدون لغو")).toBeInTheDocument();
    expect(screen.getByText("بخشی لغو شده")).toBeInTheDocument();
    expect(screen.getByText("کامل لغو شده")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "لغو" })).not.toBeInTheDocument();      // no buttons on the rows: the row itself opens the details
    expect(screen.queryByRole("button", { name: "افراد" })).not.toBeInTheDocument();
    await open("c.xlsx");
    expect(await screen.findByText("از این ورود فردی باقی نمانده که قابل لغو باشد.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "لغو این ورود…" })).not.toBeInTheDocument();
  });

  it("«نمایش بیشتر» loads the next 25 and appends them", async () => {
    const first = Array.from({ length: 25 }, (_, i) => batch({ id: 100 - i, file_name: `f${100 - i}.xlsx` }));
    const m = mockFetch({
      ...session(),
      "GET /personnel/import/batches": (c) => c.query.get("offset") === "25" ? page([batch({ id: 7, file_name: "last.xlsx" })], 26, 25) : page(first, 26),
    });
    renderApp("/personnel/import/history");
    await screen.findByText("f100.xlsx");
    await userEvent.click(screen.getByRole("button", { name: "نمایش بیشتر" }));
    await screen.findByText("last.xlsx");
    expect(screen.getByText("f100.xlsx")).toBeInTheDocument();
    const second = m.calls.filter((c) => c.path === "/personnel/import/batches")[1];
    expect(second.query.get("limit")).toBe("25");
    expect(screen.queryByRole("button", { name: "نمایش بیشتر" })).not.toBeInTheDocument();
  });

  it("the cancel needs the preview and the tick, sends the fingerprint, then shows who was removed and reloads", async () => {
    let sent: unknown = null;
    const m = mockFetch({
      ...session(),
      "GET /personnel/import/batches": () => page([batch()]),
      "GET /personnel/import/batches/1/people": empty,
      "POST /personnel/import/batches/1/cancel-preview": () => json(200, preview()),
      "POST /personnel/import/batches/1/cancel": (c) => { sent = c.body; return json(200, { batch_id: 1, removed_count: 22, kept_count: 3 }); },
    });
    renderApp("/personnel/import/history");
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "لغو این ورود…" }));
    expect(await screen.findByText(/۲۲ نفر حذف می‌شوند/)).toBeInTheDocument();
    expect(screen.getByText("۱ نفر پروفایل ورود دارند")).toBeInTheDocument();
    expect(screen.getByText("۲ نفر گزارش ثبت کرده‌اند")).toBeInTheDocument();
    const go = screen.getByRole("button", { name: "لغو ورود" });
    expect(go).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox"));
    expect(go).toBeEnabled();
    await userEvent.click(go);
    expect(await screen.findByText("۲۲ نفر حذف شد و ۳ نفر ماند.")).toBeInTheDocument();
    expect(sent).toEqual({ fingerprint: "f".repeat(64) });
    expect(m.count("GET /personnel/import/batches")).toBe(2);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("when the batch changed (409) nothing is deleted, the numbers are reloaded, the tick is cleared and the manager must confirm again", async () => {
    let n = 0;
    const m = mockFetch({
      ...session(),
      "GET /personnel/import/batches": () => page([batch()]),
      "GET /personnel/import/batches/1/people": empty,
      "POST /personnel/import/batches/1/cancel-preview": () => json(200, ++n === 1 ? preview() : preview({ removable_count: 20, exempt_count: 5 })),
      "POST /personnel/import/batches/1/cancel": () => json(409, { detail: { code: "batch_changed" } }),
    });
    renderApp("/personnel/import/history");
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "لغو این ورود…" }));
    await screen.findByText(/۲۲ نفر حذف می‌شوند/);
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "لغو ورود" }));
    expect(await screen.findByText(/چیزی حذف نشد/)).toBeInTheDocument();
    expect(await screen.findByText(/۲۰ نفر حذف می‌شوند/)).toBeInTheDocument();
    expect(m.count("POST /personnel/import/batches/1/cancel-preview")).toBe(2);
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "لغو ورود" })).toBeDisabled();
    expect(m.count("POST /personnel/import/batches/1/cancel")).toBe(1);     // never repeated on its own
  });

  it("when nobody can be removed the dialog says so and offers no confirmation", async () => {
    mockFetch({
      ...session(),
      "GET /personnel/import/batches": () => page([batch({ status: "partial", removed_count: 5, remaining_count: 3 })]),
      "GET /personnel/import/batches/1/people": empty,
      "POST /personnel/import/batches/1/cancel-preview": () => json(200, preview({ remaining_count: 3, removable_count: 0, exempt_count: 3, exempt_reasons: { profile: 3, reports: 0, participation: 0, stars: 0 } })),
    });
    renderApp("/personnel/import/history");
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "لغو این ورود…" }));
    expect(await screen.findByText("هیچ‌کس قابل حذف نیست.")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "لغو ورود" })).toBeDisabled();
  });

  it("people: 25 per page from the server, the current database data; on a phone the mobile numbers appear only on request", async () => {
    const m = mockFetch({
      ...session(),
      "GET /personnel/import/batches": () => page([batch()]),
      "GET /personnel/import/batches/1/people": () => page([person(), person({ id: 8, full_name: "سارا نظری", personnel_code: null, group_codes: [], is_active: false, has_profile: true, mobile: "09351112233" })], 30),
    });
    const restore = asPhone();
    try {
    renderApp("/personnel/import/history");
    await open();
    const dlg = await screen.findByRole("dialog");
    await within(dlg).findByText("علی رضایی (۱۲۳۴)");
    expect(within(dlg).getByText("سارا نظری")).toBeInTheDocument();
    expect(within(dlg).getByText("بدون گروه")).toBeInTheDocument();
    expect(within(dlg).getByText("غیرفعال")).toBeInTheDocument();
    expect(within(dlg).getByText("دارای پروفایل")).toBeInTheDocument();
    const q = m.calls.find((c) => c.path === "/personnel/import/batches/1/people")!.query;
    expect([q.get("limit"), q.get("offset")]).toEqual(["25", "0"]);
    expect(within(dlg).queryByText("09121234567")).not.toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("button", { name: "نمایش شماره‌ها" }));
    expect(within(dlg).getByText("09121234567")).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("button", { name: "پنهان کردن شماره‌ها" }));
    expect(within(dlg).queryByText("09121234567")).not.toBeInTheDocument();
    } finally { restore(); }
  });

  it("people: the next page asks the server for the next 25", async () => {
    const m = mockFetch({
      ...session(),
      "GET /personnel/import/batches": () => page([batch()]),
      "GET /personnel/import/batches/1/people": (c) => c.query.get("offset") === "25" ? page([person({ id: 99, full_name: "نفر صفحه دوم", personnel_code: 5 })], 30, 25) : page([person()], 30),
    });
    renderApp("/personnel/import/history");
    await open();
    const dlg = await screen.findByRole("dialog");
    await within(dlg).findByText("علی رضایی (۱۲۳۴)");
    await userEvent.click(within(dlg).getByRole("button", { name: /next page|صفحهٔ بعد|Go to next page/i }));
    expect(await within(dlg).findByText("نفر صفحه دوم (۵)")).toBeInTheDocument();
    const last = m.calls.filter((c) => c.path === "/personnel/import/batches/1/people").at(-1)!;
    expect([last.query.get("limit"), last.query.get("offset")]).toEqual(["25", "25"]);
  });

  it("people: while the next page loads or fails, the previous page's people are not shown as the selected page (CodeRabbit)", async () => {
    mockFetch({
      ...session(),
      "GET /personnel/import/batches": () => page([batch()]),
      "GET /personnel/import/batches/1/people": (c) => c.query.get("offset") === "25" ? json(500, { detail: { code: "internal_error" } }) : page([person()], 30),
    });
    renderApp("/personnel/import/history");
    await open();
    const dlg = await screen.findByRole("dialog");
    await within(dlg).findByText("علی رضایی (۱۲۳۴)");
    await userEvent.click(within(dlg).getByRole("button", { name: /next page|صفحهٔ بعد|Go to next page/i }));
    await within(dlg).findByRole("alert");
    expect(within(dlg).queryByText("علی رضایی (۱۲۳۴)")).not.toBeInTheDocument();
  });

  it("a late cancel answer for batch A does not close the dialog of batch B, but still refreshes the list (CodeRabbit)", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const m = mockFetch({
      ...session(),
      "GET /personnel/import/batches": () => page([batch({ id: 1 }), batch({ id: 2, file_name: "b.xlsx" })]),
      "GET /personnel/import/batches/1/people": empty,
      "GET /personnel/import/batches/2/people": empty,
      "POST /personnel/import/batches/1/cancel-preview": () => json(200, preview()),
      "POST /personnel/import/batches/1/cancel": async () => { await gate; return json(200, { batch_id: 1, removed_count: 22, kept_count: 3 }); },
    });
    renderApp("/personnel/import/history");
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "لغو این ورود…" }));
    await screen.findByText(/۲۲ نفر حذف می‌شوند/);
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "لغو ورود" }));       // A's request is now pending
    await userEvent.click(screen.getByRole("button", { name: "بستن" }));
    await open("b.xlsx");
    await screen.findByRole("dialog", { name: /b\.xlsx/ });
    release();
    await screen.findByText("۲۲ نفر حذف شد و ۳ نفر ماند.");
    expect(screen.getByRole("dialog", { name: /b\.xlsx/ })).toBeInTheDocument();
    expect(m.count("GET /personnel/import/batches")).toBe(2);
  });

  it("an older, slower answer never replaces a newer one", async () => {
    let n = 0;
    mockFetch({
      ...session(),
      "GET /personnel/import/batches": async () => {
        if (++n === 1) { await new Promise((r) => setTimeout(r, 80)); return page([batch({ id: 1, file_name: "old.xlsx" })]); }
        return page([batch({ id: 2, file_name: "new.xlsx" })]);
      },
    });
    renderApp("/personnel/import/history", { strict: true });   // StrictMode runs the first load twice
    await screen.findByText("new.xlsx");
    await new Promise((r) => setTimeout(r, 150));
    expect(screen.queryByText("old.xlsx")).not.toBeInTheDocument();
    expect(screen.getByText("new.xlsx")).toBeInTheDocument();
  });

  it("on a desktop screen the mobile numbers are shown at once and there is no reveal button", async () => {
    mockFetch({
      ...session(),
      "GET /personnel/import/batches": () => page([batch()]),
      "GET /personnel/import/batches/1/people": () => page([person()]),
    });
    renderApp("/personnel/import/history");
    await open();
    const dlg = await screen.findByRole("dialog");
    expect(await within(dlg).findByText("09121234567")).toBeInTheDocument();
    expect(within(dlg).queryByRole("button", { name: "نمایش شماره‌ها" })).not.toBeInTheDocument();
  });

  it("the import page links to the history with the agreed label; the history page is for MANAGEMENT only", async () => {
    mockFetch({ ...session(), "GET /groups": () => json(200, { items: [], total: 0, limit: 100, offset: 0 }) });
    renderApp("/personnel/import");
    expect(await screen.findByRole("link", { name: "تاریخچهٔ ورود گروهی" })).toHaveAttribute("href", "/personnel/import/history");
    cleanup();
    resetClientState();
    mockFetch({ ...session(makeUser({ role_code: "AUDITOR", username: "aud" })), "GET /reports": () => json(200, { items: [], next_cursor: null, other_group_reports_may_exist: false }), "GET /reports/columns": () => json(200, []) });
    renderApp("/personnel/import/history");
    await screen.findByRole("link", { name: "گزارش‌ها" });
    await waitFor(() => expect(screen.queryByText("تاریخچهٔ ورود گروهی افراد")).not.toBeInTheDocument());
  });
});
