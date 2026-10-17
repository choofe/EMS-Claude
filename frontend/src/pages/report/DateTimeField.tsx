import { Button, Stack, TextField } from "@mui/material";
import { textsFromDate } from "../../lib/jalali";

/** Jalali date + 24h time as two plain text boxes (any digit style accepted). Parsing/validation: lib/jalali.ts. */
export function DateTimeField(p: { dateText: string; timeText: string; onChange: (v: { dateText: string; timeText: string }) => void; error?: string }) {
  return (
    <Stack direction={{ xs: "column", sm: "row" }} gap={1.5} alignItems={{ sm: "flex-start" }} role="group" aria-label="زمان رویداد">
      <TextField label="تاریخ رویداد (شمسی)" value={p.dateText} placeholder="۱۴۰۵/۰۷/۲۵" error={!!p.error} helperText={p.error ?? "به شکل سال/ماه/روز"}
        onChange={(e) => p.onChange({ dateText: e.target.value, timeText: p.timeText })} slotProps={{ htmlInput: { dir: "ltr", inputMode: "numeric" } }} sx={{ minWidth: 190 }} />
      <TextField label="ساعت رویداد" value={p.timeText} placeholder="۱۴:۳۰" error={!!p.error}
        onChange={(e) => p.onChange({ dateText: p.dateText, timeText: e.target.value })} slotProps={{ htmlInput: { dir: "ltr", inputMode: "numeric" } }} sx={{ width: 130 }} />
      <Button onClick={() => p.onChange(textsFromDate(new Date()))} sx={{ mt: { sm: 1 } }}>اکنون</Button>
    </Stack>
  );
}
