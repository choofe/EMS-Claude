import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert, Button, Checkbox, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Paper, Stack, Table, TableBody,
  TableCell, TableContainer, TableHead, TableRow, Typography, useMediaQuery, useTheme,
} from "@mui/material";
import { Link as RouterLink } from "react-router-dom";
import { personnelImportApi } from "../../api/resources";
import type { PersonnelCancelPreview, PersonnelImportBatch } from "../../api/types";
import { DateText, Empty, Loading, Ltr, PageHeader, Pager } from "../../components/common";
import { toPersianDigits } from "../../lib/dates";
import { useLoad } from "../../lib/useLoad";
import { BATCH_PAGE, canCancel, exemptLines, importedOfTotal, personName, reloadSize, statusLabel } from "./personnelHistory";
import { personnelErrorMessage } from "./personnelImportMessages";

const fa = (n: number) => toPersianDigits(String(n));

/** The people of one batch as they are NOW (names, code, groups and mobile come from the database, so they may differ from the file). */
function PeopleDialog({ batch, onClose }: { batch: PersonnelImportBatch; onClose: () => void }) {
  const theme = useTheme();
  const desktop = useMediaQuery(theme.breakpoints.up("md"));
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState(25);
  const [reveal, setReveal] = useState(false);
  const people = useLoad(() => personnelImportApi.batchPeople(batch.id, { limit: rows, offset: page * rows }), [batch.id, page, rows]);
  const showMobile = desktop || reveal; // a phone shows the numbers only when the manager asks
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md" fullScreen={!desktop}>
      <DialogTitle>افراد این ورود</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          اطلاعات فعلی افراد نمایش داده می‌شود و ممکن است با فایل ورودی تفاوت داشته باشد.
        </Typography>
        {!desktop && <Button size="small" onClick={() => setReveal((v) => !v)} sx={{ mb: 1 }}>{reveal ? "پنهان کردن شماره‌ها" : "نمایش شماره‌ها"}</Button>}
        {people.error ? <Alert severity="error">{personnelErrorMessage(people.error)}</Alert> : null}
        {people.loading && !people.data ? <Loading /> : people.data && people.data.items.length === 0 ? <Empty text="کسی از این ورود در سیستم نمانده است." /> : people.data && (
          <>
            <TableContainer>
              <Table size="small">
                <TableHead><TableRow><TableCell>نام (کد پرسنلی)</TableCell><TableCell>وضعیت</TableCell>{showMobile && <TableCell>موبایل</TableCell>}</TableRow></TableHead>
                <TableBody>
                  {people.data.items.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell>
                        {personName(p)}
                        <Typography variant="caption" color="text.secondary" component="div">{p.group_codes.length ? <Ltr>{p.group_codes.join(" ; ")}</Ltr> : "بدون گروه"}</Typography>
                      </TableCell>
                      <TableCell>
                        <Stack direction="row" gap={0.5} flexWrap="wrap">
                          {!p.is_active && <Chip size="small" label="غیرفعال" />}
                          {p.has_profile && <Chip size="small" color="info" variant="outlined" label="دارای پروفایل" />}
                        </Stack>
                      </TableCell>
                      {showMobile && <TableCell>{p.mobile ? <Ltr>{p.mobile}</Ltr> : "—"}</TableCell>}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
            <Pager total={people.data.total} page={page} rowsPerPage={rows} onPage={setPage} onRows={(n) => { setRows(n); setPage(0); }} />
          </>
        )}
      </DialogContent>
      <DialogActions><Button onClick={onClose}>بستن</Button></DialogActions>
    </Dialog>
  );
}

/** Two steps: the preview (writes nothing) shows who goes and who stays; the confirm needs the tick. A changed batch (409) reloads the numbers and asks again. */
function CancelDialog({ batch, onClose, onDone }: { batch: PersonnelImportBatch; onClose: () => void; onDone: (removed: number, kept: number) => void }) {
  const [preview, setPreview] = useState<PersonnelCancelPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const loadPreview = useCallback(async () => {
    setPreview(null);
    try {
      const p = await personnelImportApi.cancelPreview(batch.id);
      if (alive.current) setPreview(p);
    } catch (e) {
      if (alive.current) setError(personnelErrorMessage(e));
    }
  }, [batch.id]);
  useEffect(() => { void loadPreview(); }, [loadPreview]);

  const confirm = async () => {
    if (!preview || busy) return;
    setBusy(true);
    try {
      const r = await personnelImportApi.cancel(batch.id, preview.fingerprint);
      onDone(r.removed_count, r.kept_count);
    } catch (e) {
      if (!alive.current) return;
      setError(personnelErrorMessage(e));
      setAck(false);
      setBusy(false);
      await loadPreview(); // nothing was deleted: show the new numbers; the manager decides again
    }
  };

  const lines = preview ? exemptLines(preview.exempt_reasons) : [];
  return (
    <Dialog open onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>لغو ورود «<Ltr>{batch.file_name}</Ltr>»</DialogTitle>
      <DialogContent>
        {error && <Alert severity="warning" sx={{ mb: 1.5 }}>{error}</Alert>}
        {!preview && !error ? <Loading /> : null}
        {preview && (
          <>
            <Typography sx={{ mb: 1 }}>
              از {fa(preview.remaining_count)} نفری که هنوز در سیستم هستند، <b>{fa(preview.removable_count)} نفر حذف می‌شوند</b> و {fa(preview.exempt_count)} نفر می‌مانند.
            </Typography>
            {lines.length > 0 && (
              <>
                <Typography variant="body2" color="text.secondary">افراد زیر حذف نمی‌شوند چون به آن‌ها ارجاع وجود دارد:</Typography>
                <ul style={{ marginTop: 4 }}>{lines.map((l) => <li key={l}><Typography variant="body2">{l}</Typography></li>)}</ul>
              </>
            )}
            {preview.removable_count === 0 ? (
              <Alert severity="info">هیچ‌کس قابل حذف نیست.</Alert>
            ) : (
              <>
                <Alert severity="error" sx={{ my: 1 }}>حذف این افراد برگشت‌پذیر نیست.</Alert>
                <FormControlLabel control={<Checkbox checked={ack} onChange={(e) => setAck(e.target.checked)} />} label="متوجه‌ام که حذف این افراد برگشت‌پذیر نیست" />
              </>
            )}
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>انصراف</Button>
        <Button color="error" variant="contained" disabled={!preview || preview.removable_count === 0 || !ack || busy} onClick={confirm}>لغو ورود</Button>
      </DialogActions>
    </Dialog>
  );
}

export function PersonnelImportHistoryPage() {
  const [items, setItems] = useState<PersonnelImportBatch[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [peopleOf, setPeopleOf] = useState<PersonnelImportBatch | null>(null);
  const [cancelOf, setCancelOf] = useState<PersonnelImportBatch | null>(null);
  const seq = useRef(0);

  /** `replace` re-reads from the start (first load and after a cancel); otherwise the next page is appended. */
  const load = useCallback(async (offset: number, limit: number, replace: boolean) => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const page = await personnelImportApi.batches({ limit, offset });
      if (mine !== seq.current) return; // a newer request owns the screen
      setItems((cur) => (replace ? page.items : [...cur, ...page.items]));
      setTotal(page.total);
    } catch (e) {
      if (mine === seq.current) setError(personnelErrorMessage(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);
  useEffect(() => { void load(0, BATCH_PAGE, true); }, [load]);

  return (
    <>
      <PageHeader title="تاریخچهٔ ورود گروهی افراد" actions={<Button variant="outlined" component={RouterLink} to="/personnel/import">بازگشت به ورود گروهی</Button>} />
      {notice && <Alert severity="success" onClose={() => setNotice(null)} sx={{ mb: 1.5 }}>{notice}</Alert>}
      {error && <Alert severity="error" sx={{ mb: 1.5 }}>{error}</Alert>}
      {loading && items.length === 0 ? <Loading /> : !loading && items.length === 0 && !error ? <Empty text="هنوز ورود گروهی انجام نشده است." /> : (
        <Stack gap={1.5}>
          {items.map((b) => {
            const label = statusLabel(b.status);
            return (
              <Paper key={b.id} variant="outlined" sx={{ p: 1.5 }}>
                <Stack direction={{ xs: "column", sm: "row" }} gap={1} justifyContent="space-between" alignItems={{ sm: "center" }}>
                  <div>
                    <Typography fontWeight={600}><Ltr>{b.file_name}</Ltr></Typography>
                    <Typography variant="body2" color="text.secondary"><DateText value={b.created_at} /> — {b.created_by_name}</Typography>
                    <Typography variant="body2">
                      {importedOfTotal(b)} ردیف وارد شد؛ {fa(b.remaining_count)} نفر هنوز در سیستم هستند
                      {b.removed_count > 0 ? `؛ ${fa(b.removed_count)} نفر حذف شده‌اند` : ""}
                    </Typography>
                  </div>
                  <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
                    {label && <Chip size="small" label={label} color={b.status === "cancelled" ? "default" : "warning"} variant="outlined" />}
                    <Button size="small" variant="outlined" disabled={b.remaining_count === 0} onClick={() => setPeopleOf(b)}>افراد</Button>
                    {canCancel(b) && <Button size="small" color="error" variant="outlined" onClick={() => setCancelOf(b)}>لغو</Button>}
                  </Stack>
                </Stack>
              </Paper>
            );
          })}
          {items.length < total && <Button disabled={loading} onClick={() => load(items.length, BATCH_PAGE, false)}>نمایش بیشتر</Button>}
          <Typography variant="caption" color="text.secondary">{fa(items.length)} از {fa(total)}</Typography>
        </Stack>
      )}
      {peopleOf && <PeopleDialog batch={peopleOf} onClose={() => setPeopleOf(null)} />}
      {cancelOf && (
        <CancelDialog batch={cancelOf} onClose={() => setCancelOf(null)} onDone={(removed, kept) => {
          setCancelOf(null);
          setNotice(`${fa(removed)} نفر حذف شد و ${fa(kept)} نفر ماند.`);
          void load(0, reloadSize(items.length), true);
        }} />
      )}
    </>
  );
}
