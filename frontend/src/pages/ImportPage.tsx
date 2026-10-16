import { useEffect, useState } from "react";
import {
  Alert, Button, Chip, FormControl, IconButton, InputLabel, MenuItem, Paper, Select, Stack, Table, TableBody, TableCell, TableContainer,
  TableHead, TableRow, Tooltip, Typography,
} from "@mui/material";
import UploadIcon from "@mui/icons-material/UploadFileOutlined";
import DownloadIcon from "@mui/icons-material/FileDownloadOutlined";
import UndoIcon from "@mui/icons-material/UndoOutlined";
import { groupsApi, importApi } from "../api/resources";
import type { ImportCommit, ImportPreview, ImportRowError } from "../api/types";
import { ConfirmDialog, DateText, Empty, ErrorAlert, Loading, Ltr, PageHeader, Pager } from "../components/common";
import { toPersianDigits } from "../lib/dates";
import { useLoad } from "../lib/useLoad";

const fa = (n: number) => toPersianDigits(String(n));
const SHOWN_ERRORS = 100;

/** Persian explanation of one rejected row. `code` is the stable reason from the API (docs/equipment-import.md). */
export function rowReason(e: ImportRowError): string {
  switch (e.code) {
    case "invalid_equipment_code":
      return `کد نامعتبر است (فقط حروف انگلیسی، عدد و - . _ / ؛ بدون فاصله)${e.bad_chars?.length ? ` — نویسهٔ نامعتبر: ${e.bad_chars.join("، ")}` : ""}`;
    case "missing_equipment_code": return "کد تجهیز خالی است";
    case "missing_group_code": return "کد گروه خالی است";
    case "group_mismatch": return `کد گروه «${e.found ?? ""}» با گروه انتخاب‌شده (${e.expected ?? ""}) یکی نیست`;
    case "duplicate_in_file": return `تکراری در همین فایل (ردیف ${fa(e.first_row ?? 0)})`;
    case "already_exists": return `از قبل ثبت شده است${e.existing_group_code ? ` (گروه ${e.existing_group_code}${e.existing_is_active === false ? "، غیرفعال" : ""})` : ""}`;
    case "formula_not_allowed": return "سلول با = شروع می‌شود (فرمول مجاز نیست)";
    case "date_cell": return "سلول از نوع تاریخ است؛ ستون را با قالب «متن» (Text) بسازید";
    case "invalid_description": return "توضیحات نامعتبر است (بیش از ۲۰۰۰ نویسه)";
    default: return e.code;
  }
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const csvCell = (v: string) => `"${(/^[=+\-@\t\r]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"`;  // no formula injection when reopened in Excel

export function errorsCsv(errors: ImportRowError[]): Blob {
  const lines = ["row,equipment_code,reason", ...errors.map((e) => [String(e.row), e.equipment_code, rowReason(e)].map(csvCell).join(","))];
  return new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
}

function ErrorTable({ errors }: { errors: ImportRowError[] }) {
  if (errors.length === 0) return null;
  return (
    <>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mt: 2, mb: 1 }}>
        <Typography variant="subtitle1">ردیف‌های ردشده ({fa(errors.length)})</Typography>
        <Button size="small" startIcon={<DownloadIcon />} onClick={() => downloadBlob(errorsCsv(errors), "import-errors.csv")}>دانلود فهرست خطاها</Button>
      </Stack>
      <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 360 }}>
        <Table size="small" stickyHeader aria-label="ردیف‌های ردشده">
          <TableHead><TableRow><TableCell>ردیف</TableCell><TableCell>مقدار</TableCell><TableCell>دلیل</TableCell></TableRow></TableHead>
          <TableBody>
            {errors.slice(0, SHOWN_ERRORS).map((e) => (
              <TableRow key={e.row}><TableCell>{fa(e.row)}</TableCell><TableCell><Ltr>{e.equipment_code || "—"}</Ltr></TableCell><TableCell>{rowReason(e)}</TableCell></TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      {errors.length > SHOWN_ERRORS && <Typography variant="caption" color="text.secondary">{fa(SHOWN_ERRORS)} مورد اول نمایش داده شد؛ فهرست کامل را دانلود کنید.</Typography>}
    </>
  );
}

export function ImportPage() {
  const [groupId, setGroupId] = useState<number | "">("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportCommit | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirm, setConfirm] = useState(false);
  const [undoId, setUndoId] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState(10);

  const groups = useLoad(() => groupsApi.list({ limit: 100, offset: 0 }), []);
  const batches = useLoad(() => importApi.batches({ limit: rows, offset: page * rows }), [page, rows]);
  const activeGroups = (groups.data?.items ?? []).filter((g) => g.is_active);
  const selected = activeGroups.find((g) => g.id === groupId);

  useEffect(() => { setPreview(null); }, [groupId, file]);

  async function runPreview() {
    if (groupId === "" || !file) return;
    setBusy(true); setError(null); setResult(null);
    try { setPreview(await importApi.preview(groupId, file)); }
    catch (e) { setError(e); setPreview(null); }
    finally { setBusy(false); }
  }

  async function runTemplate(format: "xlsx" | "csv") {
    setError(null);
    try { downloadBlob(await importApi.template(format), `equipment-import-template.${format}`); }
    catch (e) { setError(e); }
  }

  return (
    <>
      <PageHeader title="ورود گروهی تجهیزات" actions={<>
        <Button variant="outlined" startIcon={<DownloadIcon />} onClick={() => runTemplate("xlsx")}>قالب Excel</Button>
        <Button variant="outlined" startIcon={<DownloadIcon />} onClick={() => runTemplate("csv")}>قالب CSV</Button>
      </>} />
      <Typography color="text.secondary" sx={{ mb: 2 }}>
        هر بار فقط یک گروه. فایل باید یک برگه (Sheet) با سرستون‌های <Ltr>equipment_code</Ltr>، <Ltr>group_code</Ltr> و (اختیاری) <Ltr>description</Ltr> باشد.
        کد گروه همهٔ ردیف‌ها باید با گروه انتخاب‌شده یکی باشد. تجهیز موجود هرگز بازنویسی نمی‌شود.
      </Typography>

      <Stack direction={{ xs: "column", sm: "row" }} gap={1.5} alignItems={{ sm: "center" }} sx={{ mb: 2 }}>
        <FormControl size="small" sx={{ minWidth: 220 }}>
          <InputLabel id="imp-grp">گروه مقصد</InputLabel>
          <Select labelId="imp-grp" label="گروه مقصد" value={groupId} onChange={(e) => setGroupId(e.target.value as number | "")}>
            {activeGroups.map((g) => <MenuItem key={g.id} value={g.id}>{g.name} ({g.code})</MenuItem>)}
          </Select>
        </FormControl>
        <Button component="label" variant="outlined" startIcon={<UploadIcon />}>
          انتخاب فایل
          <input type="file" hidden accept=".xlsx,.csv" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null); e.target.value = ""; }} />
        </Button>
        <Typography variant="body2" sx={{ flexGrow: 1 }}>{file ? <Ltr>{file.name}</Ltr> : "فایلی انتخاب نشده است"}</Typography>
        <Button variant="contained" disabled={groupId === "" || !file || busy} onClick={runPreview}>بررسی فایل</Button>
      </Stack>
      <ErrorAlert error={error} />
      {busy && <Loading />}

      {preview && !busy && (
        <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
          <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center" sx={{ mb: 1 }}>
            <Typography variant="subtitle1">پیش‌نمایش برای گروه {preview.group.name} (<Ltr>{preview.group.code}</Ltr>)</Typography>
            <Chip color="success" label={`معتبر: ${fa(preview.valid_count)}`} />
            <Chip color={preview.error_count ? "error" : "default"} label={`ردشده: ${fa(preview.error_count)}`} />
            <Chip variant="outlined" label={`کل ردیف‌ها: ${fa(preview.rows_total)}`} />
          </Stack>
          {preview.ignored_columns.length > 0 && <Alert severity="info" sx={{ mb: 1 }}>ستون‌های نادیده‌گرفته‌شده: <Ltr>{preview.ignored_columns.join(", ")}</Ltr></Alert>}
          {preview.sample.length > 0 && (
            <Typography variant="body2" color="text.secondary">نمونه: {preview.sample.slice(0, 5).map((s) => <Ltr key={s.row}>{s.equipment_code}</Ltr>).reduce<React.ReactNode[]>((acc, el, i) => (i ? [...acc, "، ", el] : [el]), [])}</Typography>
          )}
          <ErrorTable errors={preview.errors} />
          <Stack direction="row" gap={1} sx={{ mt: 2 }}>
            <Button variant="contained" disabled={preview.valid_count === 0} onClick={() => setConfirm(true)}>ورود {fa(preview.valid_count)} ردیف معتبر</Button>
            <Button onClick={() => { setFile(null); setPreview(null); }}>انصراف و اصلاح فایل</Button>
          </Stack>
          {preview.valid_count === 0 && <Alert severity="warning" sx={{ mt: 2 }}>هیچ ردیف معتبری وجود ندارد. فایل را اصلاح و دوباره بررسی کنید.</Alert>}
        </Paper>
      )}

      {result && (
        <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
          <Alert severity="success">{fa(result.created_count)} تجهیز در گروه {result.group.name} ثبت شد{result.error_count ? `؛ ${fa(result.error_count)} ردیف ردشد و وارد نشد` : ""}.</Alert>
          <ErrorTable errors={result.errors} />
        </Paper>
      )}

      <Typography variant="h6" component="h2" sx={{ mt: 3, mb: 1 }}>تاریخچهٔ ورودها</Typography>
      <ErrorAlert error={batches.error} />
      {batches.loading && !batches.data ? <Loading /> : batches.data && batches.data.items.length === 0 ? <Empty text="هنوز ورود گروهی انجام نشده است." /> : batches.data && (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small" aria-label="تاریخچهٔ ورودها">
            <TableHead><TableRow><TableCell>زمان</TableCell><TableCell>گروه</TableCell><TableCell>فایل</TableCell><TableCell>ثبت‌شده</TableCell><TableCell>ردشده</TableCell><TableCell>وضعیت</TableCell><TableCell /></TableRow></TableHead>
            <TableBody>
              {batches.data.items.map((b) => (
                <TableRow key={b.id} hover>
                  <TableCell><DateText value={b.created_at} /></TableCell>
                  <TableCell>{b.group_name} (<Ltr>{b.group_code}</Ltr>)</TableCell>
                  <TableCell><Ltr>{b.file_name}</Ltr></TableCell>
                  <TableCell>{fa(b.created_count)}</TableCell><TableCell>{fa(b.rejected_count)}</TableCell>
                  <TableCell>{b.undone_at ? <Chip size="small" label="لغو شده" /> : <Chip size="small" color="success" variant="outlined" label={`${fa(b.remaining_count)} تجهیز`} />}</TableCell>
                  <TableCell align="right">
                    {!b.undone_at && (
                      <Tooltip title={b.can_undo ? "لغو کل این ورود (حذف تجهیزات آن)" : b.report_count > 0 ? "برای این تجهیزات گزارش ثبت شده است" : "لغو ممکن نیست"}>
                        <span><IconButton aria-label={`لغو ورود ${b.id}`} disabled={!b.can_undo} onClick={() => setUndoId(b.id)}><UndoIcon fontSize="small" /></IconButton></span>
                      </Tooltip>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pager total={batches.data.total} page={page} rowsPerPage={rows} onPage={setPage} onRows={(n) => { setRows(n); setPage(0); }} />
        </TableContainer>
      )}

      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} confirmLabel="ورود به سامانه"
        title="تأیید ورود گروهی"
        text={preview && selected ? `${fa(preview.valid_count)} تجهیز در گروه ${selected.name} (${selected.code}) ثبت شود؟${preview.error_count ? ` ${fa(preview.error_count)} ردیف ردشده وارد نمی‌شود.` : ""}` : ""}
        onConfirm={async () => {
          if (groupId === "" || !file || !preview) return;
          setResult(await importApi.commit(groupId, file, preview.file_sha256));
          setPreview(null); setFile(null); batches.reload(); groups.reload();
        }} />

      <ConfirmDialog open={undoId !== null} onClose={() => setUndoId(null)} danger confirmLabel="لغو ورود"
        title="لغو ورود گروهی"
        text="همهٔ تجهیزاتی که با این ورود ثبت شده‌اند حذف می‌شوند. این کار فقط تا وقتی ممکن است که برای آن‌ها گزارشی ثبت نشده باشد."
        onConfirm={async () => { if (undoId !== null) { await importApi.undo(undoId); setResult(null); batches.reload(); groups.reload(); } }} />
    </>
  );
}
