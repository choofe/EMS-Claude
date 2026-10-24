import { useState } from "react";
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, IconButton, Paper, Stack, TextField, Tooltip, Typography } from "@mui/material";
import DeleteIcon from "@mui/icons-material/DeleteOutline";
import AddIcon from "@mui/icons-material/Add";
import type { Mode } from "../../api/types";
import { formatMinutes, splitMinutes } from "../../lib/labor";
import { newRowKey, rowMinutes, type LaborRow } from "./reportForm";
import { PersonPicker } from "./pickers";

const PRESETS: { label: string; minutes: number }[] = [
  { label: "۳۰ دقیقه", minutes: 30 }, { label: "۱ ساعت", minutes: 60 }, { label: "۱ ساعت و ۳۰ دقیقه", minutes: 90 }, { label: "۲ ساعت", minutes: 120 },
];

export function LaborSection(p: {
  mode: Mode; rows: LaborRow[]; onChange: (rows: LaborRow[], removed?: LaborRow) => void;
  context: { equipment_id?: number; group_id?: number } | null; author: { id: number; full_name: string };
  authorRemoved: boolean; maxMinutes: number; error?: string;
}) {
  const [confirming, setConfirming] = useState<LaborRow | null>(null);
  const remove = (r: LaborRow) => p.onChange(p.rows.filter((x) => x.key !== r.key), r);
  const set = (key: string, patch: Partial<LaborRow>) => p.onChange(p.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const taken = p.rows.map((r) => r.userId).filter((x): x is number => x !== null);
  const authorMissing = p.authorRemoved && !taken.includes(p.author.id);
  const total = p.rows.reduce((sum, r) => sum + (rowMinutes(r) ?? 0), 0);

  return (
    <Paper variant="outlined" sx={{ p: 2 }} role="group" aria-label="ساعت کار افراد">
      <Typography variant="subtitle1" sx={{ mb: 0.5 }}>ساعت کار افراد {p.mode === "REQUIRED" ? "" : "(اختیاری)"}</Typography>
      <Typography variant="caption" color="text.secondary">برای هر نفر مدت کار را به «ساعت» و «دقیقه» وارد کنید (فقط عدد صحیح؛ حداکثر ۲۴ ساعت).</Typography>

      {authorMissing && (
        <Alert severity="warning" sx={{ mt: 1 }}
          action={<Button color="inherit" size="small" onClick={() => p.onChange([...p.rows, { key: newRowKey(), userId: p.author.id, name: p.author.full_name, ...splitMinutes(30) }])}>افزودن خودم</Button>}>
          شما (تولیدکنندهٔ گزارش) از فهرست ساعت‌ها حذف شده‌اید. اگر در این کار نقش داشته‌اید، خودتان را اضافه کنید.
        </Alert>
      )}
      {p.error && <Alert severity="error" sx={{ mt: 1 }}>{p.error}</Alert>}

      <Stack gap={1.5} sx={{ mt: 1.5 }}>
        {p.rows.map((r, i) => {
          const m = rowMinutes(r);
          return (
            <Stack key={r.key} gap={0.75} role="group" aria-label={`ردیف ${i + 1}`}>
              <Stack direction={{ xs: "column", sm: "row" }} gap={1} alignItems={{ sm: "flex-start" }}>
                <PersonPicker label="نام فرد" value={r.userId !== null ? { id: r.userId, name: r.name } : null} context={p.context} exclude={taken}
                  onChange={(c) => set(r.key, { userId: c.id, name: c.full_name })} />
                <TextField size="small" label="ساعت" value={r.hours} onChange={(e) => set(r.key, { hours: e.target.value })} sx={{ width: 90 }}
                  slotProps={{ htmlInput: { inputMode: "numeric", dir: "ltr", "aria-label": `ساعت ${r.name || i + 1}` } }} />
                <TextField size="small" label="دقیقه" value={r.minutes} onChange={(e) => set(r.key, { minutes: e.target.value })} sx={{ width: 90 }}
                  slotProps={{ htmlInput: { inputMode: "numeric", dir: "ltr", "aria-label": `دقیقه ${r.name || i + 1}` } }} />
                <Tooltip title="حذف ردیف"><IconButton aria-label={`حذف ردیف ${i + 1}`} onClick={() => (r.userId === p.author.id ? setConfirming(r) : remove(r))}><DeleteIcon /></IconButton></Tooltip>
              </Stack>
              <Stack direction="row" gap={0.75} flexWrap="wrap" alignItems="center">
                {PRESETS.map((x) => (
                  <Button key={x.minutes} size="small" variant="outlined" onClick={() => set(r.key, splitMinutes(x.minutes))}>{x.label}</Button>
                ))}
                <Typography variant="body2" color={m === null || m > p.maxMinutes ? "error" : "text.secondary"} sx={{ ml: 1 }}>
                  {m === null ? "مقدار نامعتبر" : m === 0 ? "" : `مجموع: ${formatMinutes(m)}`}
                </Typography>
              </Stack>
            </Stack>
          );
        })}
      </Stack>

      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mt: 1.5 }}>
        <Button startIcon={<AddIcon />} onClick={() => p.onChange([...p.rows, { key: newRowKey(), userId: null, name: "", hours: "", minutes: "" }])}>افزودن نفر</Button>
        {p.rows.length > 1 && <Typography variant="body2">جمع کل: {formatMinutes(total)}</Typography>}
      </Stack>
      <Dialog open={confirming !== null} onClose={() => setConfirming(null)} aria-labelledby="confirm-self-remove">
        <DialogTitle id="confirm-self-remove">حذف خودتان از فهرست ساعت‌ها؟</DialogTitle>
        <DialogContent>
          <DialogContentText>شما تولیدکنندهٔ این گزارش هستید. اگر خودتان را حذف کنید، ساعت کار شما در این گزارش ثبت نمی‌شود. مطمئن هستید؟</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirming(null)} autoFocus>انصراف</Button>
          <Button color="warning" onClick={() => { if (confirming) remove(confirming); setConfirming(null); }}>بله، حذف شود</Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
}
