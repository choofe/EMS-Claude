import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Box, Button, Chip, MenuItem, Paper, Stack, TextField, Typography } from "@mui/material";
import SaveIcon from "@mui/icons-material/SaveOutlined";
import { ApiError } from "../../api/http";
import { equipmentApi, reportTypesApi, reportsApi } from "../../api/resources";
import type { Draft, EntryConfig, ReportCreated, ReportType } from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { ErrorAlert, Loading, PageHeader } from "../../components/common";
import { formatJalaliDateTime, toPersianDigits } from "../../lib/dates";
import { useLoad } from "../../lib/useLoad";
import { errorMessage } from "../../i18n/messages";
import { DateTimeField } from "./DateTimeField";
import { LaborSection } from "./LaborSection";
import { EquipmentPicker } from "./pickers";
import { TypePicker, typeSummary } from "./TypePicker";
import {
  buildCreateBody, effectiveEquipment, emptyState, equipmentMode, equipmentVisible, fromDraftPayload, hiddenByTypeChange, isBlank,
  laborMode, laborVisible, needsGroup, participantContext, toDraftPayload, validate, withDefaultLabor,
  type EquipmentOption, type FormState, type Issue,
} from "./reportForm";

const AUTOSAVE_MS = 1500;
const SAVE_WAIT_MS = 8000; // how long a submit waits for an in-flight autosave before going ahead
export const HEARTBEAT_MS = 60_000;

const lastTypeKey = (userId: number) => `ems.lastReportType.${userId}`;
function readLastType(userId: number): number | null {
  try { const v = localStorage.getItem(lastTypeKey(userId)); return v ? Number(v) : null; } catch { return null; }
}
function writeLastType(userId: number, typeId: number) {
  try { localStorage.setItem(lastTypeKey(userId), String(typeId)); } catch { /* private mode: not essential */ }
}

interface Boot { cfg: EntryConfig; types: ReportType[]; draft: Draft | null; state: FormState | null; quick: Awaited<ReturnType<typeof reportsApi.quickPick>> | null }

/** Everything the form needs, and the user's one draft re-resolved against the server (its ids are untrusted). */
async function bootstrap(author: { id: number; full_name: string }): Promise<Boot> {
  const [cfg, types, drafts, quick] = await Promise.all([
    reportsApi.entryConfig(), reportTypesApi.list(false), reportsApi.drafts(), reportsApi.quickPick().catch(() => null),
  ]);
  const draft = drafts[0] ?? null;
  if (!draft) return { cfg, types, draft, state: null, quick };
  const p = draft.payload;
  const equipment: EquipmentOption | null = p.equipment_id
    ? await equipmentApi.get(p.equipment_id).then((e) => (e.is_active ? e : null)).catch(() => null) : null;
  const ctx = equipment ? { equipment_id: equipment.id } : p.group_id ? { group_id: p.group_id } : null;
  const names: Record<number, string> = { [author.id]: author.full_name };
  if (ctx && (p.participants ?? []).some((x) => x.user_id !== null)) {
    for (const c of await reportsApi.candidates({ ...ctx, limit: 100 }).catch(() => [])) names[c.id] = c.full_name;
  }
  return { cfg, types, draft, state: fromDraftPayload(p, { equipment, names }), quick };
}

export function ReportCreatePage() {
  const [epoch, setEpoch] = useState(0);
  const { user } = useAuth();
  // Each load is stamped with the epoch it belongs to, so a form is only ever built from data of the CURRENT epoch.
  // (Rendering the previous load's data while the new one was in flight resurrected a discarded draft — or showed a blank form
  // after "load the saved version" — because the form copies its boot data into state once, when it mounts.)
  const { data, error, loading } = useLoad(() => { const e = epoch; return bootstrap({ id: user!.id, full_name: user!.full_name }).then((boot) => ({ boot, e })); }, [epoch]);
  return (
    <>
      <PageHeader title="ثبت گزارش" />
      <ErrorAlert error={error} />
      {loading ? <Loading /> : data && data.e === epoch ? <ReportForm key={epoch} boot={data.boot} onReload={() => setEpoch((n) => n + 1)} /> : null}
    </>
  );
}

type SaveState =
  | { kind: "idle" } | { kind: "saving" } | { kind: "saved"; at: Date } | { kind: "error"; error: unknown }
  | { kind: "conflict" }   // the draft was changed (or another one created) on another tab/device
  | { kind: "gone" };      // the draft was submitted or deleted on another tab/device

function ReportForm({ boot, onReload }: { boot: Boot; onReload: () => void }) {
  const { user } = useAuth();
  const { cfg, types } = boot;
  const author = { id: user!.id, full_name: user!.full_name };
  const [form, setForm] = useState<FormState>(boot.state ?? emptyState());
  const [restored] = useState(boot.draft !== null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [serverError, setServerError] = useState<unknown>(null);
  const [created, setCreated] = useState<ReportCreated | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [online, setOnline] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [typeNotices, setTypeNotices] = useState<string[]>([]);
  const [changingType, setChangingType] = useState(false);
  const [lastType, setLastType] = useState<number | null>(() => readLastType(user!.id));

  const type = types.find((t) => t.id === form.typeId);
  const formRef = useRef(form);
  formRef.current = form;
  const draftRef = useRef<{ id: number; version: number } | null>(boot.draft ? { id: boot.draft.id, version: boot.draft.version } : null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const halted = useRef(false); // set on conflict / gone / submit: no more autosaves
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const first = useRef(true);

  const saveNow = useCallback((): Promise<boolean> => {
    const run = async (): Promise<boolean> => {
      if (halted.current) return false;
      const s = formRef.current;
      if (isBlank(s) && !draftRef.current) return true; // nothing worth a server row
      setSave({ kind: "saving" });
      const payload = toDraftPayload(s);
      try {
        const d = draftRef.current
          ? await reportsApi.updateDraft(draftRef.current.id, payload, draftRef.current.version)
          : await reportsApi.createDraft(payload);
        draftRef.current = { id: d.id, version: d.version };
        dirty.current = false;
        setSave({ kind: "saved", at: new Date() });
        return true;
      } catch (e) {
        if (e instanceof ApiError && (e.code === "draft_version_conflict" || e.code === "draft_limit_reached")) {
          halted.current = true; setSave({ kind: "conflict" });
        } else if (e instanceof ApiError && e.code === "draft_not_found") {
          // Submitted/deleted elsewhere. NEVER recreate it from this (stale) tab: that resurrected drafts of reports already sent.
          halted.current = true; draftRef.current = null; setSave({ kind: "gone" });
        } else setSave({ kind: "error", error: e });
        return false;
      }
    };
    const p = chain.current.then(run, run);
    chain.current = p.catch(() => undefined);
    return p;
  }, []);

  // autosave: 1.5 s after the last edit
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    dirty.current = true;
    if (halted.current) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { void saveNow(); }, AUTOSAVE_MS);
    return () => clearTimeout(timer.current);
  }, [form, saveNow]);

  // phones suspend or kill a backgrounded page: save at once when the page is hidden (switching app, locking the screen)
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState !== "hidden" || halted.current || !dirty.current) return;
      clearTimeout(timer.current);
      void saveNow();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [saveNow]);

  // heartbeat: proves the session is alive while the form is open
  useEffect(() => {
    const id = setInterval(() => { reportsApi.heartbeat().then(() => setOnline(true)).catch(() => setOnline(false)); }, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, []);

  const eq = effectiveEquipment(type, form);
  const groupNeeded = needsGroup(type, form);

  // a single group the user may use -> preselect it for general reports
  useEffect(() => {
    if (cfg.groups.length === 1 && form.groupId === "" && groupNeeded) setForm((f) => ({ ...f, groupId: cfg.groups[0].id }));
  }, [cfg.groups, form.groupId, groupNeeded]);

  const patch = (p: Partial<FormState>) => setForm((f) => ({ ...f, ...p }));

  function chooseType(id: number) {
    const next = types.find((t) => t.id === id);
    const moved = { ...form, typeId: id };
    setTypeNotices(hiddenByTypeChange(type, next, moved));
    setForm(withDefaultLabor(moved, next, author, cfg.default_labor_minutes));
    setChangingType(false);
    setLastType(id);
    writeLastType(user!.id, id);
  }
  const openLabor = () => setForm((f) => withDefaultLabor({ ...f, laborOpened: true }, type, author, cfg.default_labor_minutes));
  const context = participantContext(type, form);
  const issueOf = (field: Issue["field"]) => issues.find((i) => i.field === field)?.message;
  const laborIssues = issues.filter((i) => i.field === "labor").map((i) => i.message).join(" ");

  // Eligible participants depend on the report's group. When the group changes, people who are not eligible there are
  // removed with a visible notice; the server re-checks everything on submit anyway.
  const groupKey = eq ? eq.group_id : groupNeeded && form.groupId !== "" ? form.groupId : null;
  const lastGroup = useRef<number | null>(groupKey);
  useEffect(() => {
    if (groupKey === null) return;
    const previous = lastGroup.current;
    lastGroup.current = groupKey;
    if (previous === null || previous === groupKey) return;
    if (!formRef.current.labor.some((r) => r.userId !== null)) return;
    const ctx = eq ? { equipment_id: eq.id } : { group_id: groupKey };
    let alive = true;
    reportsApi.candidates({ ...ctx, limit: 100 }).then((list) => {
      if (!alive || list.length >= 100) return; // an incomplete list proves nothing: leave it to the server
      const ok = new Set(list.map((c) => c.id));
      const gone = formRef.current.labor.filter((r) => r.userId !== null && !ok.has(r.userId));
      if (gone.length === 0) return;
      setForm((f) => ({
        ...f, labor: f.labor.filter((r) => r.userId === null || ok.has(r.userId)),
        authorRemoved: f.authorRemoved || gone.some((r) => r.userId === author.id),
      }));
      setNotice(`گروه گزارش تغییر کرد؛ این افراد در گروه جدید مجاز نیستند و از فهرست ساعت‌ها حذف شدند: ${gone.map((r) => r.name).join("، ")}`);
    }).catch(() => undefined);
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupKey]);

  async function submit() {
    setServerError(null);
    const found = validate(form, type, cfg);
    setIssues(found);
    if (found.length || !type) return;
    halted.current = true; // no autosave may race with the submit
    clearTimeout(timer.current);
    setSubmitting(true);
    // let an in-flight save finish so we submit from its draft — but never wait forever (offline: that froze the page)
    await Promise.race([chain.current, new Promise((r) => setTimeout(r, SAVE_WAIT_MS))]);
    if (!draftRef.current) {
      // Always submit FROM a draft: the server consumes it in the same transaction, so a retry after a lost response
      // (flaky mall Wi-Fi) answers "draft not found" instead of silently creating a second report with doubled hours.
      try {
        const d = await reportsApi.createDraft(toDraftPayload(form));
        draftRef.current = { id: d.id, version: d.version };
      } catch { /* e.g. another draft exists elsewhere, or offline: submit without the retry protection */ }
    }
    try {
      const report = await reportsApi.create(buildCreateBody(form, type, draftRef.current?.id ?? null));
      draftRef.current = null; // consumed by the server in the same transaction
      writeLastType(user!.id, type.id);
      setCreated(report);
    } catch (e) {
      setServerError(e);
      if (e instanceof ApiError && e.code === "draft_not_found") draftRef.current = null;
      halted.current = false;
    } finally {
      setSubmitting(false);
    }
  }

  async function discardDraft() {
    halted.current = true;
    await Promise.race([chain.current, new Promise((r) => setTimeout(r, SAVE_WAIT_MS))]);
    if (draftRef.current) await reportsApi.deleteDraft(draftRef.current.id).catch(() => undefined);
    draftRef.current = null;
    onReload();
  }

  if (created) {
    return (
      <Paper variant="outlined" sx={{ p: 3 }}>
        <Alert severity="success" sx={{ mb: 2 }}>
          گزارش ثبت شد. شمارهٔ گزارش: <Box component="span" dir="ltr" sx={{ fontWeight: 700, unicodeBidi: "embed" }}>{created.report_number}</Box>
        </Alert>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>زمان ثبت در سامانه: {formatJalaliDateTime(created.created_at)}</Typography>
        <Button variant="contained" onClick={() => { draftRef.current = null; halted.current = false; first.current = true; dirty.current = false; setCreated(null); setForm(emptyState()); setIssues([]); setTypeNotices([]); setSave({ kind: "idle" }); }}>
          ثبت گزارش جدید
        </Button>
      </Paper>
    );
  }

  const showChooser = form.typeId === "" || changingType;

  return (
    <Stack gap={2} component="form" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      {restored && <Alert severity="info" action={<Button color="inherit" size="small" onClick={() => void discardDraft()}>دورانداختن پیش‌نویس</Button>}>پیش‌نویس قبلی شما بازیابی شد.</Alert>}
      {!online && <Alert severity="warning">ارتباط با سرور قطع است. تا برقراری ارتباط، تغییرات ذخیره نمی‌شوند؛ صفحه را نبندید.</Alert>}
      {save.kind === "conflict" && (
        <Alert severity="error" action={<Button color="inherit" size="small" onClick={onReload}>بارگذاری نسخهٔ ذخیره‌شده</Button>}>
          {errorMessage(new ApiError(409, "draft_version_conflict"))} ذخیرهٔ خودکار متوقف شد تا نسخهٔ دیگر بازنویسی نشود.
        </Alert>
      )}
      {save.kind === "gone" && (
        <Alert severity="warning" action={<Button color="inherit" size="small" onClick={onReload}>شروع فرم جدید</Button>}>
          {errorMessage(new ApiError(404, "draft_gone"))} ذخیرهٔ خودکار متوقف شد تا پیش‌نویسِ قدیمی دوباره ساخته نشود.
        </Alert>
      )}
      {notice && <Alert severity="warning" onClose={() => setNotice(null)}>{notice}</Alert>}
      {typeNotices.map((n) => <Alert key={n} severity="info" onClose={() => setTypeNotices((l) => l.filter((x) => x !== n))}>{n}</Alert>)}

      {showChooser ? (
        <TypePicker types={types} value={form.typeId} lastUsedId={lastType} onChange={chooseType} error={issueOf("type")} />
      ) : (
        type && (
          <Paper variant="outlined" sx={{ p: 1.5 }}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1}>
              <Box>
                <Typography variant="caption" color="text.secondary">نوع گزارش</Typography>
                <Typography sx={{ fontWeight: 600 }}>{type.name_fa}</Typography>
                <Typography variant="caption" color="text.secondary">{typeSummary(type)}</Typography>
              </Box>
              <Button onClick={() => setChangingType(true)}>تغییر نوع</Button>
            </Stack>
          </Paper>
        )
      )}

      {type && !showChooser && (
        <>
          {equipmentVisible(type, form) ? (
            <EquipmentPicker value={form.equipment} quick={boot.quick} optional={equipmentMode(type) !== "REQUIRED"} error={issueOf("equipment")}
              onChange={(e) => patch({ equipment: e, groupId: e ? "" : form.groupId })} />
          ) : equipmentMode(type) === "OPTIONAL" ? (
            <Box><Button variant="outlined" onClick={() => patch({ equipmentOpened: true })}>افزودن تجهیز - اختیاری</Button></Box>
          ) : null}

          {groupNeeded && (
            <TextField select label="گروه" value={form.groupId} onChange={(e) => patch({ groupId: Number(e.target.value) })} error={!!issueOf("group")}
              helperText={issueOf("group") ?? "این گزارش بدون تجهیز ثبت می‌شود؛ گروه گزارش را مشخص کنید."}>
              {cfg.groups.map((g) => <MenuItem key={g.id} value={g.id}>{g.name} ({g.code})</MenuItem>)}
            </TextField>
          )}

          <DateTimeField dateText={form.dateText} timeText={form.timeText} error={issueOf("datetime")} onChange={(v) => patch(v)} />

          <TextField label="شرح گزارش" multiline minRows={4} value={form.description} onChange={(e) => patch({ description: e.target.value })}
            error={!!issueOf("description")} helperText={issueOf("description") ?? `${toPersianDigits(String(form.description.length))} / ${toPersianDigits(String(cfg.max_description_length))}`} />

          {laborMode(type) === "OPTIONAL" && !form.laborOpened && (
            <Box><Button variant="outlined" onClick={openLabor}>اضافه کردن ساعات افراد - اختیاری</Button></Box>
          )}
          {laborVisible(type, form) && (
            <LaborSection mode={laborMode(type)} rows={form.labor} context={context} author={author} authorRemoved={form.authorRemoved} maxMinutes={cfg.max_participant_minutes}
              error={laborIssues || undefined}
              onChange={(rows, removed) => patch({ labor: rows, authorRemoved: removed ? form.authorRemoved || removed.userId === author.id : form.authorRemoved && !rows.some((r) => r.userId === author.id) })} />
          )}

          <ErrorAlert error={serverError} />

          <Stack direction={{ xs: "column", sm: "row" }} gap={1.5} alignItems={{ sm: "center" }}>
            <Button type="submit" variant="contained" size="large" disabled={submitting}>ثبت گزارش</Button>
            <Button variant="outlined" startIcon={<SaveIcon />} disabled={submitting} onClick={() => { halted.current = false; clearTimeout(timer.current); void saveNow(); }}>ذخیرهٔ پیش‌نویس</Button>
            <SaveStatus state={save} />
          </Stack>
        </>
      )}
      {showChooser && form.typeId === "" && <Typography variant="body2" color="text.secondary">بعد از انتخاب نوع، فرم مناسب همان نوع نمایش داده می‌شود.</Typography>}
    </Stack>
  );
}

function SaveStatus({ state }: { state: SaveState }) {
  if (state.kind === "saving") return <Chip size="small" label="در حال ذخیرهٔ پیش‌نویس…" />;
  if (state.kind === "saved") return <Chip size="small" color="success" variant="outlined" label={`پیش‌نویس ذخیره شد ${formatJalaliDateTime(state.at).split(" ")[1]}`} />;
  if (state.kind === "error") return <Chip size="small" color="error" variant="outlined" label={`ذخیرهٔ پیش‌نویس انجام نشد: ${errorMessage(state.error)}`} />;
  return null;
}
