import { useState } from "react";
import { Button, FormControl, IconButton, InputLabel, MenuItem, Paper, Select, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Tooltip } from "@mui/material";
import EditIcon from "@mui/icons-material/EditOutlined";
import MoveIcon from "@mui/icons-material/SwapHorizOutlined";
import PowerIcon from "@mui/icons-material/PowerSettingsNewOutlined";
import AddIcon from "@mui/icons-material/Add";
import { equipmentApi, groupsApi } from "../api/resources";
import type { Equipment } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { ConfirmDialog, Empty, ErrorAlert, FormDialog, Loading, Ltr, PageHeader, Pager, StatusChip } from "../components/common";
import { canViewAdmin, isManagement } from "../lib/access";
import { useLoad } from "../lib/useLoad";

type Dlg = null | { kind: "create" } | { kind: "edit"; item: Equipment } | { kind: "move"; item: Equipment } | { kind: "toggle"; item: Equipment };

export function EquipmentPage() {
  const { user } = useAuth();
  const manage = isManagement(user);
  const [q, setQ] = useState("");
  const [groupId, setGroupId] = useState<number | "">("");
  const [active, setActive] = useState<"" | "true" | "false">("");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState(25);
  const [dlg, setDlg] = useState<Dlg>(null);
  const [form, setForm] = useState({ code: "", group: "" as number | "", description: "" });

  const groups = useLoad(() => groupsApi.list({ limit: 100, offset: 0 }), []);
  const list = useLoad(
    () => equipmentApi.list({ limit: rows, offset: page * rows, q: q.trim() || undefined, group_id: groupId === "" ? undefined : groupId, is_active: active === "" ? undefined : active === "true" }),
    [page, rows, q, groupId, active]);
  const open = (d: Dlg, e?: Equipment) => { setForm({ code: e?.equipment_code ?? "", group: e?.group_id ?? "", description: e?.description ?? "" }); setDlg(d); };
  const close = () => setDlg(null);
  const groupOptions = groups.data?.items ?? [];
  const selectGroup = (value: number | "", set: (v: number | "") => void, allowAll = false) => (
    <FormControl size="small" fullWidth>
      <InputLabel id="grp-lbl">گروه</InputLabel>
      <Select labelId="grp-lbl" label="گروه" value={value} onChange={(e) => set(e.target.value as number | "")}>
        {allowAll && <MenuItem value="">همه گروه‌ها</MenuItem>}
        {groupOptions.map((g) => <MenuItem key={g.id} value={g.id}>{g.name} ({g.code})</MenuItem>)}
      </Select>
    </FormControl>
  );

  return (
    <>
      <PageHeader title="تجهیزات" actions={manage && <Button variant="contained" startIcon={<AddIcon />} onClick={() => open({ kind: "create" })}>تجهیز جدید</Button>} />
      <Stack direction={{ xs: "column", sm: "row" }} gap={1.5} sx={{ mb: 2 }}>
        <TextField size="small" label="جستجوی کد" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} slotProps={{ htmlInput: { dir: "ltr" } }} sx={{ minWidth: 180 }} />
        {selectGroup(groupId, (v) => { setGroupId(v); setPage(0); }, true)}
        {canViewAdmin(user) && (
          <FormControl size="small" fullWidth>
            <InputLabel id="act-lbl">وضعیت</InputLabel>
            <Select labelId="act-lbl" label="وضعیت" value={active} onChange={(e) => { setActive(e.target.value as "" | "true" | "false"); setPage(0); }}>
              <MenuItem value="">همه</MenuItem><MenuItem value="true">فعال</MenuItem><MenuItem value="false">غیرفعال</MenuItem>
            </Select>
          </FormControl>
        )}
      </Stack>
      <ErrorAlert error={list.error} />
      {list.loading && !list.data ? <Loading /> : list.data && list.data.items.length === 0 ? <Empty /> : list.data && (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead><TableRow><TableCell>کد تجهیز</TableCell><TableCell>گروه</TableCell><TableCell>توضیحات</TableCell><TableCell>وضعیت</TableCell>{manage && <TableCell />}</TableRow></TableHead>
            <TableBody>
              {list.data.items.map((e) => (
                <TableRow key={e.id} hover>
                  <TableCell><Ltr>{e.equipment_code}</Ltr></TableCell><TableCell>{e.group_name} (<Ltr>{e.group_code}</Ltr>)</TableCell>
                  <TableCell>{e.description ?? "—"}</TableCell><TableCell><StatusChip active={e.is_active} /></TableCell>
                  {manage && (
                    <TableCell align="right">
                      <Tooltip title="ویرایش توضیحات"><IconButton aria-label={`ویرایش ${e.equipment_code}`} onClick={() => open({ kind: "edit", item: e }, e)}><EditIcon fontSize="small" /></IconButton></Tooltip>
                      <Tooltip title="انتقال به گروه دیگر"><IconButton aria-label={`انتقال ${e.equipment_code}`} onClick={() => open({ kind: "move", item: e }, e)}><MoveIcon fontSize="small" /></IconButton></Tooltip>
                      <Tooltip title={e.is_active ? "غیرفعال‌سازی" : "فعال‌سازی"}><IconButton aria-label={`${e.is_active ? "غیرفعال‌سازی" : "فعال‌سازی"} ${e.equipment_code}`} onClick={() => setDlg({ kind: "toggle", item: e })}><PowerIcon fontSize="small" /></IconButton></Tooltip>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pager total={list.data.total} page={page} rowsPerPage={rows} onPage={setPage} onRows={(n) => { setRows(n); setPage(0); }} />
        </TableContainer>
      )}

      <FormDialog open={dlg?.kind === "create"} title="تجهیز جدید" onClose={close}
        onSubmit={async () => { await equipmentApi.create({ equipment_code: form.code, group_id: Number(form.group), description: form.description || null }); list.reload(); }}>
        <TextField label="کد تجهیز" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} helperText="حروف بزرگ و کوچک یکسان‌اند؛ پس از ثبت قابل تغییر نیست." slotProps={{ htmlInput: { dir: "ltr" } }} />
        {selectGroup(form.group, (v) => setForm({ ...form, group: v }))}
        <TextField label="توضیحات" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} multiline minRows={2} />
      </FormDialog>

      <FormDialog open={dlg?.kind === "edit"} title={`ویرایش ${form.code}`} onClose={close}
        onSubmit={async () => { if (dlg?.kind === "edit") { await equipmentApi.update(dlg.item.id, { description: form.description || null }); list.reload(); } }}>
        <TextField label="توضیحات" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} multiline minRows={2} />
      </FormDialog>

      <FormDialog open={dlg?.kind === "move"} title={`انتقال ${form.code} به گروه دیگر`} submitLabel="انتقال" onClose={close}
        onSubmit={async () => { if (dlg?.kind === "move") { await equipmentApi.move(dlg.item.id, Number(form.group)); list.reload(); } }}>
        {selectGroup(form.group, (v) => setForm({ ...form, group: v }))}
        <MoveNote />
      </FormDialog>

      <ConfirmDialog open={dlg?.kind === "toggle"} onClose={close} danger={dlg?.kind === "toggle" && dlg.item.is_active}
        title={dlg?.kind === "toggle" && dlg.item.is_active ? "غیرفعال‌سازی تجهیز" : "فعال‌سازی تجهیز"}
        text={dlg?.kind === "toggle" ? `تجهیز ${dlg.item.equipment_code} ${dlg.item.is_active ? "غیرفعال" : "فعال"} شود؟` : ""}
        onConfirm={async () => { if (dlg?.kind === "toggle") { await equipmentApi.setActive(dlg.item.id, !dlg.item.is_active); list.reload(); } }} />
    </>
  );
}

function MoveNote() {
  return <span style={{ fontSize: 13, opacity: 0.7 }}>گزارش‌های قبلی تجهیز، گروه زمان ثبت خود را حفظ می‌کنند.</span>;
}
