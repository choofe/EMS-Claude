import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  Alert, Badge, Box, Button, Card, CardActionArea, CardContent, Checkbox, Chip, FormControl, FormControlLabel, InputLabel, MenuItem, Paper, Select, Stack,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TableSortLabel, TextField, Typography, useMediaQuery, useTheme,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import FilterIcon from "@mui/icons-material/FilterListOutlined";
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

/** At most two lines of the summary; the full text is on the detail page. */
const Clamp = ({ children }: { children: ReactNode }) => (
  <Box data-testid="summary" sx={{ maxWidth: 320, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", overflowWrap: "anywhere" }}>{children}</Box>
);
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
  description_summary: (r) => <Clamp>{r.description_summary}</Clamp>,
  my_minutes: (r) => mins(r.my_minutes),
  total_minutes: (r) => mins(r.total_minutes),
  people_count: (r) => (r.people_count === null ? "—" : formatJalaliDigits(r.people_count)),
};
const formatJalaliDigits = (n: number) => String(n).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);

/**
 * Return a UTC ISO bound for a Jalali date in Tehran: midnight, or 23:59:59.999 when `end` is true.
 * Blank text returns "" (no bound); malformed, unsupported, or nonexistent dates return null.
 */
export function dayBound(text: string, end: boolean): string | "" | null {
  if (!text.trim()) return "";
  const d = parseJalaliDateText(text);
  const at = d && jalaliToDate({ ...d, hour: end ? 23 : 0, minute: end ? 59 : 0 });
  // the server compares date_to inclusively: the end bound is the last millisecond of the day, not 23:59:00
  return at ? new Date(at.getTime() + (end ? 59_999 : 0)).toISOString() : null;
}

/**
 * Return the initial value immediately, then follow changes after `ms` milliseconds of quiet (350 by default).
 * Compare JSON serialization, so fresh objects with equal serialized content do not restart the timer.
 * Values must be JSON-serializable; serialization errors propagate during render.
 */
export function useDebounced<T>(value: T, ms = 350): T {
  const [v, setV] = useState(value);
  const content = JSON.stringify(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [content, ms]); // eslint-disable-line react-hooks/exhaustive-deps
  return v;
}

/** Render filtered reports as desktop columns or phone cards, with cursor pagination and optional equipment history from the URL. */
export function ReportsListPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const theme = useTheme();
  const desktop = useMediaQuery(theme.breakpoints.up("md")); // same breakpoint as AppShell (tests report "desktop")
  const phone = !desktop;
  const [filtersOpen, setFiltersOpen] = useState<boolean | null>(null); // null = default: open on desktop, closed on a phone
  const showFilters = filtersOpen ?? desktop;
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
  useLayoutEffect(() => { keyRef.current = key; }, [key]); // synchronous in the commit: a late «بیشتر» answer must see the new key
  const moreAbort = useRef<AbortController | null>(null);

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
    // the HTTP client detaches the abort listener once the headers arrive, so an aborted request can still deliver its body: check explicitly
    const stale = () => ac.signal.aborted || keyRef.current !== key;
    moreAbort.current?.abort(); // a pending «بیشتر» of the previous filters is cancelled too
    setLoading(true); setError(null); setBusyMore(false);
    reportsApi.list(query, ac.signal)
      .then((p) => { if (!stale()) { setItems(p.items); setCursor(p.next_cursor); setOther(p.other_group_reports_may_exist); } })
      .catch((e) => { if (!stale()) setError(e); })
      .finally(() => { if (!stale()) setLoading(false); });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  /** Append the next page if a cursor exists; ignore stale responses and show current request errors in the page. */
  async function more() {
    if (!cursor) return;
    const startedWith = key;
    const ac = new AbortController();
    const stale = () => ac.signal.aborted || keyRef.current !== startedWith; // aborted even if the key came back to the same value
    moreAbort.current = ac;
    setBusyMore(true);
    try {
      const p = await reportsApi.list({ ...query, cursor }, ac.signal);
      if (stale()) return; // the filters changed meanwhile: this page belongs to an old list
      setItems((old) => [...old, ...p.items]); setCursor(p.next_cursor);
    } catch (e) { if (!stale()) setError(e); } finally { if (!stale()) setBusyMore(false); }
  }

  const visible = (columns.data ?? []).filter((c) => c.default_visible && CELLS[c.key]);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((o) => ({ ...o, [k]: v }));
  const dateError = (v: string | null) => (v === null ? "تاریخ شمسی معتبر نیست (مثل ۱۴۰۵/۰۷/۲۵)" : undefined);
  const activeFilters = [f.type !== "", f.group !== "", f.code.trim(), f.number.trim(), f.q.trim(), f.from.trim(), f.to.trim(), f.mine, f.general].filter(Boolean).length;
  const clearFilters = () => setF({ type: "", group: "", code: "", number: "", q: "", from: "", to: "", mine: false, general: false });
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
      <Stack direction="row" gap={1} alignItems="center" sx={{ mb: 1.5 }}>
        <Badge color="primary" badgeContent={activeFilters} invisible={activeFilters === 0}>
          <Button variant={showFilters ? "contained" : "outlined"} size="small" startIcon={<FilterIcon />} aria-expanded={showFilters} onClick={() => setFiltersOpen(!showFilters)}>فیلتر و مرتب‌سازی</Button>
        </Badge>
        {activeFilters > 0 && <Button size="small" onClick={clearFilters}>پاک کردن فیلترها</Button>}
      </Stack>
      {showFilters && (
      <Stack direction={{ xs: "column", md: "row" }} gap={1.5} flexWrap="wrap" sx={{ mb: 1.5 }}>
        <FormControl size="small" sx={{ minWidth: 180 }}>
          <InputLabel id="rt-sort">مرتب‌سازی</InputLabel>
          <Select labelId="rt-sort" label="مرتب‌سازی" value={`${sort.by}:${sort.order}`} onChange={(e) => { const [by, order] = String(e.target.value).split(":"); setSort({ by: by as typeof sort.by, order: order as typeof sort.order }); }}>
            <MenuItem value="event_datetime:desc">جدیدترین رخداد</MenuItem>
            <MenuItem value="event_datetime:asc">قدیمی‌ترین رخداد</MenuItem>
            <MenuItem value="created_at:desc">جدیدترین ثبت</MenuItem>
            <MenuItem value="created_at:asc">قدیمی‌ترین ثبت</MenuItem>
          </Select>
        </FormControl>
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
      )}
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
                  <Typography variant="body2" sx={{ mt: 0.5 }}><Clamp>{r.description_summary}</Clamp></Typography>
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
