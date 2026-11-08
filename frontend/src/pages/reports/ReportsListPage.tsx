import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Alert, Box, Button, Card, CardActionArea, CardContent, Checkbox, Chip, FormControl, FormControlLabel, InputLabel, MenuItem, Paper, Select, Stack,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TableSortLabel, TextField, Typography, useMediaQuery, useTheme,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import { Link as RouterLink, useNavigate, useSearchParams } from "react-router-dom";
import { groupsApi, reportTypesApi, reportsApi } from "../../api/resources";
import type { ReportListItem, ReportListQuery } from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { Empty, ErrorAlert, Loading, Ltr, PageHeader } from "../../components/common";
import { canReport } from "../../lib/access";
import { formatJalaliDateTime } from "../../lib/dates";
import { jalaliToDate, parseJalaliDateText } from "../../lib/jalali";
import { formatMinutes } from "../../lib/labor";
import { useLoad } from "../../lib/useLoad";

export const GeneralChip = () => <Chip size="small" color="info" variant="outlined" label="عمومی (بدون تجهیز)" />;
const mins = (v: number | null) => (v === null ? "—" : formatMinutes(v));

/** Cell renderers by column key. The column list itself comes from the server registry (GET /reports/columns). */
const CELLS: Record<string, (r: ReportListItem) => ReactNode> = {
  report_number: (r) => <Button component={RouterLink} to={`/reports/${r.id}`} size="small" sx={{ minWidth: 0 }}><Ltr>{r.report_number}</Ltr></Button>,
  event_datetime: (r) => formatJalaliDateTime(r.event_datetime),
  created_at: (r) => formatJalaliDateTime(r.created_at),
  report_type: (r) => r.report_type.name_fa,
  group: (r) => r.group.name,
  equipment: (r) => (r.equipment ? <Ltr>{r.equipment.code}</Ltr> : <GeneralChip />),
  creator: (r) => r.creator.full_name,
  description_summary: (r) => r.description_summary,
  my_minutes: (r) => mins(r.my_minutes),
  total_minutes: (r) => mins(r.total_minutes),
  people_count: (r) => (r.people_count === null ? "—" : formatJalaliDigits(r.people_count)),
};
const formatJalaliDigits = (n: number) => String(n).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);

/** Start of a Jalali day (or its last minute). "" = no bound; null = typed text is not a real date. */
export function dayBound(text: string, end: boolean): string | "" | null {
  if (!text.trim()) return "";
  const d = parseJalaliDateText(text);
  const at = d && jalaliToDate({ ...d, hour: end ? 23 : 0, minute: end ? 59 : 0 });
  return at ? at.toISOString() : null;
}

function useDebounced<T>(value: T, ms = 350): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export function ReportsListPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const theme = useTheme();
  const phone = !useMediaQuery(theme.breakpoints.up("md")); // same breakpoint as AppShell (tests report "desktop")
  const [params, setParams] = useSearchParams();
  const equipmentId = Number(params.get("equipment_id")) || undefined;
  const equipmentLabel = params.get("equipment") ?? "";

  const [f, setF] = useState({ type: "" as number | "", group: "" as number | "", code: "", number: "", q: "", from: "", to: "", mine: false, general: false });
  const [sort, setSort] = useState<{ by: "event_datetime" | "created_at"; order: "asc" | "desc" }>({ by: "event_datetime", order: "desc" });
  const text = useDebounced({ code: f.code, number: f.number, q: f.q, from: f.from, to: f.to });
  const from = dayBound(text.from, false);
  const to = dayBound(text.to, true);

  const query: ReportListQuery = {
    report_type_id: f.type === "" ? undefined : f.type, group_id: f.group === "" ? undefined : f.group, equipment_id: equipmentId,
    equipment_code: text.code.trim() || undefined, report_number: text.number.trim() || undefined, q: text.q.trim() || undefined,
    date_from: from || undefined, date_to: to || undefined, mine: f.mine || undefined, general_only: f.general || undefined,
    sort_by: sort.by, order: sort.order,
  };
  const key = JSON.stringify(query);
  const keyRef = useRef(key);
  useEffect(() => { keyRef.current = key; }, [key]);

  const columns = useLoad(() => reportsApi.columns(), []);
  const types = useLoad(() => reportTypesApi.list(true), []);
  const groups = useLoad(() => groupsApi.list({ limit: 100, offset: 0, include_inactive: true }), []);
  const [items, setItems] = useState<ReportListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [other, setOther] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyMore, setBusyMore] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true); setError(null); setBusyMore(false);
    reportsApi.list(query, ac.signal)
      .then((p) => { setItems(p.items); setCursor(p.next_cursor); setOther(p.other_group_reports_may_exist); })
      .catch((e) => { if (!ac.signal.aborted) setError(e); })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  async function more() {
    if (!cursor) return;
    const startedWith = key;
    setBusyMore(true);
    try {
      const p = await reportsApi.list({ ...query, cursor });
      if (keyRef.current !== startedWith) return; // the filters changed meanwhile: this page belongs to an old list
      setItems((old) => [...old, ...p.items]); setCursor(p.next_cursor);
    } catch (e) { if (keyRef.current === startedWith) setError(e); } finally { if (keyRef.current === startedWith) setBusyMore(false); }
  }

  const visible = (columns.data ?? []).filter((c) => c.default_visible && CELLS[c.key]);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((o) => ({ ...o, [k]: v }));
  const dateError = (v: string | null) => (v === null ? "تاریخ شمسی معتبر نیست (مثل ۱۴۰۵/۰۷/۲۵)" : undefined);
  const sortBy = (k: string) => {
    if (k !== "event_datetime" && k !== "created_at") return;
    setSort((o) => ({ by: k, order: o.by === k && o.order === "desc" ? "asc" : "desc" }));
  };

  return (
    <>
      <PageHeader title="گزارش‌ها" actions={canReport(user) && <Button variant="contained" startIcon={<AddIcon />} onClick={() => navigate("/reports/new")}>ثبت گزارش</Button>} />
      {equipmentId && (
        <Chip sx={{ mb: 1.5 }} color="primary" label={`تاریخچه تجهیز ${equipmentLabel || equipmentId}`} onDelete={() => setParams({}, { replace: true })} />
      )}
      <Stack direction={{ xs: "column", md: "row" }} gap={1.5} flexWrap="wrap" sx={{ mb: 1.5 }}>
        <TextField size="small" label="شماره گزارش" value={f.number} onChange={(e) => set("number", e.target.value)} slotProps={{ htmlInput: { dir: "ltr" } }} />
        <TextField size="small" label="کد تجهیز" value={f.code} onChange={(e) => set("code", e.target.value)} slotProps={{ htmlInput: { dir: "ltr" } }} />
        <TextField size="small" label="جستجو در شرح" value={f.q} onChange={(e) => set("q", e.target.value)} />
        <FormControl size="small" sx={{ minWidth: 160 }}>
          <InputLabel id="rt-type">نوع گزارش</InputLabel>
          <Select labelId="rt-type" label="نوع گزارش" value={f.type} onChange={(e) => set("type", e.target.value as number | "")}>
            <MenuItem value="">همه</MenuItem>
            {(types.data ?? []).map((t) => <MenuItem key={t.id} value={t.id}>{t.name_fa}</MenuItem>)}
          </Select>
        </FormControl>
        <FormControl size="small" sx={{ minWidth: 160 }}>
          <InputLabel id="rt-group">گروه</InputLabel>
          <Select labelId="rt-group" label="گروه" value={f.group} onChange={(e) => set("group", e.target.value as number | "")}>
            <MenuItem value="">همه</MenuItem>
            {(groups.data?.items ?? []).map((g) => <MenuItem key={g.id} value={g.id}>{g.name}</MenuItem>)}
          </Select>
        </FormControl>
        <TextField size="small" label="از تاریخ (شمسی)" value={f.from} error={from === null} helperText={dateError(from)} onChange={(e) => set("from", e.target.value)} slotProps={{ htmlInput: { dir: "ltr", inputMode: "numeric" } }} />
        <TextField size="small" label="تا تاریخ (شمسی)" value={f.to} error={to === null} helperText={dateError(to)} onChange={(e) => set("to", e.target.value)} slotProps={{ htmlInput: { dir: "ltr", inputMode: "numeric" } }} />
        <FormControlLabel control={<Checkbox checked={f.mine} onChange={(e) => set("mine", e.target.checked)} />} label="مشارکت من" />
        <FormControlLabel control={<Checkbox checked={f.general} onChange={(e) => set("general", e.target.checked)} />} label="فقط عمومی" />
      </Stack>
      {other && <Alert severity="info" sx={{ mb: 1.5 }}>ممکن است گزارش‌هایی از گروه قبلی وجود داشته باشد.</Alert>}
      <ErrorAlert error={error} />
      {loading && items.length === 0 ? <Loading /> : items.length === 0 && !error ? <Empty text="گزارشی پیدا نشد." /> : phone ? (
        <Stack gap={1}>
          {items.map((r) => (
            <Card key={r.id} variant="outlined">
              <CardActionArea component={RouterLink} to={`/reports/${r.id}`}>
                <CardContent>
                  <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1}>
                    <Typography fontWeight={700}><Ltr>{r.report_number}</Ltr></Typography>
                    {r.equipment ? <Ltr>{r.equipment.code}</Ltr> : <GeneralChip />}
                  </Stack>
                  <Typography variant="body2" color="text.secondary">{r.report_type.name_fa} · {r.group.name} · {formatJalaliDateTime(r.event_datetime)}</Typography>
                  <Typography variant="body2" sx={{ mt: 0.5 }}>{r.description_summary}</Typography>
                  <Typography variant="caption" color="text.secondary">{r.creator.full_name}{r.my_minutes !== null ? ` · زمان من: ${mins(r.my_minutes)}` : ""}</Typography>
                </CardContent>
              </CardActionArea>
            </Card>
          ))}
        </Stack>
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                {visible.map((c) => (
                  <TableCell key={c.key} sortDirection={sort.by === c.key ? sort.order : false}>
                    {c.sortable ? <TableSortLabel active={sort.by === c.key} direction={sort.by === c.key ? sort.order : "desc"} onClick={() => sortBy(c.key)}>{c.label_fa}</TableSortLabel> : c.label_fa}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {items.map((r) => <TableRow key={r.id} hover>{visible.map((c) => <TableCell key={c.key}>{CELLS[c.key](r)}</TableCell>)}</TableRow>)}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      {cursor && <Box sx={{ textAlign: "center", mt: 2 }}><Button variant="outlined" onClick={() => void more()} disabled={busyMore}>بیشتر</Button></Box>}
    </>
  );
}
