import { useEffect, useState } from "react";
import { Autocomplete, Chip, CircularProgress, Stack, TextField, Typography } from "@mui/material";
import { equipmentApi, reportsApi } from "../../api/resources";
import type { Candidate, QuickPick } from "../../api/types";
import { Ltr } from "../../components/common";
import type { EquipmentOption } from "./reportForm";

/** Runs `load` 250 ms after `input` stops changing; ignores stale answers. */
function useDebouncedOptions<T>(input: string, load: (q: string) => Promise<T[]>, enabled: boolean, deps: readonly unknown[]) {
  const [options, setOptions] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!enabled) { setOptions([]); return; }
    let alive = true;
    setLoading(true);
    const t = setTimeout(() => {
      load(input.trim()).then((o) => alive && setOptions(o)).catch(() => alive && setOptions([])).finally(() => alive && setLoading(false));
    }, input ? 250 : 0);
    return () => { alive = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, enabled, ...deps]);
  return { options, loading };
}

export function EquipmentPicker(p: {
  value: EquipmentOption | null; onChange: (e: EquipmentOption | null) => void; optional: boolean; quick: QuickPick | null; error?: string;
}) {
  const [input, setInput] = useState(p.value?.equipment_code ?? ""); // a restored draft already has a value at mount
  const { options, loading } = useDebouncedOptions<EquipmentOption>(
    p.value && input === p.value.equipment_code ? "" : input,
    async (q) => (await equipmentApi.list({ limit: 20, offset: 0, q: q || undefined, is_active: true })).items, true, []);
  const quick = p.quick ? dedupe([...p.quick.recent.slice(0, 5), ...p.quick.frequent.slice(0, 5)]) : [];
  return (
    <Stack gap={1}>
      <Autocomplete<EquipmentOption>
        value={p.value} options={options} loading={loading} filterOptions={(o) => o}
        isOptionEqualToValue={(a, b) => a.id === b.id}
        getOptionLabel={(o) => o.equipment_code}
        inputValue={input} onInputChange={(_, v) => setInput(v)}
        onChange={(_, v) => p.onChange(v)}
        noOptionsText="تجهیزی پیدا نشد" loadingText="در حال جستجو…" clearText="پاک کردن" openText="باز کردن" closeText="بستن"
        renderOption={(props, o) => (
          <li {...props} key={o.id}><Stack><Ltr>{o.equipment_code}</Ltr>{o.description && <Typography variant="caption" color="text.secondary">{o.description}</Typography>}</Stack></li>
        )}
        renderInput={(params) => (
          <TextField {...params} label={p.optional ? "تجهیز (اختیاری)" : "تجهیز"} error={!!p.error} helperText={p.error ?? "بخشی از کد را بنویسید"}
            slotProps={{ htmlInput: { ...params.inputProps, dir: "ltr" }, input: { ...params.InputProps, endAdornment: <>{loading && <CircularProgress size={16} />}{params.InputProps.endAdornment}</> } }} />
        )}
      />
      {quick.length > 0 && !p.value && (
        <Stack direction="row" gap={0.75} flexWrap="wrap" alignItems="center" aria-label="تجهیزات اخیر و پرکاربرد">
          <Typography variant="caption" color="text.secondary">میان‌بر:</Typography>
          {quick.map((e) => <Chip key={e.id} size="small" variant="outlined" label={<Ltr>{e.equipment_code}</Ltr>} onClick={() => p.onChange(e)} />)}
        </Stack>
      )}
    </Stack>
  );
}

const dedupe = <T extends { id: number }>(items: T[]) => items.filter((x, i) => items.findIndex((y) => y.id === x.id) === i);

export function PersonPicker(p: {
  value: { id: number; name: string } | null; context: { equipment_id?: number; group_id?: number } | null;
  exclude: number[]; onChange: (c: Candidate) => void; label: string;
}) {
  const [input, setInput] = useState(p.value?.name ?? "");
  const enabled = p.context !== null;
  const { options, loading } = useDebouncedOptions<Candidate>(
    p.value && input === p.value.name ? "" : input, (q) => reportsApi.candidates({ ...p.context!, q: q || undefined, limit: 50 }), enabled, [p.context?.equipment_id, p.context?.group_id]);
  return (
    <Autocomplete<Candidate>
      size="small" disabled={!enabled}
      value={p.value ? { id: p.value.id, full_name: p.value.name } : null}
      options={options.filter((o) => !p.exclude.includes(o.id) || o.id === p.value?.id)} loading={loading} filterOptions={(o) => o}
      isOptionEqualToValue={(a, b) => a.id === b.id} getOptionLabel={(o) => o.full_name}
      inputValue={input} onInputChange={(_, v) => setInput(v)}
      onChange={(_, v) => v && p.onChange(v)}
      noOptionsText="فردی پیدا نشد" loadingText="در حال جستجو…" clearText="پاک کردن" openText="باز کردن" closeText="بستن"
      renderInput={(params) => <TextField {...params} label={p.label} helperText={enabled ? undefined : "ابتدا تجهیز یا گروه را انتخاب کنید"} />}
      sx={{ minWidth: 200, flex: 1 }}
    />
  );
}

