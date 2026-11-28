import { useState } from "react";
import { FormControl, FormControlLabel, InputLabel, MenuItem, Select, Stack, Switch, TextField, Typography } from "@mui/material";
import { usersApi } from "../../api/resources";
import type { Group, Role } from "../../api/types";
import { FormDialog } from "../../components/common";
import { PasswordChooser } from "../../components/PasswordChooser";
import { GroupPicker } from "./GroupPicker";

/** The roles a profile may be created with from the panel (MANAGEMENT and AUDITOR are reached by changing the role later). */
export const PROFILE_ROLE_CODES = ["USER", "EXPERT"];

export function RoleChoice({ roles, value, onChange }: { roles: Role[]; value: string; onChange: (v: string) => void }) {
  return (
    <FormControl fullWidth>
      <InputLabel id="profile-role-lbl">نوع حساب</InputLabel>
      <Select labelId="profile-role-lbl" label="نوع حساب" value={value} onChange={(e) => onChange(e.target.value)}>
        {roles.filter((r) => PROFILE_ROLE_CODES.includes(r.code)).map((r) => <MenuItem key={r.code} value={r.code}>{r.label_fa}</MenuItem>)}
      </Select>
    </FormControl>
  );
}

const EMPTY = { first_name: "", last_name: "", personnel_code: "", mobile: "", group_ids: [] as number[], account: false, username: "", role_code: "USER", password: "", must_change: true };

/** One form for a new person; the optional switch «ساخت حساب ورود» adds username, type and password (one request, one transaction). */
export function NewPersonDialog({ open, groups, roles, onClose, onDone }: { open: boolean; groups: Group[]; roles: Role[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState(EMPTY);
  // the form starts clean every time the dialog is opened (the dialog content is unmounted while closed)
  const set = (patch: Partial<typeof EMPTY>) => setF((prev) => ({ ...prev, ...patch }));
  const incomplete = !f.first_name.trim() || !f.last_name.trim() || !f.personnel_code.trim() || !f.mobile.trim() || (f.account && (!f.username.trim() || !f.password));

  return (
    <FormDialog open={open} title="فرد جدید" submitLabel="ثبت" submitDisabled={incomplete} onClose={() => { onClose(); setF(EMPTY); }}
      onSubmit={async () => {
        await usersApi.createPerson({
          first_name: f.first_name.trim(), last_name: f.last_name.trim(), personnel_code: f.personnel_code.trim(), mobile: f.mobile.trim(), group_ids: f.group_ids,
          ...(f.account ? { profile: { username: f.username.trim(), password: f.password, role_code: f.role_code, must_change_password: f.must_change } } : {}),
        });
        setF(EMPTY);
        onDone();
      }}>
      <Stack direction={{ xs: "column", sm: "row" }} gap={2}>
        <TextField label="نام" value={f.first_name} onChange={(e) => set({ first_name: e.target.value })} fullWidth />
        <TextField label="نام خانوادگی" value={f.last_name} onChange={(e) => set({ last_name: e.target.value })} fullWidth />
      </Stack>
      <Stack direction={{ xs: "column", sm: "row" }} gap={2}>
        <TextField label="کد پرسنلی" value={f.personnel_code} onChange={(e) => set({ personnel_code: e.target.value })} helperText="عدد ۱ تا ۹۹۹۹" fullWidth slotProps={{ htmlInput: { inputMode: "numeric", dir: "ltr" } }} />
        <TextField label="شماره موبایل" value={f.mobile} onChange={(e) => set({ mobile: e.target.value })} helperText="مثل ۰۹۱۲۱۲۳۴۵۶۷" fullWidth slotProps={{ htmlInput: { inputMode: "tel", dir: "ltr" } }} />
      </Stack>
      <GroupPicker groups={groups} value={f.group_ids} onChange={(v) => set({ group_ids: v })} />
      <FormControlLabel control={<Switch checked={f.account} onChange={(e) => set({ account: e.target.checked, password: "" })} />} label="ساخت حساب ورود" />
      {f.account ? (
        <>
          <TextField label="نام کاربری (انگلیسی)" value={f.username} onChange={(e) => set({ username: e.target.value })} helperText="حروف بزرگ و کوچک یکسان‌اند؛ مثل ali.rezaei" slotProps={{ htmlInput: { dir: "ltr", autoCapitalize: "none" } }} />
          <RoleChoice roles={roles} value={f.role_code} onChange={(v) => set({ role_code: v })} />
          <PasswordChooser mobile={f.mobile} personnelCode={f.personnel_code} privileged={false} mustChange={f.must_change}
            onMustChange={(v) => set({ must_change: v })} onPassword={(p) => set({ password: p })} />
        </>
      ) : <Typography variant="caption" color="text.secondary">بدون حساب، فرد فقط می‌تواند در گزارش‌ها نام‌برده شود؛ حساب را بعداً هم می‌توان ساخت.</Typography>}
    </FormDialog>
  );
}
