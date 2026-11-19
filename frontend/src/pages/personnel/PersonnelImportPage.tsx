import { useEffect, useMemo, useState } from "react";
import {
  Alert, Button, Chip, FormControl, IconButton, InputLabel, MenuItem, Paper, Select, Stack, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, Tooltip, Typography,
} from "@mui/material";
import UploadIcon from "@mui/icons-material/UploadFileOutlined";
import DownloadIcon from "@mui/icons-material/FileDownloadOutlined";
import CloseIcon from "@mui/icons-material/Close";
import { ApiError } from "../../api/http";
import { groupsApi, personnelImportApi } from "../../api/resources";
import type { Group, PersonnelCommit, PersonnelGroupIssue, PersonnelPreview, PersonnelRowError } from "../../api/types";
import { ConfirmDialog, Loading, Ltr, PageHeader } from "../../components/common";
import { toPersianDigits } from "../../lib/dates";
import { useLoad } from "../../lib/useLoad";
import { downloadBlob } from "../ImportPage";
import {
  canCommit, buildCorrections, distinctBad, MAX_CORRECTIONS, sampleAfterFixes, setDrop, setTokenFix, SHOWN_STEP, summarize, templateCsv, tokenFix, type Fixes,
} from "./personnelImportState";
import { groupReason, importedProblemsCsv, personnelErrorMessage, personnelRowReason, RESTART_CODES } from "./personnelImportMessages";

const fa = (n: number) => toPersianDigits(String(n));

/** Every group (the page keeps only the active ones), page by page (the API returns at most 100 per page). */
async function loadActiveGroups() {
  const out: Group[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await groupsApi.list({ limit: 100, offset });
    out.push(...page.items);
    if (offset + 100 >= page.total || page.items.length === 0) break;
  }
  return out;
}

function ShowMore({ shown, total, onMore }: { shown: number; total: number; onMore: () => void }) {
  return (
    <Stack direction="row" alignItems="center" gap={1} sx={{ mt: 0.5 }}>
      <Typography variant="caption" color="text.secondary">{fa(Math.min(shown, total))} از {fa(total)}</Typography>
      {shown < total && <Button size="small" onClick={onMore}>نمایش بیشتر</Button>}
    </Stack>
  );
}

function RowErrors({ errors, label }: { errors: PersonnelRowError[]; label: string }) {
  const [shown, setShown] = useState(SHOWN_STEP);
  if (errors.length === 0) return null;
  return (
    <>
      <Typography variant="subtitle1" sx={{ mt: 2, mb: 1 }}>{label} ({fa(errors.length)})</Typography>
      <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 360 }}>
        <Table size="small" stickyHeader aria-label={label}>
          <TableHead><TableRow><TableCell>ردیف</TableCell><TableCell>کد پرسنلی</TableCell><TableCell>دلیل</TableCell></TableRow></TableHead>
          <TableBody>
            {errors.slice(0, shown).map((e, i) => (
              <TableRow key={`${e.row}-${e.code}-${i}`}><TableCell>{fa(e.row)}</TableCell><TableCell><Ltr>{e.personnel_code || "—"}</Ltr></TableCell><TableCell>{personnelRowReason(e)}</TableCell></TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      <ShowMore shown={shown} total={errors.length} onMore={() => setShown((n) => n + SHOWN_STEP)} />
    </>
  );
}

interface FixProps {
  issues: PersonnelGroupIssue[];
  fixes: Fixes;
  groups: { code: string; name: string }[];
  disabled: boolean;
  onChange: (f: Fixes) => void;
}

/** Rows whose group cell holds invalid codes: replace from the active-group list, remove the code, or drop the row. */
function GroupFixes({ issues, fixes, groups, disabled, onChange }: FixProps) {
  const [shown, setShown] = useState(SHOWN_STEP);
  if (issues.length === 0) return null;
  return (
    <>
      <Typography variant="subtitle1" sx={{ mt: 2, mb: 1 }}>ردیف‌های نیازمند تعیین‌تکلیف کد گروه ({fa(issues.length)})</Typography>
      <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 420 }}>
        <Table size="small" stickyHeader aria-label="ردیف‌های نیازمند تعیین‌تکلیف">
          <TableHead><TableRow><TableCell>ردیف</TableCell><TableCell>کد پرسنلی</TableCell><TableCell>کد گروه نامعتبر و اقدام</TableCell><TableCell /></TableRow></TableHead>
          <TableBody>
            {issues.slice(0, shown).map((issue) => {
              const fix = fixes[issue.row];
              const dropped = !!fix?.drop;
              return (
                <TableRow key={issue.row} sx={dropped ? { opacity: 0.55 } : undefined}>
                  <TableCell>{fa(issue.row)}</TableCell>
                  <TableCell><Ltr>{issue.personnel_code}</Ltr></TableCell>
                  <TableCell>
                    {dropped ? <Chip size="small" label="این ردیف وارد نمی‌شود" /> : (
                      <Stack gap={1}>
                        {distinctBad(issue).map((bad) => {
                          const t = tokenFix(fixes, issue.row, bad.token);
                          return (
                            <Stack key={bad.token} direction="row" gap={1} alignItems="center" flexWrap="wrap">
                              {t ? (
                                <>
                                  <Chip size="small" color="success" label={<><Ltr>{bad.token}</Ltr> {t.op === "replace" ? <>← <Ltr>{t.to}</Ltr></> : "← حذف شد"}</>} />
                                  <Button size="small" disabled={disabled} aria-label={`بازگردانی ${bad.token} ردیف ${issue.row}`}
                                    onClick={() => onChange(setTokenFix(fixes, issue.row, bad.token, null))}>بازگردانی</Button>
                                </>
                              ) : (
                                <>
                                  <Chip size="small" color="warning" label={<><Ltr>{bad.token}</Ltr> — {groupReason(bad.reason)}</>} />
                                  <FormControl size="small" sx={{ minWidth: 170 }}>
                                    <InputLabel id={`fx-${issue.row}-${bad.token}`}>جایگزینی با گروه</InputLabel>
                                    <Select labelId={`fx-${issue.row}-${bad.token}`} label="جایگزینی با گروه" value="" disabled={disabled}
                                      onChange={(e) => onChange(setTokenFix(fixes, issue.row, bad.token, { op: "replace", to: String(e.target.value) }))}>
                                      {groups.map((g) => <MenuItem key={g.code} value={g.code}>{g.name} ({g.code})</MenuItem>)}
                                    </Select>
                                  </FormControl>
                                  <Tooltip title="حذف همین کد گروه (فرد وارد می‌شود)">
                                    <span><IconButton size="small" disabled={disabled} aria-label={`حذف ${bad.token} ردیف ${issue.row}`}
                                      onClick={() => onChange(setTokenFix(fixes, issue.row, bad.token, { op: "remove" }))}><CloseIcon fontSize="small" /></IconButton></span>
                                  </Tooltip>
                                </>
                              )}
                            </Stack>
                          );
                        })}
                      </Stack>
                    )}
                  </TableCell>
                  <TableCell align="right">
                    {dropped
                      ? <Button size="small" disabled={disabled} aria-label={`بازگردانی ردیف ${issue.row}`} onClick={() => onChange(setDrop(fixes, issue.row, false))}>بازگردانی ردیف</Button>
                      : <Button size="small" color="error" disabled={disabled} aria-label={`حذف ردیف ${issue.row}`} onClick={() => onChange(setDrop(fixes, issue.row, true))}>حذف ردیف</Button>}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
      <ShowMore shown={shown} total={issues.length} onMore={() => setShown((n) => n + SHOWN_STEP)} />
    </>
  );
}

export function PersonnelImportPage() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PersonnelPreview | null>(null);
  const [fixes, setFixes] = useState<Fixes>({});
  const [result, setResult] = useState<PersonnelCommit | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirm, setConfirm] = useState(false);

  const groups = useLoad(loadActiveGroups, []);
  // a reload keeps the old data: while it is pending or has failed the cached groups may be stale, so offer none
  const activeGroups = useMemo(() => (groups.loading || groups.error ? [] : (groups.data ?? []).filter((g) => g.is_active)), [groups.data, groups.loading, groups.error]);

  useEffect(() => { setPreview(null); setFixes({}); }, [file]);

  const summary = useMemo(() => (preview ? summarize(preview, fixes) : null), [preview, fixes]);
  const sample = useMemo(() => (preview ? sampleAfterFixes(preview, fixes) : []), [preview, fixes]);
  const corrections = useMemo(() => (preview ? buildCorrections(preview, fixes) : []), [preview, fixes]);

  function startOver() { setFile(null); setPreview(null); setFixes({}); }

  async function runPreview() {
    if (!file) return;
    setBusy(true); setError(null); setResult(null);
    try { setPreview(await personnelImportApi.preview(file)); setFixes({}); }
    catch (e) { setError(e); setPreview(null); }
    finally { setBusy(false); }
  }

  async function runCommit() {
    if (!file || !preview) return;
    try {
      setError(null);
      setResult(await personnelImportApi.commit(file, preview.file_sha256, corrections));
      setPreview(null); setFixes({});
    } catch (e) {
      setError(e);
      if (e instanceof ApiError && RESTART_CODES.has(e.code)) { startOver(); groups.reload(); } // nothing was imported; begin again with fresh group choices
      // not rethrown: the dialog would show the generic Persian text of the code, the page shows the personnel text
    }
  }

  async function runProblemsCsv() {
    if (!file) return;
    setError(null);
    try { downloadBlob(await personnelImportApi.problemsCsv(file, corrections), "personnel-import-problems.csv"); }
    catch (e) { setError(e); }
  }

  const tooMany = corrections.length > MAX_CORRECTIONS;
  const hasProblems = !!preview && (preview.error_count > 0 || preview.group_issues.length > 0);
  const resultProblems = !!result && result.errors.length > 0;

  return (
    <>
      <PageHeader title="ورود گروهی افراد" actions={
        <Button variant="outlined" startIcon={<DownloadIcon />} onClick={() => downloadBlob(templateCsv(), "personnel-import-template.csv")}>قالب CSV</Button>
      } />
      <Typography color="text.secondary" sx={{ mb: 2 }}>
        فایل باید یک برگه (Sheet) با سرستون‌های <Ltr>first_name</Ltr>، <Ltr>last_name</Ltr>، <Ltr>personnel_code</Ltr> و <Ltr>mobile</Ltr> و (اختیاری) <Ltr>groups</Ltr> باشد.
        در ستون <Ltr>groups</Ltr> کد گروه‌ها با «؛» یا <Ltr>;</Ltr> جدا می‌شوند (مثلاً <Ltr>ELV;ESC</Ltr>). ستون موبایل را با قالب «متن» (Text) بسازید تا صفر ابتدایی حفظ شود.
        این ورود فقط افراد جدید می‌سازد؛ فرد موجود هرگز تغییر نمی‌کند و پروفایل ورود ساخته نمی‌شود.
      </Typography>

      <Stack direction={{ xs: "column", sm: "row" }} gap={1.5} alignItems={{ sm: "center" }} sx={{ mb: 2 }}>
        <Button component="label" variant="outlined" startIcon={<UploadIcon />} disabled={busy}>
          انتخاب فایل
          <input type="file" hidden disabled={busy} accept=".xlsx,.csv" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null); setError(null); e.target.value = ""; }} />
        </Button>
        <Typography variant="body2" sx={{ flexGrow: 1 }}>{file ? <Ltr>{file.name}</Ltr> : "فایلی انتخاب نشده است"}</Typography>
        <Button variant="contained" disabled={!file || busy} onClick={runPreview}>بررسی فایل</Button>
      </Stack>
      {!!groups.error && (
        <Alert severity="warning" sx={{ my: 1 }} action={<Button color="inherit" size="small" onClick={groups.reload}>تلاش دوباره</Button>}>
          فهرست گروه‌ها بارگذاری نشد؛ تا بارگذاری دوباره نمی‌توان کد گروه را جایگزین کرد. {personnelErrorMessage(groups.error)}
        </Alert>
      )}
      {!!error && <Alert severity="error" sx={{ my: 1 }}>{personnelErrorMessage(error)}</Alert>}
      {busy && <Loading />}

      {preview && summary && !busy && (
        <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
          <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center" sx={{ mb: 1 }}>
            <Typography variant="subtitle1">پیش‌نمایش</Typography>
            <Chip color="success" label={`قابل ورود: ${fa(summary.importable)}`} />
            <Chip color={summary.unresolvedRows ? "warning" : "default"} label={`نیازمند تعیین‌تکلیف: ${fa(summary.unresolvedRows)}`} />
            <Chip color={preview.error_count ? "error" : "default"} label={`نامعتبر: ${fa(preview.error_count)}`} />
            {summary.dropped > 0 && <Chip variant="outlined" label={`کنار گذاشته‌شده: ${fa(summary.dropped)}`} />}
            <Chip variant="outlined" label={`کل ردیف‌ها: ${fa(preview.rows_total)}`} />
          </Stack>
          {preview.ignored_columns.length > 0 && <Alert severity="info" sx={{ mb: 1 }}>ستون‌های نادیده‌گرفته‌شده: <Ltr>{preview.ignored_columns.join(", ")}</Ltr></Alert>}

          {sample.length > 0 && (
            <>
              <Typography variant="subtitle2" sx={{ mt: 1, mb: 0.5 }}>نمونه از ردیف‌های قابل ورود ({fa(sample.length)} ردیف از {fa(summary.importable)})</Typography>
              <TableContainer component={Paper} variant="outlined">
                <Table size="small" aria-label="نمونهٔ ردیف‌های قابل ورود">
                  <TableHead><TableRow><TableCell>ردیف</TableCell><TableCell>کد پرسنلی</TableCell><TableCell>نام</TableCell><TableCell>گروه‌ها</TableCell></TableRow></TableHead>
                  <TableBody>
                    {sample.map((s) => (
                      <TableRow key={s.row}><TableCell>{fa(s.row)}</TableCell><TableCell><Ltr>{s.personnel_code}</Ltr></TableCell><TableCell>{s.full_name}</TableCell><TableCell>{s.group_codes.length ? <Ltr>{s.group_codes.join("، ")}</Ltr> : "—"}</TableCell></TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </>
          )}

          <GroupFixes issues={preview.group_issues} fixes={fixes} groups={activeGroups} disabled={busy} onChange={setFixes} />
          <RowErrors errors={preview.errors} label="ردیف‌های نامعتبر (وارد نمی‌شوند)" />

          <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap" sx={{ mt: 2 }}>
            <Button variant="contained" disabled={!canCommit(summary, corrections.length)} onClick={() => setConfirm(true)}>ورود {fa(summary.importable)} نفر</Button>
            {hasProblems && <Button startIcon={<DownloadIcon />} disabled={tooMany} onClick={runProblemsCsv}>دانلود گزارش مشکلات (CSV)</Button>}
            <Button onClick={startOver}>انصراف و اصلاح فایل</Button>
            {summary.unresolvedRows > 0 && <Typography variant="body2" color="warning.main">ردیف تعیین‌تکلیف‌نشده دارید</Typography>}
            {tooMany && <Typography variant="body2" color="error">تعداد اصلاحات از حد مجاز ({fa(MAX_CORRECTIONS)}) بیشتر است؛ برخی ردیف‌ها را کنار بگذارید یا فایل را اصلاح کنید.</Typography>}
          </Stack>
          {summary.importable === 0 && summary.unresolvedRows === 0 && <Alert severity="warning" sx={{ mt: 2 }}>هیچ ردیف قابل ورودی وجود ندارد. فایل را اصلاح و دوباره بررسی کنید.</Alert>}
        </Paper>
      )}

      {result && (
        <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
          <Alert severity="success">
            {fa(result.created_count)} نفر ثبت شد (شمارهٔ ورود: {fa(result.batch_id)})
            {result.error_count + (result.dropped_count ?? 0) > 0 ? `؛ ${fa(result.error_count + (result.dropped_count ?? 0))} ردیف وارد نشد` : ""}.
          </Alert>
          <RowErrors errors={result.errors} label="ردیف‌های واردنشده" />
          <Stack direction="row" gap={1} sx={{ mt: 2 }}>
            {resultProblems && result && <Button startIcon={<DownloadIcon />} onClick={() => downloadBlob(importedProblemsCsv(result.errors), "personnel-import-problems.csv")}>دانلود ردیف‌های واردنشده (CSV)</Button>}
            <Button onClick={() => { setResult(null); startOver(); }}>ورود فایل دیگر</Button>
          </Stack>
        </Paper>
      )}

      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} confirmLabel="ورود به سامانه" title="تأیید ورود گروهی افراد"
        text={summary ? `${fa(summary.importable)} نفر به‌عنوان فرد جدید ثبت شود؟ این افراد پروفایل ورود ندارند.${preview && preview.error_count ? ` ${fa(preview.error_count)} ردیف نامعتبر وارد نمی‌شود.` : ""}` : ""}
        onConfirm={runCommit} />
    </>
  );
}
