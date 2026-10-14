import { useState } from "react";
import { Button, IconButton, Paper, Switch, FormControlLabel, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Tooltip } from "@mui/material";
import EditIcon from "@mui/icons-material/EditOutlined";
import PowerIcon from "@mui/icons-material/PowerSettingsNewOutlined";
import AddIcon from "@mui/icons-material/Add";
import { groupsApi } from "../api/resources";
import type { Group } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { ConfirmDialog, Empty, ErrorAlert, FormDialog, Loading, Ltr, PageHeader, Pager, StatusChip } from "../components/common";
import { canViewAdmin, isManagement } from "../lib/access";
import { toPersianDigits } from "../lib/dates";
import { useLoad } from "../lib/useLoad";

type Dlg = null | { kind: "create" } | { kind: "edit"; group: Group } | { kind: "toggle"; group: Group };

export function GroupsPage() {
  const { user } = useAuth();
  const manage = isManagement(user);
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState(25);
  const [inactive, setInactive] = useState(false);
  const [dlg, setDlg] = useState<Dlg>(null);
  const { data, error, loading, reload } = useLoad(
    () => groupsApi.list({ limit: rows, offset: page * rows, include_inactive: inactive }), [page, rows, inactive]);
  const [form, setForm] = useState({ code: "", name: "", description: "" });
  const open = (d: Dlg, g?: Group) => { setForm({ code: g?.code ?? "", name: g?.name ?? "", description: g?.description ?? "" }); setDlg(d); };
  const close = () => setDlg(null);

  return (
    <>
      <PageHeader title="گروه‌ها" actions={manage && <Button variant="contained" startIcon={<AddIcon />} onClick={() => open({ kind: "create" })}>گروه جدید</Button>} />
      {canViewAdmin(user) && (
        <FormControlLabel control={<Switch checked={inactive} onChange={(e) => { setInactive(e.target.checked); setPage(0); }} />} label="نمایش گروه‌های غیرفعال" sx={{ mb: 1 }} />
      )}
      <ErrorAlert error={error} />
      {loading && !data ? <Loading /> : data && data.items.length === 0 ? <Empty /> : data && (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow><TableCell>کد</TableCell><TableCell>نام</TableCell><TableCell>توضیحات</TableCell><TableCell align="center">تجهیزات فعال</TableCell><TableCell align="center">اعضا</TableCell><TableCell>وضعیت</TableCell>{manage && <TableCell />}</TableRow>
            </TableHead>
            <TableBody>
              {data.items.map((g) => (
                <TableRow key={g.id} hover>
                  <TableCell><Ltr>{g.code}</Ltr></TableCell><TableCell>{g.name}</TableCell><TableCell>{g.description ?? "—"}</TableCell>
                  <TableCell align="center">{toPersianDigits(String(g.equipment_count))}</TableCell><TableCell align="center">{toPersianDigits(String(g.member_count))}</TableCell>
                  <TableCell><StatusChip active={g.is_active} /></TableCell>
                  {manage && (
                    <TableCell align="right">
                      <Tooltip title="ویرایش"><IconButton aria-label={`ویرایش ${g.code}`} onClick={() => open({ kind: "edit", group: g }, g)}><EditIcon fontSize="small" /></IconButton></Tooltip>
                      <Tooltip title={g.is_active ? "غیرفعال‌سازی" : "فعال‌سازی"}><IconButton aria-label={`${g.is_active ? "غیرفعال‌سازی" : "فعال‌سازی"} ${g.code}`} onClick={() => setDlg({ kind: "toggle", group: g })}><PowerIcon fontSize="small" /></IconButton></Tooltip>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pager total={data.total} page={page} rowsPerPage={rows} onPage={setPage} onRows={(n) => { setRows(n); setPage(0); }} />
        </TableContainer>
      )}

      <FormDialog open={dlg?.kind === "create"} title="گروه جدید" onClose={close}
        onSubmit={async () => { await groupsApi.create({ code: form.code, name: form.name, description: form.description || null }); reload(); }}>
        <TextField label="کد گروه (انگلیسی، مثلاً ELV)" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} helperText="پس از ساخت قابل تغییر نیست." slotProps={{ htmlInput: { dir: "ltr" } }} />
        <TextField label="نام" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <TextField label="توضیحات" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} multiline minRows={2} />
      </FormDialog>

      <FormDialog open={dlg?.kind === "edit"} title={`ویرایش گروه ${form.code}`} onClose={close}
        onSubmit={async () => { if (dlg?.kind === "edit") { await groupsApi.update(dlg.group.id, { name: form.name, description: form.description || null }); reload(); } }}>
        <TextField label="نام" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <TextField label="توضیحات" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} multiline minRows={2} />
      </FormDialog>

      <ConfirmDialog open={dlg?.kind === "toggle"} onClose={close} danger={dlg?.kind === "toggle" && dlg.group.is_active}
        title={dlg?.kind === "toggle" && dlg.group.is_active ? "غیرفعال‌سازی گروه" : "فعال‌سازی گروه"}
        text={dlg?.kind === "toggle" ? `گروه «${dlg.group.name}» ${dlg.group.is_active ? "غیرفعال" : "فعال"} شود؟` : ""}
        onConfirm={async () => { if (dlg?.kind === "toggle") { await groupsApi.setActive(dlg.group.id, !dlg.group.is_active); reload(); } }} />
    </>
  );
}
