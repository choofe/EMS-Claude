import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { json, makeUser, mockFetch, renderApp, resetClientState, tokenBody } from "../../test/utils";
import type { PersonnelPreview } from "../../api/types";
import { ApiError } from "../../api/http";
import { buildCorrections, canCommit, MAX_CORRECTIONS, sampleAfterFixes, setDrop, setTokenFix, summarize, templateCsv } from "./personnelImportState";
import { importedProblemsCsv, personnelErrorMessage, personnelRowReason, RESTART_CODES } from "./personnelImportMessages";

beforeEach(() => resetClientState());
afterEach(() => resetClientState());

const ts = "2026-03-20T20:30:00";
const g = (id: number, code: string, name: string, is_active = true) => ({ id, code, name, description: null, is_active, equipment_count: 0, member_count: 0, created_at: ts, updated_at: ts });
const SHA = "b".repeat(64);
const pv = (o: Partial<PersonnelPreview> = {}): PersonnelPreview => ({
  file_name: "p.xlsx", file_sha256: SHA, rows_total: 5, valid_count: 3, error_count: 2, group_issue_count: 2, ignored_columns: [],
  errors: [
    { row: 5, personnel_code: "12", code: "mobile_taken" },
    { row: 6, personnel_code: "13", code: "duplicate_personnel_code_in_file", first_row: 2 },
  ],
  group_issues: [
    { row: 3, personnel_code: 11, invalid_groups: [{ token: "ELEV", reason: "unknown" }, { token: "XX", reason: "unknown" }] },
    { row: 4, personnel_code: 14, invalid_groups: [{ token: "OLD", reason: "inactive" }] },
  ],
  sample: [{ row: 2, personnel_code: 10, full_name: "علی رضایی", group_codes: ["ELV"] }], ...o,
});

describe("personnel import state", () => {
  it("counts importable people, undecided rows and dropped rows; commit needs every code decided", () => {
    const p = pv();
    expect(summarize(p, {})).toEqual({ importable: 3, dropped: 0, unresolvedRows: 2, unresolvedTokens: 3 });
    expect(canCommit(summarize(p, {}))).toBe(false);
    let f = setTokenFix({}, 3, "ELEV", { op: "replace", to: "ELV" });
    expect(summarize(p, f).unresolvedTokens).toBe(2);
    f = setTokenFix(f, 3, "XX", { op: "remove" });
    f = setDrop(f, 4, true);
    const s = summarize(p, f);
    expect(s).toEqual({ importable: 2, dropped: 1, unresolvedRows: 0, unresolvedTokens: 0 });
    expect(canCommit(s)).toBe(true);
    expect(canCommit({ ...s, importable: 0 })).toBe(false);
  });

  it("a dropped row sends only `drop`; undoing a decision removes it; unknown rows are never sent", () => {
    const p = pv();
    let f = setTokenFix({}, 3, "ELEV", { op: "replace", to: "ELV" });
    f = setTokenFix(f, 3, "XX", { op: "remove" });
    f = setTokenFix(f, 99, "Q", { op: "remove" });
    expect(buildCorrections(p, f)).toEqual([
      { row: 3, op: "replace", token: "ELEV", to: "ELV" },
      { row: 3, op: "remove", token: "XX" },
    ]);
    expect(buildCorrections(p, setDrop(f, 3, true))).toEqual([{ row: 3, op: "drop" }]);
    expect(buildCorrections(p, setDrop(setDrop(f, 3, true), 3, false))).toHaveLength(2);
    expect(buildCorrections(p, setTokenFix(f, 3, "XX", null))).toHaveLength(1);
  });

  it("token names that exist on Object.prototype are ordinary tokens (CodeRabbit)", () => {
    const p = pv({ group_issues: [{ row: 3, personnel_code: 11, invalid_groups: [{ token: "constructor", reason: "unknown" }, { token: "__proto__", reason: "unknown" }] }] });
    const f = setTokenFix({}, 3, "__proto__", { op: "remove" });
    expect(summarize(p, f).unresolvedTokens).toBe(1);            // `constructor` is still undecided
    expect(buildCorrections(p, f)).toEqual([{ row: 3, op: "remove", token: "__proto__" }]);
    expect(summarize(p, setTokenFix(f, 3, "constructor", { op: "remove" })).unresolvedRows).toBe(0);
  });

  it("commit is blocked above the server's corrections limit, and invalid_corrections does not restart the page", () => {
    const ok = { importable: 5, dropped: 0, unresolvedRows: 0, unresolvedTokens: 0 };
    expect(canCommit(ok, MAX_CORRECTIONS)).toBe(true);
    expect(canCommit(ok, MAX_CORRECTIONS + 1)).toBe(false);
    expect(RESTART_CODES.has("invalid_corrections")).toBe(false);
    expect(RESTART_CODES.has("import_conflict")).toBe(true);
    expect(RESTART_CODES.has("group_issues_unresolved")).toBe(true);
  });

  it("the report of a finished import is built from the commit answer, with spreadsheet-safe cells and no mobile column", async () => {
    const buf = await new Promise<ArrayBuffer>((res) => { const r = new FileReader(); r.onload = () => res(r.result as ArrayBuffer); r.readAsArrayBuffer(importedProblemsCsv([{ row: 5, personnel_code: "=1+1", code: "mobile_taken" }])); });
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf);
    expect(text.split("\r\n")[0]).toBe("\ufeffrow,personnel_code,problem_code,description_fa");
    expect(text).toContain('"\'=1+1"');
    expect(text).not.toMatch(/mobile\b[^_]/);
  });

  it("a dropped row leaves the sample and a replaced group code joins the person's groups", () => {
    const p = pv({ sample: [
      { row: 2, personnel_code: 10, full_name: "علی رضایی", group_codes: ["ELV"] },
      { row: 3, personnel_code: 11, full_name: "سارا احمدی", group_codes: ["ESC"] },
      { row: 4, personnel_code: 14, full_name: "رضا کریمی", group_codes: [] },
    ] });
    expect(sampleAfterFixes(p, {})).toEqual(p.sample);
    const f = setTokenFix({}, 3, "ELEV", { op: "replace", to: "ELV" });
    expect(sampleAfterFixes(p, f)[1].group_codes).toEqual(["ESC", "ELV"]);
    const dropped = sampleAfterFixes(p, setDrop(f, 4, true));
    expect(dropped.map((s) => s.row)).toEqual([2, 3]);
    expect(sampleAfterFixes(p, setDrop({}, 3, true)).map((s) => s.row)).toEqual([2, 4]);
  });

  it("the empty template is a BOM-prefixed header line with the five columns", async () => {
    const buf = await new Promise<ArrayBuffer>((res) => { const r = new FileReader(); r.onload = () => res(r.result as ArrayBuffer); r.readAsArrayBuffer(templateCsv()); });
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf);
    expect(text).toBe("\ufefffirst_name,last_name,personnel_code,groups,mobile\r\n");
  });

  it("maps the personnel texts of the shared codes, and row reasons carry their extras", () => {
    expect(personnelErrorMessage(new ApiError(409, "import_conflict"))).toMatch(/هیچ‌کس وارد نشد/);
    expect(personnelErrorMessage(new ApiError(422, "group_issues_unresolved"))).toMatch(/هیچ‌کس وارد نشد/);
    expect(personnelErrorMessage(new ApiError(422, "too_many_rows", { max_rows: 1000 }))).toMatch(/۱۰۰۰/);
    expect(personnelRowReason({ row: 6, personnel_code: "13", code: "duplicate_personnel_code_in_file", first_row: 2 })).toMatch(/ردیف ۲/);
    expect(personnelRowReason({ row: 6, personnel_code: "", code: "too_many_groups", max_groups: 20 })).toMatch(/۲۰/);
  });
});

const session = (u = makeUser()) => ({ "POST /auth/refresh": () => json(200, tokenBody(u)) });
const file = () => new File(["x"], "p.xlsx");
async function pick(container: HTMLElement) {
  await screen.findByRole("button", { name: "بررسی فایل" });
  await userEvent.upload(container.querySelector("input[type=file]") as HTMLInputElement, file());
}
const groups = () => json(200, { items: [g(1, "ELV", "آسانسور"), g(2, "OLD", "قدیمی", false), g(3, "ESC", "پله برقی")], total: 3, limit: 100, offset: 0 });

describe("personnel import page", () => {
  it("shows the two lists, blocks commit until every code is decided, sends the corrections with the previewed digest", async () => {
    let committed: FormData | null = null;
    const m = mockFetch({
      ...session(),
      "GET /groups": groups,
      "POST /personnel/import/preview": () => json(200, pv()),
      "POST /personnel/import/commit": (c) => { committed = c.body as FormData; return json(201, { ...pv({ group_issues: [], group_issue_count: 0, dropped_count: 1 }), batch_id: 9, created_count: 2 }); },
    });
    const { container } = renderApp("/personnel/import");
    await pick(container);
    await userEvent.click(screen.getByRole("button", { name: "بررسی فایل" }));

    const bad = await screen.findByRole("table", { name: /ردیف‌های نامعتبر/ });
    expect(within(bad).getByText(/این شماره موبایل از قبل در سیستم وجود دارد/)).toBeInTheDocument();
    expect(within(bad).getByText(/ردیف ۲\)/)).toBeInTheDocument();
    expect(screen.getByText("قابل ورود: ۳")).toBeInTheDocument();
    expect(screen.getByText("نیازمند تعیین‌تکلیف: ۲")).toBeInTheDocument();
    const commit = screen.getByRole("button", { name: /ورود ۳ نفر/ });
    expect(commit).toBeDisabled();
    expect(screen.getByText("ردیف تعیین‌تکلیف‌نشده دارید")).toBeInTheDocument();

    // replace ELEV with an ACTIVE group only (the inactive group is not offered)
    await userEvent.click(screen.getAllByRole("combobox", { name: /جایگزینی با گروه/ })[0]);
    expect(screen.queryByRole("option", { name: /قدیمی/ })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("option", { name: /آسانسور/ }));
    await userEvent.click(screen.getByRole("button", { name: "حذف XX ردیف 3" }));
    expect(screen.getByText("نیازمند تعیین‌تکلیف: ۱")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ورود ۳ نفر/ })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "حذف ردیف 4" }));
    expect(screen.getByText("قابل ورود: ۲")).toBeInTheDocument();
    const go = screen.getByRole("button", { name: /ورود ۲ نفر/ });
    expect(go).toBeEnabled();

    await userEvent.click(go);
    await userEvent.click(await screen.findByRole("button", { name: "ورود به سامانه" }));
    await screen.findByText(/۲ نفر ثبت شد/);
    expect(m.count("POST /personnel/import/preview")).toBe(1);
    URL.createObjectURL = () => "blob:x"; URL.revokeObjectURL = () => undefined;
    await userEvent.click(await screen.findByRole("button", { name: "دانلود ردیف‌های واردنشده (CSV)" }));
    expect(m.count("POST /personnel/import/problems.csv")).toBe(0);   // never re-analysed after the people exist
    const f = committed as unknown as FormData;
    expect(f.get("preview_sha256")).toBe(SHA);
    expect(JSON.parse(String(f.get("corrections")))).toEqual([
      { row: 3, op: "replace", token: "ELEV", to: "ELV" },
      { row: 3, op: "remove", token: "XX" },
      { row: 4, op: "drop" },
    ]);
    expect((f.get("file") as File).name).toBe("p.xlsx");
  });

  it("after import_conflict nothing is kept: the page shows the personnel text and starts over", async () => {
    mockFetch({
      ...session(), "GET /groups": groups,
      "POST /personnel/import/preview": () => json(200, pv({ group_issues: [], group_issue_count: 0 })),
      "POST /personnel/import/commit": () => json(409, { detail: { code: "import_conflict" } }),
    });
    const { container } = renderApp("/personnel/import");
    await pick(container);
    await userEvent.click(screen.getByRole("button", { name: "بررسی فایل" }));
    await userEvent.click(await screen.findByRole("button", { name: /ورود ۳ نفر/ }));
    await userEvent.click(await screen.findByRole("button", { name: "ورود به سامانه" }));
    expect(await screen.findByText(/هیچ‌کس وارد نشد/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: /ورود ۳ نفر/ })).not.toBeInTheDocument());
    expect(screen.getByText("فایلی انتخاب نشده است")).toBeInTheDocument();
  });

  it("the problem report is requested by POST with the file and the CURRENT corrections", async () => {
    let sent: FormData | null = null;
    mockFetch({
      ...session(), "GET /groups": groups,
      "POST /personnel/import/preview": () => json(200, pv()),
      "POST /personnel/import/problems.csv": (c) => { sent = c.body as FormData; return new Response("row\r\n", { status: 200, headers: { "content-type": "text/csv" } }); },
    });
    URL.createObjectURL = () => "blob:x"; URL.revokeObjectURL = () => undefined;
    const { container } = renderApp("/personnel/import");
    await pick(container);
    await userEvent.click(screen.getByRole("button", { name: "بررسی فایل" }));
    await userEvent.click(await screen.findByRole("button", { name: "حذف ردیف 4" }));
    await userEvent.click(screen.getByRole("button", { name: "دانلود گزارش مشکلات (CSV)" }));
    await waitFor(() => expect(sent).not.toBeNull());
    expect(JSON.parse(String((sent as unknown as FormData).get("corrections")))).toEqual([{ row: 4, op: "drop" }]);
  });

  it("loads every page of groups, so an active group beyond the first 100 can be chosen (CodeRabbit)", async () => {
    const all = Array.from({ length: 130 }, (_, i) => g(i + 1, `G${String(i + 1).padStart(3, "0")}`, `گروه ${i + 1}`));
    const m = mockFetch({
      ...session(),
      "GET /groups": (c) => { const off = Number(c.query.get("offset") ?? 0); return json(200, { items: all.slice(off, off + 100), total: 130, limit: 100, offset: off }); },
      "POST /personnel/import/preview": () => json(200, pv()),
    });
    const { container } = renderApp("/personnel/import");
    await pick(container);
    await userEvent.click(screen.getByRole("button", { name: "بررسی فایل" }));
    await waitFor(() => expect(m.count("GET /groups")).toBe(2));
    await userEvent.click((await screen.findAllByRole("combobox", { name: /جایگزینی با گروه/ }))[0]);
    expect(await screen.findByRole("option", { name: /G130/ })).toBeInTheDocument();
  });

  it("invalid_corrections keeps the file and the manager's decisions and explains the limit", async () => {
    mockFetch({
      ...session(), "GET /groups": groups,
      "POST /personnel/import/preview": () => json(200, pv({ group_issues: [{ row: 3, personnel_code: 11, invalid_groups: [{ token: "XX", reason: "unknown" }] }], group_issue_count: 1 })),
      "POST /personnel/import/commit": () => json(422, { detail: { code: "invalid_corrections" } }),
    });
    const { container } = renderApp("/personnel/import");
    await pick(container);
    await userEvent.click(screen.getByRole("button", { name: "بررسی فایل" }));
    await userEvent.click(await screen.findByRole("button", { name: "حذف XX ردیف 3" }));
    await userEvent.click(screen.getByRole("button", { name: /ورود ۳ نفر/ }));
    await userEvent.click(await screen.findByRole("button", { name: "ورود به سامانه" }));
    expect(await screen.findByText(/از حد مجاز بیشتر است/)).toBeInTheDocument();
    expect(screen.getByText("p.xlsx")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /ورود ۳ نفر/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: "بازگردانی XX ردیف 3" })).toBeInTheDocument();
  });

  it("group_issues_unresolved means the preview is stale: start over and reload the group choices (CodeRabbit)", async () => {
    const m = mockFetch({
      ...session(), "GET /groups": groups,
      "POST /personnel/import/preview": () => json(200, pv({ group_issues: [], group_issue_count: 0 })),
      "POST /personnel/import/commit": () => json(422, { detail: { code: "group_issues_unresolved" } }),
    });
    const { container } = renderApp("/personnel/import");
    await pick(container);
    await userEvent.click(screen.getByRole("button", { name: "بررسی فایل" }));
    await userEvent.click(await screen.findByRole("button", { name: /ورود ۳ نفر/ }));
    await userEvent.click(await screen.findByRole("button", { name: "ورود به سامانه" }));
    expect(await screen.findByText(/وضعیت گروه‌ها پس از پیش‌نمایش تغییر کرده است/)).toBeInTheDocument();
    expect(screen.getByText("فایلی انتخاب نشده است")).toBeInTheDocument();
    await waitFor(() => expect(m.count("GET /groups")).toBe(2));
  });

  it("a failed group list is shown with a retry action instead of an empty replacement list (CodeRabbit)", async () => {
    let calls = 0;
    const m = mockFetch({
      ...session(),
      "GET /groups": () => (++calls === 1 ? json(500, { detail: { code: "internal_error" } }) : groups()),
    });
    renderApp("/personnel/import");
    await screen.findByText(/فهرست گروه‌ها بارگذاری نشد/);
    await userEvent.click(screen.getByRole("button", { name: "تلاش دوباره" }));
    await waitFor(() => expect(screen.queryByText(/فهرست گروه‌ها بارگذاری نشد/)).not.toBeInTheDocument());
    expect(m.count("GET /groups")).toBe(2);
  });

  it("is a management-only page", async () => {
    mockFetch({ ...session(makeUser({ role_code: "EXPERT" })), "GET /reports": () => json(200, { items: [], next_cursor: null, other_group_reports_may_exist: false }), "GET /reports/columns": () => json(200, []) });
    renderApp("/personnel/import");
    await screen.findByRole("link", { name: "گزارش‌ها" });       // the authenticated redirect destination is rendered first
    expect(screen.queryByRole("heading", { name: "ورود گروهی افراد" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "بررسی فایل" })).not.toBeInTheDocument();
  });
});
