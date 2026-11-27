import { useState, type ReactNode } from "react";
import {
  Button, Checkbox, Chip, FormControl, FormControlLabel, IconButton, InputLabel, ListItemText, Menu, MenuItem, OutlinedInput, Paper, Select, Stack, Switch, Table, TableBody,
  TableCell, TableContainer, TableHead, TableRow, TextField, Typography, useMediaQuery, useTheme,
} from "@mui/material";
import MoreIcon from "@mui/icons-material/MoreVert";
import AddIcon from "@mui/icons-material/Add";
import { groupsApi, usersApi } from "../api/resources";
import type { Group, User } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { ConfirmDialog, Empty, ErrorAlert, FormDialog, Loading, Ltr, PageHeader, Pager, StatusChip } from "../components/common";
import { HelpHint } from "../components/HelpHint";
import { toPersianDigits } from "../lib/dates";
import { NoGroupBanner } from "./users/NoGroupBanner";
import { isManagement } from "../lib/access";
import { useLoad } from "../lib/useLoad";

type Dlg =
  | null | { kind: "create" } | { kind: "edit"; user: User } | { kind: "groups"; user: User } | { kind: "reset"; user: User }
  | { kind: "toggle"; user: User } | { kind: "force"; user: User } | { kind: "forceAll" };

function GroupPicker({ groups, value, onChange }: { groups: Group[]; value: number[]; onChange: (v: number[]) => void }) {
  return (
    <FormControl fullWidth>
      <InputLabel id="grp-pick">گروه‌ها</InputLabel>
      <Select labelId="grp-pick" multiple value={value} onChange={(e) => onChange(e.target.value as number[])} input={<OutlinedInput label="گروه‌ها" />}
        renderValue={(sel) => (sel as number[]).map((id) => groups.find((g) => g.id === id)?.code ?? id).join("، ")}>
        {groups.map((g) => (
          <MenuItem key={g.id} value={g.id}><Checkbox checked={value.includes(g.id)} /><ListItemText primary={`${g.name} (${g.code})`} /></MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}

const ORG_WIDE_LABEL: Record<string, string> = { MANAGEMENT: "مدیر", AUDITOR: "بازرس ارشد" };

/** Group cell: tags; organisation-wide roles show their own word, people who need a group show «بدون گروه». */
function GroupTags({ user, groups }: { user: User; groups: Group[] }) {
  const orgWide = user.role_code ? ORG_WIDE_LABEL[user.role_code] : undefined;
  if (orgWide) return <Chip size="small" variant="outlined" label={orgWide} />;
  if (user.group_ids.length === 0) return user.needs_group ? <Chip size="small" color="warning" label="بدون گروه" /> : <>—</>;
  return (
    <Stack direction="row" gap={0.5} flexWrap="wrap">
      {user.group_ids.map((id) => <Chip key={id} size="small" variant="outlined" label={groups.find((g) => g.id === id)?.code ?? id} />)}
    </Stack>
  );
}

const STATES_HELP: ReactNode = (
  <>
    «فعال / غیرفعال»: وضعیت خود فرد؛ فرد غیرفعال نه وارد می‌شود و نه در فهرست‌های انتخاب نام می‌آید، ولی گزارش‌های گذشتهٔ او می‌ماند.
    «دارای حساب / بدون حساب»: فرد با حساب نام کاربری و رمز دارد؛ فرد بدون حساب فقط می‌تواند در گزارش‌ها نام‌برده شود.
    «ورود خاموش»: حساب هست ولی فعلاً اجازهٔ ورود ندارد.
  </>
);

export function UsersPage() {
  const { user: me } = useAuth();
  const manage = isManagement(me);
  const [q, setQ] = useState("");
  const [role, setRole] = useState("");
  const [active, setActive] = useState<"" | "true" | "false">("");
  const [account, setAccount] = useState<"" | "true" | "false">("");
  const [showMobile, setShowMobile] = useState(false);
  const phone = useMediaQuery(useTheme().breakpoints.down("sm"));
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState(25);
  const [dlg, setDlg] = useState<Dlg>(null);
  const [menu, setMenu] = useState<{ el: HTMLElement; user: User } | null>(null);
  const [form, setForm] = useState({ username: "", full_name: "", first_name: "", last_name: "", role_code: "USER", password: "", must_change: true, group_ids: [] as number[] });

  const roles = useLoad(() => usersApi.roles(), []);
  const groups = useLoad(() => groupsApi.list({ limit: 100, offset: 0 }), []);
  const list = useLoad(
    () => usersApi.list({ limit: rows, offset: page * rows, q: q.trim() || undefined, role_code: role || undefined, is_active: active === "" ? undefined : active === "true", has_login: account === "" ? undefined : account === "true" }),
    [page, rows, q, role, active, account]);
  const mobileColumn = manage && (!phone || showMobile);  // a phone adds the column with «نمایش شماره‌ها»; AUDITOR never gets numbers
  const groupList = groups.data?.items ?? [];
  const roleList = roles.data ?? [];

  const open = (d: Dlg, u?: User) => {
    setForm({ username: u?.username ?? "", full_name: u?.full_name ?? "", first_name: u?.first_name ?? "", last_name: u?.last_name ?? "", role_code: u?.role_code ?? "USER", password: "", must_change: true, group_ids: u?.group_ids ?? [] });
    setDlg(d);
    setMenu(null);
  };
  const close = () => setDlg(null);
  const roleSelect = (
    <FormControl fullWidth>
      <InputLabel id="role-lbl">نقش</InputLabel>
      <Select labelId="role-lbl" label="نقش" value={form.role_code} onChange={(e) => setForm({ ...form, role_code: e.target.value })}>
        {roleList.map((r) => <MenuItem key={r.code} value={r.code}>{r.label_fa}</MenuItem>)}
      </Select>
    </FormControl>
  );
  const passwordField = (
    <TextField label="رمز عبور موقت" type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="off" slotProps={{ htmlInput: { dir: "ltr" } }} />
  );
  const mustChange = (
    <FormControlLabel control={<Switch checked={form.must_change} onChange={(e) => setForm({ ...form, must_change: e.target.checked })} />} label="کاربر در اولین ورود باید رمز را تغییر دهد" />
  );

  return (
    <>
      <PageHeader title="کاربران" actions={manage && (
        <>
          <Button color="warning" variant="outlined" onClick={() => open({ kind: "forceAll" })}>اجبار تغییر رمز همه</Button>
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => open({ kind: "create" })}>کاربر جدید</Button>
        </>
      )} />
      <Stack direction={{ xs: "column", sm: "row" }} gap={1.5} sx={{ mb: 2 }}>
        <TextField size="small" label="جستجوی نام، نام کاربری یا کد پرسنلی" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} sx={{ minWidth: 220 }} />
        <FormControl size="small" fullWidth>
          <InputLabel id="f-role">نقش</InputLabel>
          <Select labelId="f-role" label="نقش" value={role} onChange={(e) => { setRole(e.target.value); setPage(0); }}>
            <MenuItem value="">همه</MenuItem>{roleList.map((r) => <MenuItem key={r.code} value={r.code}>{r.label_fa}</MenuItem>)}
          </Select>
        </FormControl>
        <FormControl size="small" fullWidth>
          <InputLabel id="f-act">وضعیت</InputLabel>
          <Select labelId="f-act" label="وضعیت" value={active} onChange={(e) => { setActive(e.target.value as "" | "true" | "false"); setPage(0); }}>
            <MenuItem value="">همه</MenuItem><MenuItem value="true">فعال</MenuItem><MenuItem value="false">غیرفعال</MenuItem>
          </Select>
        </FormControl>
        <FormControl size="small" fullWidth>
          <InputLabel id="f-acc">حساب</InputLabel>
          <Select labelId="f-acc" label="حساب" value={account} onChange={(e) => { setAccount(e.target.value as "" | "true" | "false"); setPage(0); }}>
            <MenuItem value="">همه</MenuItem><MenuItem value="true">دارای حساب</MenuItem><MenuItem value="false">بدون حساب</MenuItem>
          </Select>
        </FormControl>
        {manage && phone && <Button size="small" onClick={() => setShowMobile((v) => !v)}>{showMobile ? "پنهان‌کردن شماره‌ها" : "نمایش شماره‌ها"}</Button>}
      </Stack>
      <NoGroupBanner />
      <ErrorAlert error={list.error} />
      {list.loading && !list.data ? <Loading /> : list.data && list.data.items.length === 0 ? <Empty /> : list.data && (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>نام</TableCell><TableCell>کد پرسنلی</TableCell>{mobileColumn && <TableCell>شماره موبایل</TableCell>}
                <TableCell>نقش</TableCell><TableCell>گروه‌ها</TableCell>
                <TableCell>وضعیت <HelpHint label="راهنمای وضعیت‌ها">{STATES_HELP}</HelpHint></TableCell>{manage && <TableCell />}
              </TableRow>
            </TableHead>
            <TableBody>
              {list.data.items.map((u) => (
                <TableRow key={u.id} hover data-needs-group={u.needs_group} sx={u.needs_group ? { bgcolor: "warning.light", "&.MuiTableRow-hover:hover": { bgcolor: "warning.light" } } : undefined}>
                  <TableCell>{u.full_name}{u.username && <Typography variant="caption" color="text.secondary" component="div"><Ltr>{u.username}</Ltr></Typography>}</TableCell>
                  <TableCell>{u.personnel_code === null ? "—" : toPersianDigits(String(u.personnel_code))}</TableCell>
                  {mobileColumn && <TableCell>{u.mobile ? <Ltr>{u.mobile}</Ltr> : "—"}</TableCell>}
                  <TableCell>{u.has_login ? u.role_label_fa : "—"}</TableCell>
                  <TableCell><GroupTags user={u} groups={groupList} /></TableCell>
                  <TableCell>
                    <Stack direction="row" gap={0.5} flexWrap="wrap">
                      <StatusChip active={u.is_active} />
                      <Chip size="small" variant="outlined" color={u.has_login ? "primary" : "default"} label={u.has_login ? "دارای حساب" : "بدون حساب"} />
                      {u.has_login && !u.login_enabled && <Chip size="small" color="error" variant="outlined" label="ورود خاموش" />}
                      {u.must_change_password && <Chip size="small" color="warning" variant="outlined" label="تغییر رمز در انتظار" />}
                    </Stack>
                  </TableCell>
                  {manage && <TableCell align="right"><IconButton aria-label={`عملیات ${u.username ?? u.full_name}`} onClick={(e) => setMenu({ el: e.currentTarget, user: u })}><MoreIcon /></IconButton></TableCell>}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pager total={list.data.total} page={page} rowsPerPage={rows} onPage={setPage} onRows={(n) => { setRows(n); setPage(0); }} />
        </TableContainer>
      )}

      <Menu anchorEl={menu?.el} open={!!menu} onClose={() => setMenu(null)}>
        {menu && [
          <MenuItem key="edit" onClick={() => open({ kind: "edit", user: menu.user }, menu.user)}>{menu.user.has_login ? "ویرایش نام و نقش" : "ویرایش نام"}</MenuItem>,
          <MenuItem key="groups" onClick={() => open({ kind: "groups", user: menu.user }, menu.user)}>گروه‌ها</MenuItem>,
          ...(menu.user.has_login && menu.user.id !== me?.id ? [<MenuItem key="reset" onClick={() => open({ kind: "reset", user: menu.user }, menu.user)}>تعیین رمز موقت</MenuItem>] : []),
          ...(menu.user.has_login ? [<MenuItem key="force" onClick={() => open({ kind: "force", user: menu.user }, menu.user)}>اجبار تغییر رمز</MenuItem>] : []),
          ...(menu.user.id !== me?.id ? [<MenuItem key="toggle" onClick={() => open({ kind: "toggle", user: menu.user }, menu.user)}>{menu.user.is_active ? "غیرفعال‌سازی" : "فعال‌سازی"}</MenuItem>] : []),
        ]}
      </Menu>

      <FormDialog open={dlg?.kind === "create"} title="کاربر جدید" onClose={close}
        onSubmit={async () => { await usersApi.create({ username: form.username, full_name: form.full_name, role_code: form.role_code, password: form.password, group_ids: form.group_ids, must_change_password: form.must_change }); list.reload(); }}>
        <TextField label="نام کاربری (انگلیسی)" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} helperText="حروف بزرگ و کوچک یکسان‌اند؛ مثل ali.rezaei" slotProps={{ htmlInput: { dir: "ltr", autoCapitalize: "none" } }} />
        <TextField label="نام کامل" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
        {roleSelect}
        <GroupPicker groups={groupList} value={form.group_ids} onChange={(v) => setForm({ ...form, group_ids: v })} />
        {passwordField}
        {mustChange}
      </FormDialog>

      <FormDialog open={dlg?.kind === "edit"} title={`ویرایش ${form.username || form.full_name}`} onClose={close}
        onSubmit={async () => {
          if (dlg?.kind !== "edit") return;
          // a person whose name is stored as first + last name is edited through those two fields (full_name is composed by the server)
          const hasParts = dlg.user.first_name !== null || dlg.user.last_name !== null;
          const body: { full_name?: string; first_name?: string; last_name?: string; role_code?: string } =
            hasParts ? { first_name: form.first_name, last_name: form.last_name } : { full_name: form.full_name };
          if (dlg.user.has_login && form.role_code !== dlg.user.role_code) body.role_code = form.role_code;  // a person without a profile has no role to change
          await usersApi.update(dlg.user.id, body);
          list.reload();
        }}>
        {dlg?.kind === "edit" && (dlg.user.first_name !== null || dlg.user.last_name !== null) ? (
          <>
            <TextField label="نام" value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} />
            <TextField label="نام خانوادگی" value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} />
          </>
        ) : (
          <TextField label="نام کامل" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
        )}
        {dlg?.kind === "edit" && !dlg.user.has_login ? null : dlg?.kind === "edit" && dlg.user.id !== me?.id ? roleSelect : <Typography variant="caption" color="text.secondary">نقش خودتان را نمی‌توانید تغییر دهید.</Typography>}
      </FormDialog>

      <FormDialog open={dlg?.kind === "groups"} title={`گروه‌های ${form.username || form.full_name}`} onClose={close}
        onSubmit={async () => { if (dlg?.kind === "groups") { await usersApi.setGroups(dlg.user.id, form.group_ids); list.reload(); } }}>
        <GroupPicker groups={groupList} value={form.group_ids} onChange={(v) => setForm({ ...form, group_ids: v })} />
      </FormDialog>

      <FormDialog open={dlg?.kind === "reset"} title={`رمز موقت برای ${form.username}`} onClose={close}
        onSubmit={async () => { if (dlg?.kind === "reset") { await usersApi.resetPassword(dlg.user.id, form.password, form.must_change); list.reload(); } }}>
        {passwordField}
        {mustChange}
        <Typography variant="caption" color="text.secondary">همهٔ نشست‌های فعال این کاربر بسته می‌شود. رمز را به‌صورت امن به کاربر اطلاع دهید.</Typography>
      </FormDialog>

      <ConfirmDialog open={dlg?.kind === "toggle"} onClose={close} danger={dlg?.kind === "toggle" && dlg.user.is_active}
        title={dlg?.kind === "toggle" && dlg.user.is_active ? "غیرفعال‌سازی کاربر" : "فعال‌سازی کاربر"}
        text={dlg?.kind === "toggle" ? (dlg.user.is_active ? `«${dlg.user.full_name}» غیرفعال شود؟ نشست‌های او فوراً بسته می‌شود.` : `«${dlg.user.full_name}» فعال شود؟`) : ""}
        onConfirm={async () => { if (dlg?.kind === "toggle") { await usersApi.setActive(dlg.user.id, !dlg.user.is_active); list.reload(); } }} />

      <ConfirmDialog open={dlg?.kind === "force"} onClose={close} title="اجبار تغییر رمز"
        text={dlg?.kind === "force" ? `«${dlg.user.full_name}» در ورود بعدی باید رمز را تغییر دهد و نشست‌هایش بسته می‌شود.` : ""}
        onConfirm={async () => { if (dlg?.kind === "force") { await usersApi.forceChange(dlg.user.id); list.reload(); } }} />

      <ConfirmDialog open={dlg?.kind === "forceAll"} onClose={close} danger title="اجبار تغییر رمز همهٔ کاربران" confirmLabel="اجبار برای همه"
        text="همهٔ کاربران فعال (از جمله خودتان) در ورود بعدی باید رمز را تغییر دهند و همهٔ نشست‌ها بسته می‌شود. ادامه می‌دهید؟"
        onConfirm={async () => { await usersApi.forceChangeAll(); list.reload(); }} />
    </>
  );
}
