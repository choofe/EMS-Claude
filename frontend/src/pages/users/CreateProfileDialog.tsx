import { useState } from "react";
import { TextField } from "@mui/material";
import { usersApi } from "../../api/resources";
import type { Role, User } from "../../api/types";
import { FormDialog } from "../../components/common";
import { PasswordChooser } from "../../components/PasswordChooser";
import { RoleChoice } from "./NewPersonDialog";

/** An account for an existing person who has none: username, type (default «تکنسین کاربر») and a temporary password. */
export function CreateProfileDialog({ person, roles, onClose, onDone }: { person: User | null; roles: Role[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ username: "", role_code: "USER", password: "", must_change: true });
  const set = (patch: Partial<typeof f>) => setF((prev) => ({ ...prev, ...patch }));
  const reset = () => setF({ username: "", role_code: "USER", password: "", must_change: true });

  return (
    <FormDialog open={!!person} title={`ساخت حساب ورود برای ${person?.full_name ?? ""}`} submitLabel="ساخت حساب" submitDisabled={!f.username.trim() || !f.password}
      onClose={() => { onClose(); reset(); }}
      onSubmit={async () => {
        if (!person) return;
        await usersApi.createProfile(person.id, { username: f.username.trim(), password: f.password, role_code: f.role_code, must_change_password: f.must_change });
        reset();
        onDone();
      }}>
      <TextField label="نام کاربری (انگلیسی)" value={f.username} onChange={(e) => set({ username: e.target.value })} helperText="حروف بزرگ و کوچک یکسان‌اند؛ مثل ali.rezaei" slotProps={{ htmlInput: { dir: "ltr", autoCapitalize: "none" } }} />
      <RoleChoice roles={roles} value={f.role_code} onChange={(v) => set({ role_code: v })} />
      <PasswordChooser mobile={person?.mobile} personnelCode={person?.personnel_code} privileged={false} mustChange={f.must_change}
        onMustChange={(v) => set({ must_change: v })} onPassword={(p) => set({ password: p })} />
    </FormDialog>
  );
}
