import { useEffect, useState } from "react";
import { Autocomplete, Chip, CircularProgress, IconButton, Stack, TextField, Typography } from "@mui/material";
import StarIcon from "@mui/icons-material/Star";
import StarBorderIcon from "@mui/icons-material/StarBorder";
import { equipmentApi, reportsApi } from "../../api/resources";
import type { Candidate, QuickPick } from "../../api/types";
import type { FavoritesController } from "./favorites";
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
  return { options, setOptions, loading };
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
  exclude: number[]; onChange: (c: Candidate) => void; label: string; favorites: FavoritesController; selfId: number;
}) {
  const [input, setInput] = useState(p.value?.name ?? "");
  const [open, setOpen] = useState(false);
  const enabled = p.context !== null;
  const { favoritesOnly, version } = p.favorites;
  const searching = p.value && input === p.value.name ? "" : input; // the selected person's own name is not a search
  const { options, setOptions, loading } = useDebouncedOptions<Candidate>(
    searching,
    (q) => reportsApi.candidates({ ...p.context!, q: q || undefined, limit: 50, ...(favoritesOnly ? { favorites_only: true } : {}) }),
    enabled, [p.context?.equipment_id, p.context?.group_id, favoritesOnly, version]);

  // The star acts at once on the list (a person leaves the starred-only list immediately); the server answer then re-reads it.
  const onStar = (o: Candidate) => {
    if (p.favorites.isBusy(o.id)) return; // double tap while the first request is still running
    const star = !o.is_favorite;
    setOptions((list) => (favoritesOnly && !star ? list.filter((x) => x.id !== o.id) : list.map((x) => (x.id === o.id ? { ...x, is_favorite: star } : x))));
    void p.favorites.toggle(o, star);
  };
  const empty = favoritesOnly
    ? (searching.trim() ? "در ستاره‌دارها فردی با این نام نیست" : "هنوز کسی را ستاره‌دار نکرده‌اید. با خاموش کردن ستارهٔ کنار کادر جستجو، همهٔ افراد را ببینید و کنار نام هر نفر ستاره بزنید.")
    : "فردی پیدا نشد";

  return (
    <Autocomplete<Candidate>
      size="small" disabled={!enabled}
      open={open} onOpen={() => setOpen(true)} onClose={() => setOpen(false)}
      value={p.value ? { id: p.value.id, full_name: p.value.name } : null}
      options={options.filter((o) => !p.exclude.includes(o.id) || o.id === p.value?.id)} loading={loading} filterOptions={(o) => o}
      isOptionEqualToValue={(a, b) => a.id === b.id} getOptionLabel={(o) => o.full_name}
      inputValue={input} onInputChange={(_, v) => setInput(v)}
      onChange={(_, v) => v && p.onChange(v)}
      noOptionsText={empty} loadingText="در حال جستجو…" clearText="پاک کردن" openText="باز کردن" closeText="بستن"
      renderOption={(props, o) => {
        const { key: _key, ...rest } = props as typeof props & { key?: string };
        return (
          <li key={o.id} {...rest} style={{ ...(rest.style ?? {}), display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <span>{o.full_name}</span>
            {o.id !== p.selfId && (
              // End of the row (far from the name) and a large target; the click must NOT select the person.
              <IconButton aria-label={o.is_favorite ? `برداشتن ستارهٔ ${o.full_name}` : `ستاره‌دار کردن ${o.full_name}`} aria-pressed={!!o.is_favorite}
                color={o.is_favorite ? "warning" : "default"} sx={{ width: 44, height: 44, flexShrink: 0, ms: 1 }}
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); onStar(o); }}>
                {o.is_favorite ? <StarIcon /> : <StarBorderIcon />}
              </IconButton>
            )}
          </li>
        );
      }}
      renderInput={(params) => (
        <TextField {...params} label={p.label} helperText={enabled ? undefined : "ابتدا تجهیز یا گروه را انتخاب کنید"}
          slotProps={{
            htmlInput: params.inputProps,
            input: {
              ...params.InputProps,
              endAdornment: (
                <>
                  {open && (
                    <IconButton size="small" aria-label="فقط ستاره‌دارها" aria-pressed={favoritesOnly} title="فقط ستاره‌دارها" color={favoritesOnly ? "warning" : "default"}
                      onMouseDown={(e) => e.preventDefault()} onClick={() => p.favorites.setFavoritesOnly(!favoritesOnly)}>
                      {favoritesOnly ? <StarIcon fontSize="small" /> : <StarBorderIcon fontSize="small" />}
                    </IconButton>
                  )}
                  {params.InputProps.endAdornment}
                </>
              ),
            },
          }} />
      )}
      sx={{ minWidth: 200, flex: 1 }}
    />
  );
}
