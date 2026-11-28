import { Checkbox, FormControl, InputLabel, ListItemText, MenuItem, OutlinedInput, Select } from "@mui/material";
import type { Group } from "../../api/types";

export function GroupPicker({ groups, value, onChange }: { groups: Group[]; value: number[]; onChange: (v: number[]) => void }) {
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
