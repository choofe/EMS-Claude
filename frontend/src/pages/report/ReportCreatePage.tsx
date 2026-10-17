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
import { buildCreateBody, emptyState, fromDraftPayload, isBlank, laborMode, laborVisible, toDraftPayload, validate, withDefaultLabor, type EquipmentOption, type FormState, type Issue } from "./reportForm";

const AUTOSAVE_MS = 1500;
export const HEARTBEAT_MS = 60_000;

interface Boot { cfg: EntryConfig; types: ReportType[]; draft: Draft | null; state: FormState | null; quick: Awaited<ReturnType<typeof reportsApi.quickPick>> | null }

/** Everything the form needs, and the latest draft re-resolved against the server (its ids are untrusted). */
async function bootstrap(): Promise<Boot> {
  const [cfg, types, drafts, quick] = await Promise.all([
    reportsApi.entryConfig(), reportTypesApi.list(false), reportsApi.drafts(), reportsApi.quickPick().catch(() => null),
  ]);
  const draft = drafts[0] ?? null;
  if (!draft) return { cfg, types, draft, state: null, quick };
  const p = draft.payload;
  const equipment: EquipmentOption | null = p.equipment_id
    ? await equipmentApi.get(p.equipment_id).then((e) => (e.is_active ? e : null)).catch(() => null) : null;
  const ctx = equipment ? { equipment_id: equipment.id } : p.group_id ? { group_id: p.group_id } : null;
  const names: Record<number, string> = {};
  if (ctx && (p.participants ?? []).some((x) => x.user_id !== null)) {
    for (const c of await reportsApi.candidates({ ...ctx, limit: 100 }).catch(() => [])) names[c.id] = c.full_name;
  }
  return { cfg, types, draft, state: fromDraftPayload(p, { equipment, names }), quick };
}

export function ReportCreatePage() {
  const [epoch, setEpoch] = useState(0);
  const { data, error, loading } = useLoad(bootstrap, [epoch]);
  return (
    <>
      <PageHeader title="ثبت گزارش" />
      <ErrorAlert error={error} />
      {loading && !data ? <Loading /> : data && <ReportForm key={epoch} boot={data} onReload={() => setEpoch((n) => n + 1)} />}
    </>
  );
}

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved"; at: Date } | { kind: "error"; error: unknown } | { kind: "conflict" };

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

  const type = types.find((t) => t.id === form.typeId);
  const mode = laborMode(type);
  const formRef = useRef(form);
  formRef.current = form;
  const draftRef = useRef<{ id: number; version: number } | null>(boot.draft ? { id: boot.draft.id, version: boot.draft.version } : null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const halted = useRef(false); // set on version conflict / submit: no more autosaves
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
        try {
          if (draftRef.current) {
            const d = await reportsApi.updateDraft(draftRef.current.id, payload, draftRef.current.version);
            draftRef.current = { id: d.id, version: d.version };
          } else {
            const d = await reportsApi.createDraft(payload);
            draftRef.current = { id: d.id, version: d.version };
          }
        } catch (e) {
          if (e instanceof ApiError && e.code === "draft_not_found" && draftRef.current) { // deleted elsewhere: start a new one
            draftRef.current = null;
            const d = await reportsApi.createDraft(payload);
            draftRef.current = { id: d.id, version: d.version };
          } else throw e;
        }
        setSave({ kind: "saved", at: new Date() });
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.code === "draft_version_conflict") { halted.current = true; setSave({ kind: "conflict" }); }
        else setSave({ kind: "error", error: e });
        return false;
      }
    };
    const p = chain.current.then(run, run);
    chain.current = p.catch(() => undefined);
    return p;
  }, []);

  // autosave: 1.5 s after the last change
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (halted.current) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { void saveNow(); }, AUTOSAVE_MS);
    return () => clearTimeout(timer.current);
  }, [form, saveNow]);

  // heartbeat: proves the session is alive while the form is open
  useEffect(() => {
    const id = setInterval(() => { reportsApi.heartbeat().then(() => setOnline(true)).catch(() => setOnline(false)); }, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, []);

  // single group the user may use -> preselect for general reports
  useEffect(() => {
    if (cfg.groups.length === 1 && form.groupId === "" && !form.equipment && type && !type.equipment_required) setForm((f) => ({ ...f, groupId: cfg.groups[0].id }));
  }, [cfg.groups, form.equipment, form.groupId, type]);

  const patch = (p: Partial<FormState>) => setForm((f) => ({ ...f, ...p }));
  const chooseType = (id: number) => setForm((f) => withDefaultLabor({ ...f, typeId: id }, types.find((t) => t.id === id), author, cfg.default_labor_minutes));
  const openLabor = () => setForm((f) => withDefaultLabor({ ...f, laborOpened: true }, type, author, cfg.default_labor_minutes));
  // who may be listed depends on the report's group: from the equipment, or the explicit group of a general report
  // Eligible participants depend on the report's group. When the group changes (other equipment / other group), people who
  // are not eligible there are removed with a visible notice; the server re-checks everything on submit anyway.
  const groupKey = form.equipment ? form.equipment.group_id : type && !type.equipment_required && form.groupId !== "" ? form.groupId : null;
  const lastGroup = useRef<number | null>(groupKey);
  const context = form.equipment ? { equipment_id: form.equipment.id } : type && !type.equipment_required && form.groupId !== "" ? { group_id: form.groupId } : null;
  const issueOf = (field: Issue["field"]) => issues.find((i) => i.field === field)?.message;
  const laborIssues = issues.filter((i) => i.field === "labor").map((i) => i.message).join(" ");

  useEffect(() => {
    if (groupKey === null) return;
    const previous = lastGroup.current;
    lastGroup.current = groupKey;
    if (previous === null || previous === groupKey) return;
    if (!formRef.current.labor.some((r) => r.userId !== null)) return;
    const ctx = formRef.current.equipment ? { equipment_id: formRef.current.equipment.id } : { group_id: groupKey };
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
    await chain.current; // let an in-flight save finish so we submit from its draft
    try {
      const report = await reportsApi.create(buildCreateBody(form, type, draftRef.current?.id ?? null));
      draftRef.current = null; // consumed by the server in the same transaction
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
    await chain.current;
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
        <Button variant="contained" onClick={() => { draftRef.current = null; halted.current = false; first.current = true; setCreated(null); setForm(emptyState()); setIssues([]); setSave({ kind: "idle" }); }}>
          ثبت گزارش جدید
        </Button>
      </Paper>
    );
  }

  return (
    <Stack gap={2} component="form" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      {restored && <Alert severity="info" action={<Button color="inherit" size="small" onClick={() => void discardDraft()}>دورانداختن پیش‌نویس</Button>}>پیش‌نویس قبلی شما بازیابی شد.</Alert>}
      {!online && <Alert severity="warning">ارتباط با سرور قطع است. تا برقراری ارتباط، تغییرات ذخیره نمی‌شوند؛ صفحه را نبندید.</Alert>}
      {save.kind === "conflict" && (
        <Alert severity="error" action={<Button color="inherit" size="small" onClick={onReload}>بارگذاری نسخهٔ ذخیره‌شده</Button>}>
          {errorMessage(new ApiError(409, "draft_version_conflict"))} ذخیرهٔ خودکار متوقف شد تا نسخهٔ دیگر بازنویسی نشود.
        </Alert>
      )}

      {notice && <Alert severity="warning" onClose={() => setNotice(null)}>{notice}</Alert>}

      <TextField select label="نوع گزارش" value={form.typeId} onChange={(e) => chooseType(Number(e.target.value))} error={!!issueOf("type")} helperText={issueOf("type")}>
        {types.map((t) => <MenuItem key={t.id} value={t.id}>{t.name_fa}</MenuItem>)}
      </TextField>

      <EquipmentPicker value={form.equipment} quick={boot.quick} optional={!!type && !type.equipment_required} error={issueOf("equipment")}
        onChange={(e) => patch({ equipment: e, groupId: e ? "" : form.groupId })} />

      {!form.equipment && type && !type.equipment_required && (
        <TextField select label="گروه" value={form.groupId} onChange={(e) => patch({ groupId: Number(e.target.value) })} error={!!issueOf("group")}
          helperText={issueOf("group") ?? "این نوع گزارش بدون تجهیز ثبت می‌شود؛ گروه گزارش را مشخص کنید."}>
          {cfg.groups.map((g) => <MenuItem key={g.id} value={g.id}>{g.name} ({g.code})</MenuItem>)}
        </TextField>
      )}

      <DateTimeField dateText={form.dateText} timeText={form.timeText} error={issueOf("datetime")} onChange={(v) => patch(v)} />

      <TextField label="شرح گزارش" multiline minRows={4} value={form.description} onChange={(e) => patch({ description: e.target.value })}
        error={!!issueOf("description")} helperText={issueOf("description") ?? `${toPersianDigits(String(form.description.length))} / ${toPersianDigits(String(cfg.max_description_length))}`} />

      {type && mode === "ON_REQUEST" && !form.laborOpened && (
        <Box><Button variant="outlined" onClick={openLabor}>اضافه کردن ساعات افراد - اختیاری</Button></Box>
      )}
      {type && laborVisible(type, form) && (
        <LaborSection mode={mode} rows={form.labor} context={context} author={author} authorRemoved={form.authorRemoved} maxMinutes={cfg.max_participant_minutes}
          error={laborIssues || undefined}
          onChange={(rows, removed) => patch({ labor: rows, authorRemoved: removed ? form.authorRemoved || removed.userId === author.id : form.authorRemoved && !rows.some((r) => r.userId === author.id) })} />
      )}

      <ErrorAlert error={serverError} />

      <Stack direction={{ xs: "column", sm: "row" }} gap={1.5} alignItems={{ sm: "center" }}>
        <Button type="submit" variant="contained" size="large" disabled={submitting}>ثبت گزارش</Button>
        <Button variant="outlined" startIcon={<SaveIcon />} disabled={submitting} onClick={() => { halted.current = false; clearTimeout(timer.current); void saveNow(); }}>ذخیرهٔ پیش‌نویس</Button>
        <SaveStatus state={save} />
      </Stack>
    </Stack>
  );
}

function SaveStatus({ state }: { state: SaveState }) {
  if (state.kind === "saving") return <Chip size="small" label="در حال ذخیرهٔ پیش‌نویس…" />;
  if (state.kind === "saved") return <Chip size="small" color="success" variant="outlined" label={`پیش‌نویس ذخیره شد ${formatJalaliDateTime(state.at).split(" ")[1]}`} />;
  if (state.kind === "error") return <Chip size="small" color="error" variant="outlined" label={`ذخیرهٔ پیش‌نویس انجام نشد: ${errorMessage(state.error)}`} />;
  return null;
}
