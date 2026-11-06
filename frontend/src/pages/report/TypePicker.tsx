import { useState } from "react";
import { Box, Button, Chip, IconButton, Paper, Stack, Tooltip, Typography } from "@mui/material";
import HelpIcon from "@mui/icons-material/HelpOutline";
import type { Mode, ReportType } from "../../api/types";

const MODE_LABEL: Record<Mode, string> = { REQUIRED: "الزامی", OPTIONAL: "اختیاری", NONE: "ندارد" };

/** Auto-generated one-line summary of a type's rules, so the guide can never go stale. */
export const typeSummary = (t: ReportType) => `ساعت کار: ${MODE_LABEL[t.labor_mode]} · تجهیز: ${MODE_LABEL[t.equipment_mode]}`;

/** Type chooser: cards with a rules summary and a «؟» guide. Shown first; the rest of the form follows the chosen type. */
export function TypePicker(p: { types: ReportType[]; value: number | ""; lastUsedId: number | null; onChange: (id: number) => void; error?: string }) {
  const [help, setHelp] = useState<number | null>(null);
  return (
    <Stack gap={1} role="radiogroup" aria-label="نوع گزارش">
      <Typography variant="subtitle1">نوع گزارش را انتخاب کنید</Typography>
      {p.error && <Typography color="error" variant="body2">{p.error}</Typography>}
      {p.types.map((t) => (
        <Paper key={t.id} variant="outlined" sx={{ p: 1.5, borderColor: p.value === t.id ? "primary.main" : undefined, borderWidth: p.value === t.id ? 2 : 1 }}>
          <Stack direction="row" alignItems="center" gap={1}>
            <Button role="radio" aria-checked={p.value === t.id} onClick={() => p.onChange(t.id)} sx={{ flex: 1, justifyContent: "flex-start", textAlign: "start" }}>
              <Box>
                <Typography component="span" sx={{ fontWeight: 600, color: "text.primary" }}>{t.name_fa}</Typography>
                {p.lastUsedId === t.id && <Chip size="small" label="آخرین استفاده" sx={{ ml: 1 }} />}
                <Typography variant="caption" color="text.secondary" display="block">{typeSummary(t)}</Typography>
              </Box>
            </Button>
            <Tooltip title="راهنما">
              <IconButton aria-label={`راهنمای ${t.name_fa}`} aria-expanded={help === t.id} onClick={() => setHelp(help === t.id ? null : t.id)}><HelpIcon /></IconButton>
            </Tooltip>
          </Stack>
          {help === t.id && (
            <Typography variant="body2" sx={{ mt: 1 }}>
              {t.help_fa ?? "برای این نوع راهنمای ویژه‌ای ثبت نشده است."} <Typography component="span" variant="body2" color="text.secondary">({typeSummary(t)})</Typography>
            </Typography>
          )}
        </Paper>
      ))}
    </Stack>
  );
}
