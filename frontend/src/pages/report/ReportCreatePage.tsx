import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Box, Button, Chip, MenuItem, Paper, Stack, TextField, Typography } from "@mui/material";
import SaveIcon from "@mui/icons-material/SaveOutlined";
import { ApiError } from "../../api/http";
import { equipmentApi, reportTypesApi, reportsApi } from "../../api/resources";
import type { Draft, EntryConfig, ReportCreated, ReportType } from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { ErrorAlert, Loading, PageHeader } from "../../components/common";
import { formatJalaliDateTime, toPersianDigits } from "../../lib/dates";
import { clearAllFor, clearLocal, clearUndo, loadLocal, loadUndo, makeSnapshot, saveLocal, saveUndo, type LocalSnapshot } from "../../lib/localDraft";
import { dueForSave } from "../../lib/saveSchedule";
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

const SAVE_WAIT_MS = 8000; // how long a submit waits for an in-flight save before going ahead
const LOCAL_WRITE_MS = 300; // the device-local working copy is written (almost) on every change
const TICK_MS = 1000; // time-based save thresholds are checked once a second
export const HEARTBEAT_MS = 60_000;

const lastTypeKey = (userId: number) => `ems.lastReportType.${userId}`;
function readLastType(userId: number): number | null {
  try { const v = localStorage.getItem(lastTypeKey(userId)); return v ? Number(v) : null; } catch { return null; }
}
function writeLastType(userId: number, typeId: number) {
  try { localStorage.setItem(lastTypeKey(userId), String(typeId)); } catch { /* private mode: not essential */ }
}

/** One id per submission attempt chain (see the idempotency key in docs/report-creation.md). */
const newRequestId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `r-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

type Restore =
  | { kind: "none" }
  | { kind: "server"; state: FormState }
  | { kind: "local"; snap: LocalSnapshot; goneFromServer: boolean }
  | { kind: "choose"; local: LocalSnapshot; server: { state: FormState; draft: Draft } };

interface Boot { cfg: EntryConfig; types: ReportType[]; draft: Draft | null; restore: Restore; quick: Awaited<ReturnType<typeof reportsApi.quickPick>> | null }

/**
 * Everything the form needs. The user's ONE server draft is re-resolved (its ids are untrusted) and compared with the
 * device-local working copy: restore automatically only when that cannot lose anything, otherwise let the author choose.
 */
async function bootstrap(author: { id: number; full_name: string }): Promise<Boot> {
  const [cfg, types, drafts, quick] = await Promise.all([
    reportsApi.entryConfig(), reportTypesApi.list(false), reportsApi.drafts(), reportsApi.quickPick().catch(() => null),
  ]);
  const draft = drafts[0] ?? null;
  let local = loadLocal(author.id);
  if (local && isBlank(local.form)) { clearLocal(author.id); local = null; }
  if (!draft) return { cfg, types, draft, quick, restore: local ? { kind: "local", snap: local, goneFromServer: local.baseDraftId !== null } : { kind: "none" } };

  const p = draft.payload;
  const equipment: EquipmentOption | null = p.equipment_id
    ? await equipmentApi.get(p.equipment_id).then((e) => (e.is_active ? e : null)).catch(() => null) : null;
  const ctx = equipment ? { equipment_id: equipment.id } : p.group_id ? { group_id: p.group_id } : null;
  const names: Record<number, string> = { [author.id]: author.full_name };
  if (ctx && (p.participants ?? []).some((x) => x.user_id !== null)) {
    for (const c of await reportsApi.candidates({ ...ctx, limit: 100 }).catch(() => [])) names[c.id] = c.full_name;
  }
  const state = fromDraftPayload(p, { equipment, names });
  if (!local) return { cfg, types, draft, quick, restore: { kind: "server", state } };
  if (local.baseDraftId === draft.id && local.baseVersion === draft.version) return { cfg, types, draft, quick, restore: { kind: "local", snap: local, goneFromServer: false } };
  return { cfg, types, draft, quick, restore: { kind: "choose", local, server: { state, draft } } };
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
  | { kind: "gone" };      // the draft was submitted or deleted on another tab/device (or this copy is based on one that was)

const timeOf = (iso: string) => formatJalaliDateTime(iso).split(" ")[1] ?? "";

function ReportForm({ boot, onReload }: { boot: Boot; onReload: () => void }) {
  const { user } = useAuth();
  const { cfg, types, restore } = boot;
  const author = { id: user!.id, full_name: user!.full_name };
  const uid = author.id;
  const initial: FormState = restore.kind === "server" ? restore.state : restore.kind === "local" ? restore.snap.form : emptyState();
  const [form, setForm] = useState<FormState>(initial);
  const [choice, setChoice] = useState(restore.kind === "choose" ? restore : null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [serverError, setServerError] = useState<unknown>(null);
  const [created, setCreated] = useState<ReportCreated | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [save, setSave] = useState<SaveState>(restore.kind === "local" && restore.goneFromServer ? { kind: "gone" } : { kind: "idle" });
  const [submitGone, setSubmitGone] = useState(false);
  const [online, setOnline] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [typeNotices, setTypeNotices] = useState<string[]>([]);
  const [changingType, setChangingType] = useState(false);
  const [lastType, setLastType] = useState<number | null>(() => readLastType(uid));
  const [undo, setUndo] = useState<LocalSnapshot | null>(() => loadUndo(uid));

  const type = types.find((t) => t.id === form.typeId);
  const formRef = useRef(form);
  formRef.current = form;
  const draftRef = useRef<{ id: number; version: number } | null>(boot.draft && restore.kind !== "none" && !(restore.kind === "local" && restore.goneFromServer) ? { id: boot.draft.id, version: boot.draft.version } : null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const halted = useRef(restore.kind === "choose" || (restore.kind === "local" && restore.goneFromServer)); // no autosave while a decision is pending
  const dirty = useRef(restore.kind === "local" && boot.draft?.version !== (restore.snap.baseVersion ?? -1)); // local copy newer than the server
  const dirtySince = useRef<number | null>(dirty.current ? Date.now() : null);
  const saves = useRef(boot.draft ? 3 : 0); // how many server saves were done: later ones need fewer changes (lib/saveSchedule.ts)
  const savedText = useRef(boot.draft?.payload.description ?? "");
  const skipChange = useRef(false); // set right before a programmatic load of the form: that is not an edit
  const lastForm = useRef(form);     // the effect only reacts to a form object that really changed (also under StrictMode double effects)
  const submittingRef = useRef(false);
  const submitted = useRef(false); // after a successful submit nothing may be written locally or sent to the server any more
  const requestId = useRef(newRequestId());
  const localTimer = useRef<ReturnType<typeof setTimeout>>();

  /** Write the device-local working copy now (never touches the server). */
  const persistLocal = useCallback(() => {
    if (submitted.current) return;
    const s = formRef.current;
    if (isBlank(s)) { clearLocal(uid); return; }
    saveLocal(makeSnapshot(uid, s, { draftId: draftRef.current?.id ?? null, version: draftRef.current?.version ?? null }));
  }, [uid]);

  const saveNow = useCallback((): Promise<boolean> => {
    const run = async (): Promise<boolean> => {
      if (halted.current || submitted.current) return false;
      const s = formRef.current;
      if (isBlank(s) && !draftRef.current) return true; // nothing worth a server row
      setSave({ kind: "saving" });
      const payload = toDraftPayload(s);
      try {
        const d = draftRef.current
          ? await reportsApi.updateDraft(draftRef.current.id, payload, draftRef.current.version)
          : await reportsApi.createDraft(payload);
        draftRef.current = { id: d.id, version: d.version };
        saves.current += 1;
        savedText.current = s.description;
        dirty.current = JSON.stringify(toDraftPayload(formRef.current)) !== JSON.stringify(payload); // typed meanwhile?
        dirtySince.current = dirty.current ? Date.now() : null;
        persistLocal(); // the local copy now builds on this server version
        clearUndo(uid); setUndo(null); // the replaced version only has to survive until the next draft version
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
  }, [persistLocal, uid]);

  /** Server save only when the schedule says so (first: ~100 chars / ~25 s; later: fewer), and only once there is report text. */
  const evaluate = useCallback(() => {
    if (halted.current || !dirty.current) return;
    const s = formRef.current;
    if (draftRef.current === null && s.description.trim() === "") return;
    if (dirtySince.current === null) dirtySince.current = Date.now();
    if (dueForSave({ savesDone: saves.current, savedText: savedText.current, text: s.description, dirtySince: dirtySince.current, now: Date.now() })) void saveNow();
  }, [saveNow]);

  // every edit: mark dirty, write the local copy, check the schedule
  useEffect(() => {
    if (lastForm.current === form) return;
    lastForm.current = form;
    if (skipChange.current) { skipChange.current = false; return; }
    dirty.current = true;
    clearTimeout(localTimer.current);
    localTimer.current = setTimeout(persistLocal, LOCAL_WRITE_MS);
    evaluate();
    return () => clearTimeout(localTimer.current);
  }, [form, evaluate, persistLocal]);

  // time-based thresholds
  useEffect(() => {
    const id = setInterval(evaluate, TICK_MS);
    return () => clearInterval(id);
  }, [evaluate]);

  // phones suspend or kill a backgrounded page: keep the local copy current and save to the server at once when the page is hidden
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState !== "hidden") return;
      clearTimeout(localTimer.current);
      if (dirty.current) persistLocal();
      if (halted.current || !dirty.current) return;
      if (draftRef.current === null && formRef.current.description.trim() === "") return;
      void saveNow();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [saveNow, persistLocal]);

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
    writeLastType(uid, id);
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

  /** Two versions exist (this device vs the server): the author decides; the other one is kept for «واگرد». */
  function pick(which: "local" | "server") {
    if (!choice) return;
    const { local, server } = choice;
    const base = { draftId: server.draft.id, version: server.draft.version };
    const replaced = which === "local" ? makeSnapshot(uid, server.state, base, new Date(server.draft.updated_at)) : local;
    saveUndo(replaced); setUndo(replaced);
    draftRef.current = { id: server.draft.id, version: server.draft.version };
    savedText.current = server.draft.payload.description ?? "";
    saves.current = 3;
    halted.current = false;
    skipChange.current = true;
    dirty.current = which === "local"; // this device's copy still has to reach the server
    dirtySince.current = which === "local" ? Date.now() : null;
    setForm(which === "local" ? local.form : server.state);
    if (which === "server") saveLocal(makeSnapshot(uid, server.state, base)); else persistLocalSoon();
    setChoice(null);
  }
  const persistLocalSoon = () => { clearTimeout(localTimer.current); localTimer.current = setTimeout(persistLocal, 0); };

  function restoreReplaced() {
    if (!undo) return;
    const current = makeSnapshot(uid, formRef.current, { draftId: draftRef.current?.id ?? null, version: draftRef.current?.version ?? null });
    saveUndo(current); setUndo(current);
    skipChange.current = false; // an edit: it must reach the local copy and, in time, the server
    setForm(undo.form);
  }

  async function submit(force = false) {
    if (submittingRef.current) return; // Enter pressed twice / double tap
    setServerError(null);
    const found = validate(form, type, cfg);
    setIssues(found);
    if (found.length || !type) return;
    submittingRef.current = true;
    halted.current = true; // no autosave may race with the submit
    clearTimeout(localTimer.current);
    setSubmitting(true);
    if (force) { draftRef.current = null; requestId.current = newRequestId(); setSubmitGone(false); setSave({ kind: "idle" }); }
    // let an in-flight save finish so we submit from its draft — but never wait forever (offline: that froze the page)
    await Promise.race([chain.current, new Promise((r) => setTimeout(r, SAVE_WAIT_MS))]);
    if (!draftRef.current) {
      // Submit FROM a draft: the server consumes it in the same transaction, which also protects a second device or tab
      // that still holds the same draft from creating a duplicate.
      try {
        const d = await reportsApi.createDraft(toDraftPayload(form));
        draftRef.current = { id: d.id, version: d.version };
      } catch { /* e.g. another draft exists elsewhere, or offline: submit without this protection */ }
    }
    try {
      const report = await reportsApi.create(buildCreateBody(form, type, draftRef.current?.id ?? null, requestId.current));
      draftRef.current = null; // consumed by the server in the same transaction
      submitted.current = true; dirty.current = false; dirtySince.current = null; clearTimeout(localTimer.current); // no stale write may resurrect it
      clearAllFor(uid); setUndo(null);
      writeLastType(uid, type.id);
      setCreated(report);
    } catch (e) {
      setServerError(e);
      if (e instanceof ApiError && e.code === "draft_not_found") {
        // The draft is gone: this report may already have been submitted from another tab/device. Do NOT let a plain retry
        // create a second one — the author must say so explicitly.
        draftRef.current = null; halted.current = true; setSubmitGone(true);
      } else halted.current = false;
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  async function discardDraft() {
    halted.current = true;
    await Promise.race([chain.current, new Promise((r) => setTimeout(r, SAVE_WAIT_MS))]);
    if (draftRef.current) await reportsApi.deleteDraft(draftRef.current.id).catch(() => undefined);
    draftRef.current = null;
    clearAllFor(uid);
    onReload();
  }

  const blocked = save.kind === "gone" || submitGone;

  if (created) {
    return (
      <Paper variant="outlined" sx={{ p: 3 }}>
        <Alert severity="success" sx={{ mb: 2 }}>
          گزارش ثبت شد. شمارهٔ گزارش: <Box component="span" dir="ltr" sx={{ fontWeight: 700, unicodeBidi: "embed" }}>{created.report_number}</Box>
          {created.already_created && " (این گزارش قبلاً با همین درخواست ثبت شده بود؛ گزارش تکراری ساخته نشد.)"}
        </Alert>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>زمان ثبت در سامانه: {formatJalaliDateTime(created.created_at)}</Typography>
        <Button variant="contained" onClick={() => {
          submitted.current = false; draftRef.current = null; halted.current = false; skipChange.current = true; dirty.current = false; dirtySince.current = null; saves.current = 0; savedText.current = "";
          requestId.current = newRequestId(); setCreated(null); setForm(emptyState()); setIssues([]); setTypeNotices([]); setSave({ kind: "idle" }); setSubmitGone(false);
        }}>
          ثبت گزارش جدید
        </Button>
      </Paper>
    );
  }

  if (choice) {
    return (
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle1" sx={{ mb: 1 }}>از این گزارش دو نسخه دارید. کدام را ادامه می‌دهید؟</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>نسخه‌ی دیگر نگه داشته می‌شود و با «بازگرداندن» می‌توانید به آن برگردید.</Typography>
        <Stack direction={{ xs: "column", sm: "row" }} gap={1.5}>
          <Button variant="contained" onClick={() => pick("local")}>نسخه‌ی این دستگاه (ذخیره‌نشده، ساعت {timeOf(choice.local.savedAt)})</Button>
          <Button variant="outlined" onClick={() => pick("server")}>نسخه‌ی سرور (ساعت {timeOf(choice.server.draft.updated_at)})</Button>
        </Stack>
      </Paper>
    );
  }

  const showChooser = form.typeId === "" || changingType;

  return (
    <Stack gap={2} component="form" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      {restore.kind === "server" && <Alert severity="info" action={<Button color="inherit" size="small" onClick={() => void discardDraft()}>دورانداختن پیش‌نویس</Button>}>پیش‌نویس قبلی شما بازیابی شد.</Alert>}
      {restore.kind === "local" && !restore.goneFromServer && <Alert severity="info" action={<Button color="inherit" size="small" onClick={() => void discardDraft()}>دورانداختن پیش‌نویس</Button>}>نسخه‌ی ذخیره‌نشده‌ی این دستگاه (ساعت {timeOf(restore.snap.savedAt)}) بازیابی شد.</Alert>}
      {undo && <Alert severity="info" action={<Button color="inherit" size="small" onClick={restoreReplaced}>بازگرداندن</Button>}>نسخه‌ی دیگری از این گزارش (ساعت {timeOf(undo.savedAt)}) نگه داشته شده است.</Alert>}
      {!online && <Alert severity="warning">ارتباط با سرور قطع است. تا برقراری ارتباط، تغییرات فقط روی همین دستگاه نگه داشته می‌شوند؛ صفحه را نبندید.</Alert>}
      {save.kind === "conflict" && (
        <Alert severity="error" action={<Button color="inherit" size="small" onClick={onReload}>بارگذاری نسخهٔ ذخیره‌شده</Button>}>
          {errorMessage(new ApiError(409, "draft_version_conflict"))} ذخیرهٔ خودکار متوقف شد تا نسخهٔ دیگر بازنویسی نشود.
        </Alert>
      )}
      {blocked && (
        <Alert severity="warning" action={
          <Stack direction="row" gap={1}>
            <Button color="inherit" size="small" onClick={() => void submit(true)} disabled={submitting}>ثبت به‌عنوان گزارش جدید</Button>
            <Button color="inherit" size="small" onClick={() => { clearAllFor(uid); onReload(); }}>شروع فرم جدید</Button>
          </Stack>}>
          {errorMessage(new ApiError(404, "draft_gone"))} ممکن است همین گزارش قبلاً ثبت شده باشد. برای جلوگیری از گزارش تکراری، ثبت دوباره فقط با تأیید صریح شما انجام می‌شود.
        </Alert>
      )}
      {notice && <Alert severity="warning" onClose={() => setNotice(null)}>{notice}</Alert>}
      {typeNotices.map((n) => <Alert key={n} severity="info" onClose={() => setTypeNotices((l) => l.filter((x) => x !== n))}>{n}</Alert>)}

      {/* While the request is pending nothing can be edited: edits made after the submitted snapshot would be neither in the report
          nor recoverable (the success screen replaces the form and the local copy is cleared). A disabled fieldset disables every
          native control and button inside; pointer events are also blocked for the custom (non-native) controls. */}
      <Box component="fieldset" disabled={submitting} aria-busy={submitting}
        sx={{ border: 0, m: 0, p: 0, minWidth: 0, display: "flex", flexDirection: "column", gap: 2, pointerEvents: submitting ? "none" : undefined, opacity: submitting ? 0.7 : 1 }}>
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
              defaultMinutes={cfg.default_labor_minutes} error={laborIssues || undefined}
              onChange={(rows, removed) => patch({ labor: rows, authorRemoved: removed ? form.authorRemoved || removed.userId === author.id : form.authorRemoved && !rows.some((r) => r.userId === author.id) })} />
          )}

          <ErrorAlert error={serverError} />

          <Stack direction={{ xs: "column", sm: "row" }} gap={1.5} alignItems={{ sm: "center" }}>
            <Button type="submit" variant="contained" size="large" disabled={submitting || blocked}>ثبت گزارش</Button>
            <Button variant="outlined" startIcon={<SaveIcon />} disabled={submitting || blocked} onClick={() => { halted.current = false; void saveNow(); }}>ذخیرهٔ پیش‌نویس</Button>
            <SaveStatus state={save} />
          </Stack>
        </>
      )}
      {showChooser && form.typeId === "" && <Typography variant="body2" color="text.secondary">بعد از انتخاب نوع، فرم مناسب همان نوع نمایش داده می‌شود.</Typography>}
      </Box>
    </Stack>
  );
}

function SaveStatus({ state }: { state: SaveState }) {
  if (state.kind === "saving") return <Chip size="small" label="در حال ذخیرهٔ پیش‌نویس…" />;
  if (state.kind === "saved") return <Chip size="small" color="success" variant="outlined" label={`پیش‌نویس ذخیره شد ${formatJalaliDateTime(state.at).split(" ")[1]}`} />;
  if (state.kind === "error") return <Chip size="small" color="error" variant="outlined" label={`ذخیرهٔ پیش‌نویس انجام نشد: ${errorMessage(state.error)}`} />;
  return null;
}
