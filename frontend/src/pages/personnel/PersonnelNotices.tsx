import { Alert, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Divider, Stack, Typography } from "@mui/material";
import type { PersonnelFileDuplicate, PersonnelFileDuplicateRow, PersonnelSameNameRow } from "../../api/types";
import { Ltr } from "../../components/common";
import { toPersianDigits } from "../../lib/dates";
import { differingPositions, type DuplicateChoice } from "./personnelImportState";

const fa = (n: number) => toPersianDigits(String(n));

/** A mobile number with the digits that differ from `other` marked (the usual typing error is in the prefix). */
function Mobile({ value, other }: { value: string; other?: string }) {
  const diff = differingPositions(value, other);
  return (
    <Ltr>{[...value].map((c, i) => (diff.has(i) ? <b key={i} style={{ color: "#c62828" }}>{c}</b> : <span key={i}>{c}</span>))}</Ltr>
  );
}

const codeText = (c: number | undefined) => (c === undefined ? "بدون کد" : fa(c));

// ---------------------------------------------------------------- same names (non-blocking)
export function SameNameNotice({ count, onOpen }: { count: number; onOpen: () => void }) {
  if (count <= 0) return null;
  return (
    <Alert severity="warning" sx={{ mb: 1 }} action={<Button color="inherit" size="small" onClick={onOpen}>هم‌نام‌های موجود</Button>}>
      {fa(count)} ردیف قابل ورود با فردی که از قبل در سیستم است هم‌نام است. این هشدار ورود را متوقف نمی‌کند؛ اگر کد پرسنلی را اشتباه نوشته‌اید،
      ورود، رکورد دوم همان فرد را می‌سازد.
    </Alert>
  );
}

export function SameNameDialog({ open, onClose, rows, incomplete }: { open: boolean; onClose: () => void; rows: PersonnelSameNameRow[]; incomplete: boolean }) {
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md" scroll="paper" aria-labelledby="same-name-title">
      <DialogTitle id="same-name-title">هم‌نام‌های موجود</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          برای هر ردیف فایل، افراد موجود با همان نام دیده می‌شوند. کد و شماره موبایل را مقایسه کنید؛ رقم‌های متفاوت موبایل با رنگ قرمز مشخص شده‌اند.
        </Typography>
        {incomplete && <Alert severity="info" sx={{ mb: 1 }}>فهرست ناقص است؛ فقط ۲۰۰ ردیف اول فایل نشان داده می‌شود.</Alert>}
        <Stack gap={1.5} divider={<Divider flexItem />}>
          {rows.map((r) => (
            <Stack key={r.row} gap={0.5}>
              <Typography variant="subtitle2">
                ردیف {fa(r.row)}: {r.first_name} {r.last_name} — کد {fa(r.personnel_code)}
                {r.mobile && <> — موبایل <Mobile value={r.mobile} other={r.matches.find((m) => m.mobile)?.mobile} /></>}
              </Typography>
              {r.matches.map((m, i) => (
                <Stack key={i} direction="row" gap={1} flexWrap="wrap" alignItems="center" sx={{ pr: 2 }}>
                  <Typography variant="body2">{m.full_name} — کد {codeText(m.personnel_code)}</Typography>
                  {m.mobile && <Typography variant="body2" component="span">موبایل <Mobile value={m.mobile} other={r.mobile} /></Typography>}
                  <Chip size="small" color={m.is_active ? "success" : "default"} label={m.is_active ? "فعال" : "غیرفعال"} />
                  {m.has_profile && <Chip size="small" variant="outlined" label="دارای پروفایل" />}
                  {m.group_codes.map((g) => <Chip key={g} size="small" variant="outlined" label={<Ltr>{g}</Ltr>} />)}
                </Stack>
              ))}
              {r.matches_total > r.matches.length && <Typography variant="caption" color="text.secondary">و {fa(r.matches_total - r.matches.length)} مورد دیگر</Typography>}
            </Stack>
          ))}
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>بستن</Button></DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------- the same code or mobile twice in the file
export function DuplicateNotice({ count, onOpen }: { count: number; onOpen: () => void }) {
  if (count <= 0) return null;
  return (
    <Alert severity="warning" sx={{ mb: 1 }} action={<Button color="inherit" size="small" onClick={onOpen}>انتخاب ردیف</Button>}>
      {fa(count)} جفت ردیف در فایل کد پرسنلی یا شمارهٔ موبایل مشترک دارند. به‌طور پیش‌فرض ردیف اول وارد می‌شود و ردیف دوم نه؛ اگر ردیف دوم درست است، آن را انتخاب کنید.
    </Alert>
  );
}

function DupRow({ label, r, other }: { label: string; r: PersonnelFileDuplicateRow; other?: string }) {
  return (
    <Stack gap={0.25}>
      <Typography variant="body2"><b>{label}</b> (ردیف {fa(r.row)}): {r.first_name} {r.last_name}</Typography>
      <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center">
        <Typography variant="body2">کد {fa(r.personnel_code)}</Typography>
        {r.mobile && <Typography variant="body2" component="span">موبایل <Mobile value={r.mobile} other={other} /></Typography>}
        {r.group_codes.length ? r.group_codes.map((g) => <Chip key={g} size="small" variant="outlined" label={<Ltr>{g}</Ltr>} />) : <Typography variant="caption" color="text.secondary">بدون گروه</Typography>}
      </Stack>
    </Stack>
  );
}

export function DuplicateDialog({ open, onClose, pairs, busy, onChoose }: {
  open: boolean; onClose: () => void; pairs: PersonnelFileDuplicate[]; busy: boolean;
  onChoose: (pair: PersonnelFileDuplicate, choice: DuplicateChoice) => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md" scroll="paper" aria-labelledby="dup-title">
      <DialogTitle id="dup-title">ردیف‌های تکراری در فایل</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          پس از هر انتخاب فایل دوباره بررسی می‌شود. اگر یک کد در بیش از دو ردیف آمده باشد، پس از هر انتخاب ردیف بعدی جای ردیف کنارگذاشته‌شده را می‌گیرد و جفت‌ها تازه می‌شوند.
        </Typography>
        <Stack gap={2} divider={<Divider flexItem />}>
          {pairs.map((p) => (
            <Stack key={`${p.kind}-${p.winner.row}-${p.loser.row}`} gap={1}>
              <Stack direction="row" gap={1} alignItems="center">
                <Typography variant="subtitle2">{p.kind === "mobile" ? "شمارهٔ موبایل مشترک" : "کد پرسنلی مشترک"}</Typography>
                {p.same_name && <Chip size="small" color="info" label="احتمالاً یک نفر با دو شاخص" />}
              </Stack>
              <DupRow label="ردیف اول (پیش‌فرض وارد می‌شود)" r={p.winner} other={p.kind === "mobile" ? undefined : p.loser.mobile} />
              <DupRow label="ردیف دوم (پیش‌فرض وارد نمی‌شود)" r={p.loser} other={p.kind === "mobile" ? undefined : p.winner.mobile} />
              <Stack direction="row" gap={1} flexWrap="wrap">
                <Button size="small" variant="outlined" disabled={busy} onClick={() => onChoose(p, "keep_second")} aria-label={`ورود ردیف ${p.loser.row} به‌جای ردیف ${p.winner.row}`}>ورود ردیف دوم به‌جای اول</Button>
                <Button size="small" color="error" disabled={busy} onClick={() => onChoose(p, "none")} aria-label={`حذف هر دو ردیف ${p.winner.row} و ${p.loser.row}`}>هیچ‌کدام وارد نشود</Button>
              </Stack>
            </Stack>
          ))}
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>بستن</Button></DialogActions>
    </Dialog>
  );
}
