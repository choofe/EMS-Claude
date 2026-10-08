import { useState } from "react";
import { Button, Chip, FormControlLabel, IconButton, Paper, Switch, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Tooltip } from "@mui/material";
import EditIcon from "@mui/icons-material/EditOutlined";
import PowerIcon from "@mui/icons-material/PowerSettingsNewOutlined";
import AddIcon from "@mui/icons-material/Add";
import { reportTypesApi } from "../api/resources";
import type { ReportType } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { ConfirmDialog, Empty, ErrorAlert, FormDialog, Loading, Ltr, PageHeader, StatusChip } from "../components/common";
import { isManagement } from "../lib/access";
import { useLoad } from "../lib/useLoad";

type Dlg = null | { kind: "create" } | { kind: "edit"; item: ReportType } | { kind: "toggle"; item: ReportType };

export function ReportTypesPage() {
  const { user } = useAuth();
  const manage = isManagement(user);
  const [dlg, setDlg] = useState<Dlg>(null);
  const [form, setForm] = useState({ code: "", name: "", failure: false });
  const { data, error, loading, reload } = useLoad(() => reportTypesApi.list(manage), [manage]);
  const open = (d: Dlg, t?: ReportType) => { setForm({ code: t?.code ?? "", name: t?.name_fa ?? "", failure: t?.is_failure ?? false }); setDlg(d); };
  const close = () => setDlg(null);

  return (
    <>
      <PageHeader title="انواع گزارش" actions={manage && <Button variant="contained" startIcon={<AddIcon />} onClick={() => open({ kind: "create" })}>نوع جدید</Button>} />
      <ErrorAlert error={error} />
      {loading && !data ? <Loading /> : data && data.length === 0 ? <Empty /> : data && (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead><TableRow><TableCell>کد</TableCell><TableCell>عنوان</TableCell><TableCell>دسته</TableCell>{manage && <TableCell>وضعیت</TableCell>}{manage && <TableCell />}</TableRow></TableHead>
            <TableBody>
              {data.map((t) => (
                <TableRow key={t.id} hover>
                  <TableCell><Ltr>{t.code}</Ltr></TableCell><TableCell>{t.name_fa}</TableCell>
                  <TableCell>{t.is_failure ? <Chip size="small" color="warning" label="خرابی" /> : <Chip size="small" variant="outlined" label="غیرخرابی" />}</TableCell>
                  {manage && <TableCell><StatusChip active={t.is_active} /></TableCell>}
                  {manage && (
                    <TableCell align="right">
                      <Tooltip title="ویرایش"><IconButton aria-label={`ویرایش ${t.code}`} onClick={() => open({ kind: "edit", item: t }, t)}><EditIcon fontSize="small" /></IconButton></Tooltip>
                      <Tooltip title={t.is_active ? "غیرفعال‌سازی" : "فعال‌سازی"}><IconButton aria-label={`${t.is_active ? "غیرفعال‌سازی" : "فعال‌سازی"} ${t.code}`} onClick={() => setDlg({ kind: "toggle", item: t })}><PowerIcon fontSize="small" /></IconButton></Tooltip>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <FormDialog open={dlg?.kind === "create"} title="نوع گزارش جدید" onClose={close}
        onSubmit={async () => { await reportTypesApi.create({ code: form.code, name_fa: form.name, is_failure: form.failure }); reload(); }}>
        <TextField label="کد (انگلیسی، مثلاً MINOR_FAILURE)" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} helperText="پس از ساخت قابل تغییر نیست." slotProps={{ htmlInput: { dir: "ltr" } }} />
        <TextField label="عنوان فارسی" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <FormControlLabel control={<Switch checked={form.failure} onChange={(e) => setForm({ ...form, failure: e.target.checked })} />} label="این نوع، «خرابی» محسوب می‌شود (در آمار خرابی‌ها)" />
      </FormDialog>

      <FormDialog open={dlg?.kind === "edit"} title={`ویرایش ${form.code}`} onClose={close}
        onSubmit={async () => {
          if (dlg?.kind !== "edit") return;
          const body: { name_fa: string; is_failure?: boolean } = { name_fa: form.name };
          if (form.failure !== dlg.item.is_failure) body.is_failure = form.failure;
          await reportTypesApi.update(dlg.item.id, body);
          reload();
        }}>
        <TextField label="عنوان فارسی" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <FormControlLabel control={<Switch checked={form.failure} onChange={(e) => setForm({ ...form, failure: e.target.checked })} />}
          label="«خرابی» محسوب می‌شود (پس از ثبت اولین گزارش قابل تغییر نیست)" />
      </FormDialog>

      <ConfirmDialog open={dlg?.kind === "toggle"} onClose={close} danger={dlg?.kind === "toggle" && dlg.item.is_active}
        title={dlg?.kind === "toggle" && dlg.item.is_active ? "غیرفعال‌سازی نوع گزارش" : "فعال‌سازی نوع گزارش"}
        text={dlg?.kind === "toggle" ? `نوع «${dlg.item.name_fa}» ${dlg.item.is_active ? "غیرفعال" : "فعال"} شود؟ گزارش‌های قبلی تغییر نمی‌کنند.` : ""}
        onConfirm={async () => { if (dlg?.kind === "toggle") { await reportTypesApi.setActive(dlg.item.id, !dlg.item.is_active); reload(); } }} />
    </>
  );
}
