import { useState } from "react";
import { Box, Button, Card, CardContent, Chip, Stack, TextField, Typography } from "@mui/material";
import { settingsApi } from "../api/resources";
import type { Setting } from "../api/types";
import { ErrorAlert, FormDialog, Loading, PageHeader } from "../components/common";
import { formatJalaliDateTime, toPersianDigits } from "../lib/dates";
import { useLoad } from "../lib/useLoad";

/** Human labels for sentinel values (the API stores -1 etc.; the UI never shows raw sentinels). */
const SPECIAL: Record<string, Record<number, string>> = {
  REPORT_EDIT_WINDOW_HOURS: { [-1]: "نامحدود", 0: "بدون امکان ویرایش" },
  LOGIN_MAX_ATTEMPTS_PER_IP: { 0: "غیرفعال" },
};

export function describeValue(s: Setting, value: number = s.value): string {
  return SPECIAL[s.key]?.[value] ?? toPersianDigits(String(value));
}

function rangeText(s: Setting): string {
  const base = `مجاز: ${toPersianDigits(`${s.minimum} تا ${s.maximum}`)}`;
  const extras = s.special_values.map((v) => describeValue(s, v));
  const zero = SPECIAL[s.key]?.[0];
  const notes = [...extras, ...(zero ? [`۰ = ${zero}`] : [])];
  return notes.length ? `${base} — ${notes.join("، ")}` : base;
}

export function SettingsPage() {
  const { data, error, loading, reload } = useLoad(() => settingsApi.list(), []);
  const [editing, setEditing] = useState<Setting | null>(null);
  const [value, setValue] = useState("");
  const start = (s: Setting) => { setEditing(s); setValue(String(s.value)); };
  const parsed = Number(value);
  const valid = value.trim() !== "" && Number.isInteger(parsed);

  return (
    <>
      <PageHeader title="تنظیمات سیستم" />
      <ErrorAlert error={error} />
      {loading && !data ? <Loading /> : (
        <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" } }}>
          {data?.map((s) => (
            <Card key={s.key} variant="outlined">
              <CardContent>
                <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={1}>
                  <Typography variant="subtitle1" fontWeight={700}>{s.label_fa}</Typography>
                  <Button size="small" onClick={() => start(s)} aria-label={`ویرایش ${s.label_fa}`}>ویرایش</Button>
                </Stack>
                <Typography variant="h5" component="p" sx={{ my: 1 }}>{describeValue(s)}</Typography>
                <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center">
                  {s.is_default && <Chip size="small" label="پیش‌فرض" />}
                  <Typography variant="caption" color="text.secondary">{rangeText(s)}</Typography>
                </Stack>
                {s.updated_at && <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>آخرین تغییر: {formatJalaliDateTime(s.updated_at)}</Typography>}
              </CardContent>
            </Card>
          ))}
        </Box>
      )}

      <FormDialog open={!!editing} title={editing?.label_fa ?? ""} onClose={() => setEditing(null)}
        onSubmit={async () => { if (editing && valid) { await settingsApi.update(editing.key, parsed); reload(); } }}>
        {editing && (
          <>
            <TextField label="مقدار" type="number" value={value} onChange={(e) => setValue(e.target.value)} slotProps={{ htmlInput: { dir: "ltr", step: 1 } }} />
            <Typography variant="caption" color="text.secondary">{rangeText(editing)}</Typography>
            {editing.special_values.includes(-1) && (
              <Button size="small" variant="outlined" onClick={() => setValue("-1")} sx={{ alignSelf: "flex-start" }}>نامحدود</Button>
            )}
          </>
        )}
      </FormDialog>
    </>
  );
}
