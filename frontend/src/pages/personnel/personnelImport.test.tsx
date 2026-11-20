import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { json, makeUser, mockFetch, renderApp, resetClientState, tokenBody } from "../../test/utils";
import type { PersonnelFileDuplicate, PersonnelPreview } from "../../api/types";
import { ApiError } from "../../api/http";
import { buildCorrections, canCommit, MAX_CORRECTIONS, sampleAfterFixes, setDrop, setTokenFix, summarize, personLabel, sameNamesAfterFixes, duplicateDrops, differingPositions } from "./personnelImportState";
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

  it("a bad code repeated in one cell (XX;XX) is ONE decision and ONE correction (CodeRabbit)", () => {
    const p = pv({ group_issues: [{ row: 3, personnel_code: 11, invalid_groups: [{ token: "XX", reason: "unknown" }, { token: "XX", reason: "unknown" }] }] });
    expect(summarize(p, {}).unresolvedTokens).toBe(1);
    const f = setTokenFix({}, 3, "XX", { op: "remove" });
    expect(summarize(p, f).unresolvedRows).toBe(0);
    expect(buildCorrections(p, f)).toEqual([{ row: 3, op: "remove", token: "XX" }]);
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
    const buf = await new Promise<ArrayBuffer>((res) => { const r = new FileReader(); r.onload = () => res(r.result as ArrayBuffer); r.readAsArrayBuffer(importedProblemsCsv([{ row: 5, first_name: "=cmd", last_name: "نظری", personnel_code: "=1+1", code: "mobile_taken" }])); });
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf);
    expect(text.split("\r\n")[0]).toBe("\ufeffrow,first_name,last_name,personnel_code,problem_code,description_fa");
    expect(text).toContain('"\'=1+1"');
    expect(text).toContain('"\'=cmd","نظری"');   // names get the spreadsheet-safe prefix too
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

  it("a person is shown as «last name (code)», the code alone when the name is absent", () => {
    expect(personLabel("نظری", 1321)).toBe("نظری (۱۳۲۱)");
    expect(personLabel(undefined, "12")).toBe("۱۲");
    expect(personLabel(null, null)).toBe("—");
    expect(personLabel("نظری", "")).toBe("نظری");
  });

  it("same-name rows dropped by a group decision leave the count; a truncated list is flagged", () => {
    const row = (r: number) => ({ row: r, first_name: "علی", last_name: "نظری", personnel_code: 20 + r, matches_total: 1, matches: [] });
    const p = pv({ same_name_count: 3, same_names: [row(3), row(4)] });
    expect(sameNamesAfterFixes(p, {})).toMatchObject({ count: 3, incomplete: true });
    const a = sameNamesAfterFixes(p, setDrop({}, 3, true));
    expect(a.count).toBe(2);
    expect(a.rows.map((r) => r.row)).toEqual([4]);
    expect(sameNamesAfterFixes(pv(), {})).toEqual({ count: 0, rows: [], incomplete: false });
  });

  it("choosing the second row drops the first; «neither» drops both; repeated rows are sent once; they come first in the corrections", () => {
    const pair = (w: number, l: number): PersonnelFileDuplicate => ({
      kind: "mobile", same_name: false,
      winner: { row: w, first_name: "الف", last_name: "ب", personnel_code: 1, group_codes: [] },
      loser: { row: l, first_name: "الف", last_name: "ب", personnel_code: 2, group_codes: [] },
    });
    expect(duplicateDrops([], pair(2, 3), "keep_second")).toEqual([2]);
    expect(duplicateDrops([2], pair(2, 4), "keep_second")).toEqual([2]);
    expect(duplicateDrops([], pair(2, 3), "none")).toEqual([2, 3]);
    expect(buildCorrections(pv(), setDrop({}, 4, true), [2])).toEqual([{ row: 2, op: "drop" }, { row: 4, op: "drop" }]);
  });

  it("marks the mobile digits that differ at the same position", () => {
    expect([...differingPositions("09123214587", "09143214587")]).toEqual([3]);
    expect(differingPositions("0912", undefined).size).toBe(0);
  });

  it("maps the personnel texts of the shared codes, and row reasons carry their extras", () => {
    expect(personnelErrorMessage(new ApiError(409, "import_conflict"))).toMatch(/هیچ‌کس وارد نشد/);
    expect(personnelErrorMessage(new ApiError(422, "group_issues_unresolved"))).toMatch(/هیچ‌کس وارد نشد/);
    expect(personnelErrorMessage(new ApiError(422, "too_many_rows", { max_rows: 1000 }))).toMatch(/۱۰۰۰/);
    expect(personnelRowReason({ row: 6, personnel_code: "13", code: "duplicate_personnel_code_in_file", first_row: 2 })).toMatch(/ردیف ۲/);
    expect(personnelRowReason({ row: 6, personnel_code: "", code: "too_many_groups", max_groups: 20 })).toMatch(/۲۰/);
    expect(personnelRowReason({ row: 6, personnel_code: "13", code: "duplicate_mobile_in_file", first_row: 2, same_name: true })).toMatch(/احتمالاً یک نفر با دو شاخص/);
    expect(personnelRowReason({ row: 6, personnel_code: "13", code: "duplicate_mobile_in_file", first_row: 2 })).not.toMatch(/احتمالاً/);
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

  it("while the group list is reloading or failed after a restart, no cached group is offered (CodeRabbit)", async () => {
    let calls = 0;
    mockFetch({
      ...session(),
      "GET /groups": () => (++calls === 1 ? groups() : json(500, { detail: { code: "internal_error" } })),
      "POST /personnel/import/preview": () => json(200, pv()),
      "POST /personnel/import/commit": () => json(409, { detail: { code: "import_conflict" } }),
    });
    const { container } = renderApp("/personnel/import");
    await pick(container);
    await userEvent.click(screen.getByRole("button", { name: "بررسی فایل" }));
    await userEvent.click(await screen.findByRole("button", { name: "حذف ردیف 3" }));
    await userEvent.click(screen.getByRole("button", { name: "حذف ردیف 4" }));
    await userEvent.click(await screen.findByRole("button", { name: /ورود ۱ نفر/ }));
    await userEvent.click(await screen.findByRole("button", { name: "ورود به سامانه" }));
    await screen.findByText(/فهرست گروه‌ها بارگذاری نشد/);          // the reload after the restart failed
    await pick(container);
    await userEvent.click(screen.getByRole("button", { name: "بررسی فایل" }));
    await userEvent.click((await screen.findAllByRole("combobox", { name: /جایگزینی با گروه/ }))[0]);
    expect(screen.queryByRole("option", { name: /آسانسور/ })).not.toBeInTheDocument();
  });

  it("lists show «last name (code)»; the Excel template is a plain link and the CSV template button is gone", async () => {
    mockFetch({
      ...session(), "GET /groups": groups,
      "POST /personnel/import/preview": () => json(200, pv({
        errors: [{ row: 5, first_name: "علی", last_name: "نظری", personnel_code: "1321", code: "mobile_taken" }, { row: 7, personnel_code: "", code: "missing_first_name" }],
        group_issues: [{ row: 3, first_name: "سارا", last_name: "احمدی", personnel_code: 11, invalid_groups: [{ token: "XX", reason: "unknown" }] }],
      })),
    });
    const { container } = renderApp("/personnel/import");
    const link = await screen.findByRole("link", { name: "قالب Excel" });
    expect(link.getAttribute("href")).toMatch(/personnel-import-template\.xlsx$/);
    expect(screen.queryByRole("button", { name: "قالب CSV" })).not.toBeInTheDocument();
    await pick(container);
    await userEvent.click(screen.getByRole("button", { name: "بررسی فایل" }));
    const bad = await screen.findByRole("table", { name: /ردیف‌های نامعتبر/ });
    expect(within(bad).getByText("نظری (۱۳۲۱)")).toBeInTheDocument();
    expect(within(bad).getAllByText("—").length).toBeGreaterThan(0);        // no name, no code: nothing to show
    expect(within(screen.getByRole("table", { name: "ردیف‌های نیازمند تعیین‌تکلیف" })).getByText("احمدی (۱۱)")).toBeInTheDocument();
  });

  it("the same-name notice does not block, opens a dialog with both mobile numbers, and a dropped row leaves it", async () => {
    const sn = { row: 3, first_name: "سارا", last_name: "احمدی", personnel_code: 11, mobile: "09123214587", matches_total: 7,
      matches: [{ full_name: "سارا احمدی", personnel_code: 9, group_codes: ["ELV"], is_active: true, has_profile: true, mobile: "09143214587" }] };
    mockFetch({
      ...session(), "GET /groups": groups,
      "POST /personnel/import/preview": () => json(200, pv({ same_name_count: 1, same_names: [sn] })),
    });
    const { container } = renderApp("/personnel/import");
    await pick(container);
    await userEvent.click(screen.getByRole("button", { name: "بررسی فایل" }));
    await screen.findByText(/۱ ردیف قابل ورود با فردی که از قبل در سیستم است هم‌نام است/);
    await userEvent.click(screen.getByRole("button", { name: "هم‌نام‌های موجود" }));
    const dlg = await screen.findByRole("dialog", { name: "هم‌نام‌های موجود" });
    expect(within(dlg).getByText(/ردیف ۳: سارا احمدی/)).toBeInTheDocument();
    expect(dlg.querySelectorAll("b").length).toBe(2);                 // the differing digit is marked on BOTH numbers
    expect(dlg.textContent).toContain("09123214587");
    expect(dlg.textContent).toContain("09143214587");
    expect(within(dlg).getByText("دارای پروفایل")).toBeInTheDocument();
    expect(within(dlg).getByText("و ۶ مورد دیگر")).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("button", { name: "بستن" }));
    await userEvent.click(await screen.findByRole("button", { name: "حذف ردیف 3" }));          // the row leaves the notice
    await waitFor(() => expect(screen.queryByText(/هم‌نام است/)).not.toBeInTheDocument());
  });

  it("choosing the second row of an in-file duplicate re-runs the preview with a drop of the first and keeps group decisions", async () => {
    const pair: PersonnelFileDuplicate = { kind: "mobile", same_name: true,
      winner: { row: 2, first_name: "علی", last_name: "رضایی", personnel_code: 10, group_codes: ["ELV"], mobile: "09121111111" },
      loser: { row: 4, first_name: "علی", last_name: "رضایی", personnel_code: 12, group_codes: [], mobile: "09121111111" } };
    const sent: (string | null)[] = [];
    let committed: FormData | null = null;
    mockFetch({
      ...session(), "GET /groups": groups,
      "POST /personnel/import/preview": (c) => {
        const corr = (c.body as FormData).get("corrections"); sent.push(corr === null ? null : String(corr));
        return json(200, corr === null ? pv({ file_duplicates: [pair] }) : pv({ valid_count: 3, dropped_count: 1, file_duplicates: [], errors: [] }));
      },
      "POST /personnel/import/commit": (c) => { committed = c.body as FormData; return json(201, { ...pv(), batch_id: 1, created_count: 2 }); },
    });
    const { container } = renderApp("/personnel/import");
    await pick(container);
    await userEvent.click(screen.getByRole("button", { name: "بررسی فایل" }));
    await userEvent.click(await screen.findByRole("button", { name: "حذف XX ردیف 3" }));      // a group decision made BEFORE the choice
    await userEvent.click(screen.getByRole("button", { name: "انتخاب ردیف" }));
    const dlg = await screen.findByRole("dialog", { name: "ردیف‌های تکراری در فایل" });
    expect(within(dlg).getByText("احتمالاً یک نفر با دو شاخص")).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("button", { name: "ورود ردیف 4 به‌جای ردیف 2" }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(JSON.parse(sent[1] as string)).toEqual([{ row: 2, op: "drop" }]);
    await waitFor(() => expect(screen.queryByRole("button", { name: "انتخاب ردیف" })).not.toBeInTheDocument());
    expect(await screen.findByRole("button", { name: "بازگردانی XX ردیف 3" })).toBeInTheDocument();   // the earlier decision survived
    expect(screen.getByText("کنار گذاشته‌شده: ۱")).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("combobox", { name: /جایگزینی با گروه/ })[0]);
    await userEvent.click(await screen.findByRole("option", { name: /آسانسور/ }));
    await userEvent.click(screen.getByRole("button", { name: "حذف ردیف 4" }));
    await userEvent.click(await screen.findByRole("button", { name: /ورود ۲ نفر/ }));
    await userEvent.click(await screen.findByRole("button", { name: "ورود به سامانه" }));
    await screen.findByText(/۲ نفر ثبت شد/);
    expect(JSON.parse(String((committed as unknown as FormData).get("corrections")))).toEqual([
      { row: 2, op: "drop" }, { row: 3, op: "replace", token: "ELEV", to: "ELV" }, { row: 3, op: "remove", token: "XX" }, { row: 4, op: "drop" },
    ]);
  });

  it("is a management-only page", async () => {
    mockFetch({ ...session(makeUser({ role_code: "EXPERT" })), "GET /reports": () => json(200, { items: [], next_cursor: null, other_group_reports_may_exist: false }), "GET /reports/columns": () => json(200, []) });
    renderApp("/personnel/import");
    await screen.findByRole("link", { name: "گزارش‌ها" });       // the authenticated redirect destination is rendered first
    expect(screen.queryByRole("heading", { name: "ورود گروهی افراد" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "بررسی فایل" })).not.toBeInTheDocument();
  });
});
