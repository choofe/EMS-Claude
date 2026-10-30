import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { json, makeUser, mockFetch, renderApp, resetClientState, tokenBody } from "../test/utils";
import type { ImportBatch, ImportPreview } from "../api/types";
import { errorsCsv, rowReason } from "./ImportPage";
import { errorMessage } from "../i18n/messages";
import { ApiError } from "../api/http";

beforeEach(() => resetClientState());
afterEach(() => resetClientState());

const ts = "2026-03-20T20:30:00";
const page = <T,>(items: T[]) => ({ items, total: items.length, limit: 10, offset: 0 });
const group = { id: 1, code: "ELV", name: "آسانسور", description: null, is_active: true, equipment_count: 0, member_count: 0, created_at: ts, updated_at: ts };
const SHA = "a".repeat(64);
const preview = (o: Partial<ImportPreview> = {}): ImportPreview => ({
  group: { id: 1, code: "ELV", name: "آسانسور" }, file_name: "a.xlsx", file_sha256: SHA, rows_total: 4, valid_count: 2, error_count: 2, ignored_columns: [],
  errors: [
    { row: 3, equipment_code: "SE 05", code: "invalid_equipment_code", bad_chars: ["U+200C"] },
    { row: 4, equipment_code: "PE-1", code: "group_mismatch", found: "ESC", expected: "ELV" },
  ],
  sample: [{ row: 2, equipment_code: "SE-01" }, { row: 5, equipment_code: "SE-02" }], ...o,
});
const batch = (o: Partial<ImportBatch> = {}): ImportBatch => ({
  id: 7, group_id: 1, group_code: "ELV", group_name: "آسانسور", file_name: "old.xlsx", created_by_name: "مدیر", created_at: ts, created_count: 10, rejected_count: 1,
  remaining_count: 10, report_count: 0, undone_at: null, can_undo: true, ...o,
});
const session = (u = makeUser()) => ({ "POST /auth/refresh": () => json(200, tokenBody(u)) });
const xlsx = () => new File(["x"], "a.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });

async function pickGroupAndFile(container: HTMLElement) {
  await userEvent.click(await screen.findByRole("combobox", { name: "گروه مقصد" }));
  await userEvent.click(await screen.findByRole("option", { name: /آسانسور/ }));
  await userEvent.upload(container.querySelector("input[type=file]") as HTMLInputElement, xlsx());
}

describe("import page", () => {
  it("previews as multipart, explains each rejected row in Persian, and commits only after confirmation with the previewed digest", async () => {
    let batches = [] as ImportBatch[];
    const m = mockFetch({
      ...session(),
      "GET /groups": () => json(200, page([group])),
      "GET /equipment/import/batches": () => json(200, page(batches)),
      "POST /equipment/import/preview": () => json(200, preview()),
      "POST /equipment/import/commit": () => { batches = [batch()]; return json(201, { ...preview(), batch_id: 7, created_count: 2 }); },
    });
    const { container } = renderApp("/equipment/import");
    await pickGroupAndFile(container);
    await userEvent.click(screen.getByRole("button", { name: "بررسی فایل" }));

    const table = await screen.findByRole("table", { name: "ردیف‌های ردشده" });
    expect(within(table).getByText(/نویسهٔ نامعتبر: U\+200C/)).toBeInTheDocument();
    expect(within(table).getByText(/کد گروه «ESC» با گروه انتخاب‌شده \(ELV\) یکی نیست/)).toBeInTheDocument();
    expect(screen.getByText("معتبر: ۲")).toBeInTheDocument();
    expect(screen.getByText("ردشده: ۲")).toBeInTheDocument();

    const pv = m.calls.find((c) => c.path === "/equipment/import/preview")!;
    expect(pv.body).toBeInstanceOf(FormData);
    const form = pv.body as FormData;
    expect(form.get("group_id")).toBe("1");
    expect((form.get("file") as File).name).toBe("a.xlsx");
    expect(pv.headers.get("Content-Type")).toBeNull();            // the browser must add the multipart boundary
    expect(m.count("POST /equipment/import/commit")).toBe(0);      // preview never imports

    await userEvent.click(screen.getByRole("button", { name: "ورود ۲ ردیف معتبر" }));
    expect(screen.getByText(/۲ تجهیز در گروه آسانسور \(ELV\) ثبت شود؟ ۲ ردیف ردشده وارد نمی‌شود/)).toBeInTheDocument();
    expect(m.count("POST /equipment/import/commit")).toBe(0);      // nothing until confirmed
    await userEvent.click(screen.getByRole("button", { name: "ورود به سامانه" }));
    expect(await screen.findByText(/۲ تجهیز در گروه آسانسور ثبت شد؛ ۲ ردیف ردشد و وارد نشد/)).toBeInTheDocument();
    const cm = (m.calls.find((c) => c.path === "/equipment/import/commit")!.body as FormData);
    expect(cm.get("preview_sha256")).toBe(SHA);
    expect(cm.get("group_id")).toBe("1");
    await waitFor(() => expect(m.count("GET /equipment/import/batches")).toBeGreaterThanOrEqual(2));   // history reloaded
    expect(await screen.findByText("old.xlsx")).toBeInTheDocument();
  });

  it("cannot import when no row is valid, and file-level errors are shown in Persian", async () => {
    let n = 0;
    mockFetch({
      ...session(), "GET /groups": () => json(200, page([group])), "GET /equipment/import/batches": () => json(200, page([])),
      "POST /equipment/import/preview": () => (++n === 1 ? json(200, preview({ valid_count: 0, errors: preview().errors })) : json(422, { detail: { code: "too_many_rows", max_rows: 1000 } })),
    });
    const { container } = renderApp("/equipment/import");
    await pickGroupAndFile(container);
    await userEvent.click(screen.getByRole("button", { name: "بررسی فایل" }));
    expect(await screen.findByRole("button", { name: "ورود ۰ ردیف معتبر" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "بررسی فایل" }));
    expect(await screen.findByText(/از حد مجاز \(۱٬?۰۰۰|از حد مجاز \(۱۰۰۰/)).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "ردیف‌های ردشده" })).not.toBeInTheDocument();    // stale preview is cleared
  });

  it("while a preview request is in flight the group, the file and the button are locked, so a late answer can never attach to other inputs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    mockFetch({
      ...session(), "GET /groups": () => json(200, page([group])), "GET /equipment/import/batches": () => json(200, page([])),
      "POST /equipment/import/preview": async () => { await gate; return json(200, preview()); },
    });
    const { container } = renderApp("/equipment/import");
    await pickGroupAndFile(container);
    await userEvent.click(screen.getByRole("button", { name: "بررسی فایل" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "بررسی فایل" })).toBeDisabled());
    expect(screen.getByRole("combobox", { name: "گروه مقصد" })).toHaveAttribute("aria-disabled", "true");
    expect(container.querySelector("input[type=file]")).toBeDisabled();
    release();
    expect(await screen.findByRole("button", { name: "ورود ۲ ردیف معتبر" })).toBeInTheDocument();
    expect(container.querySelector("input[type=file]")).not.toBeDisabled();       // unlocked again afterwards
  });

  it("changing the file or the group discards the old preview (the confirm button cannot act on a stale one)", async () => {
    mockFetch({ ...session(), "GET /groups": () => json(200, page([group])), "GET /equipment/import/batches": () => json(200, page([])), "POST /equipment/import/preview": () => json(200, preview()) });
    const { container } = renderApp("/equipment/import");
    await pickGroupAndFile(container);
    await userEvent.click(screen.getByRole("button", { name: "بررسی فایل" }));
    expect(await screen.findByRole("button", { name: "ورود ۲ ردیف معتبر" })).toBeInTheDocument();
    await userEvent.upload(container.querySelector("input[type=file]") as HTMLInputElement, new File(["y"], "b.xlsx"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "ورود ۲ ردیف معتبر" })).not.toBeInTheDocument());
  });

  it("undo is offered only when allowed, asks for confirmation, and explains a refusal", async () => {
    const m = mockFetch({
      ...session(), "GET /groups": () => json(200, page([group])),
      "GET /equipment/import/batches": () => json(200, page([batch({ id: 7 }), batch({ id: 8, can_undo: false, report_count: 3 }), batch({ id: 9, undone_at: ts, can_undo: false })])),
      "POST /equipment/import/batches/7/undo": () => json(409, { detail: { code: "batch_has_reports", report_count: 1, equipment_codes: ["SE-01"] } }),
    });
    renderApp("/equipment/import");
    expect(await screen.findByRole("button", { name: "لغو ورود 8" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "لغو ورود 9" })).not.toBeInTheDocument();     // already undone: no button
    expect(screen.getByText("لغو شده")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "لغو ورود 7" }));
    expect(m.count("POST /equipment/import/batches/7/undo")).toBe(0);
    await userEvent.click(screen.getByRole("button", { name: "لغو ورود" }));
    expect(await screen.findByText(/برای تجهیزات این ورود ۱ گزارش ثبت شده است \(SE-01\)/)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("downloads the template through the authenticated client", async () => {
    const created: Blob[] = [];
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: (b: Blob) => { created.push(b); return "blob:x"; }, revokeObjectURL: () => {} }));
    const m = mockFetch({
      ...session(), "GET /groups": () => json(200, page([group])), "GET /equipment/import/batches": () => json(200, page([])),
      "GET /equipment/import/template": () => new Response("equipment_code,group_code,description", { status: 200, headers: { "content-type": "text/csv" } }),
    });
    renderApp("/equipment/import");
    await userEvent.click(await screen.findByRole("button", { name: "قالب CSV" }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(m.calls.find((c) => c.path === "/equipment/import/template")!.query.get("format")).toBe("csv");
    expect(m.calls.find((c) => c.path === "/equipment/import/template")!.headers.get("Authorization")).toMatch(/^Bearer /);
  });

  it.each(["EXPERT", "AUDITOR", "USER"])("is not reachable for %s (never requests the import endpoints)", async (role) => {
    const m = mockFetch({ ...session(makeUser({ role_code: role, username: "x" })), "GET /reports/entry-config": () => json(200, { default_labor_minutes: 30, max_participant_minutes: 1440, max_participants: 30, max_description_length: 5000, future_tolerance_minutes: 5, groups: [] }), "GET /reports/drafts": () => json(200, []), "GET /reports/equipment-quick-pick": () => json(200, { recent: [], frequent: [] }), "GET /report-types": () => json(200, []), "GET /equipment": () => json(200, page([])), "GET /groups": () => json(200, page([])), "GET /dashboard/summary": () => json(200, { active_users: 0, inactive_users: 0, active_equipment: 0, inactive_equipment: 0, active_groups: 0, groups: [] }) });
    renderApp("/equipment/import");
    await waitFor(() => expect(m.count("GET /groups") + m.count("GET /dashboard/summary") + m.count("GET /equipment") + m.count("GET /reports/entry-config")).toBeGreaterThan(0)); // redirected away (USER/EXPERT land on report entry)
    expect(m.count("GET /equipment/import/batches")).toBe(0);
    expect(screen.queryByRole("link", { name: "ورود گروهی تجهیزات" })).not.toBeInTheDocument();
  });
});

describe("import helpers", () => {
  it("every reason code the API can return has a Persian text (none falls through to the raw code)", () => {
    const codes = ["invalid_equipment_code", "missing_equipment_code", "missing_group_code", "group_mismatch", "duplicate_in_file", "already_exists", "formula_not_allowed", "date_cell", "invalid_description"];
    for (const code of codes) expect(rowReason({ row: 2, equipment_code: "A", code })).not.toBe(code);
    expect(rowReason({ row: 2, equipment_code: "A", code: "already_exists", existing_group_code: "DOOR", existing_is_active: false })).toContain("DOOR");
  });

  it("the errors CSV neutralises spreadsheet formulas and escapes quotes", async () => {
    const blob = errorsCsv([{ row: 2, equipment_code: '=HYPERLINK("x")', code: "formula_not_allowed" }]);
    expect([...new Uint8Array(await blob.arrayBuffer()).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);   // UTF-8 BOM so Excel shows Persian correctly
    const text = await blob.text();
    expect(text.startsWith("row,equipment_code,reason")).toBe(true);
    expect(text).toContain(`"'=HYPERLINK(""x"")"`);
  });

  it("file-level import errors have Persian messages", () => {
    expect(errorMessage(new ApiError(422, "too_many_rows", { max_rows: 1000 }))).toContain("حد مجاز");
    expect(errorMessage(new ApiError(422, "missing_columns", { columns: ["group_code"] }))).toContain("group_code");
    expect(errorMessage(new ApiError(409, "batch_has_reports", { report_count: 2, equipment_codes: ["A-1"] }))).toContain("۲ گزارش");
    for (const code of ["unsupported_file_type", "file_too_large", "file_corrupt", "file_unsafe", "file_encoding", "multiple_sheets", "nothing_to_import", "file_changed", "import_conflict", "batch_already_undone"])
      expect(errorMessage(new ApiError(422, code))).not.toContain(code);
  });
});
