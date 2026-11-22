import { Alert, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Divider, Stack, Typography } from "@mui/material";
import type { PersonnelFileConflict, PersonnelFileRow, PersonnelSameNameInFile, PersonnelSameNameRow } from "../../api/types";
import { Ltr } from "../../components/common";
import { toPersianDigits } from "../../lib/dates";
import { differingPositions } from "./personnelImportState";

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

export function SameNameDialog({ open, onClose, rows, incomplete, isDropped, onToggleDrop }: {
  open: boolean; onClose: () => void; rows: PersonnelSameNameRow[]; incomplete: boolean;
  isDropped: (row: number) => boolean; onToggleDrop: (row: number) => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md" scroll="paper" aria-labelledby="same-name-title">
      <DialogTitle id="same-name-title">هم‌نام‌های موجود</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          برای هر ردیف فایل، افراد موجود با همان نام دیده می‌شوند. کد و شماره موبایل را مقایسه کنید؛ رقم‌های متفاوت موبایل با رنگ قرمز مشخص شده‌اند.
          اگر ردیف فایل همان فرد موجود است، آن را از ورود کنار بگذارید (قابل بازگردانی)؛ در غیر این صورت به‌عنوان فرد جدید وارد می‌شود.
        </Typography>
        {incomplete && <Alert severity="info" sx={{ mb: 1 }}>فهرست ناقص است؛ فقط ۲۰۰ ردیف اول فایل نشان داده می‌شود.</Alert>}
        <Stack gap={1.5} divider={<Divider flexItem />}>
          {rows.map((r) => (
            <Stack key={r.row} gap={0.5}>
              <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
                <Typography variant="subtitle2" sx={isDropped(r.row) ? { textDecoration: "line-through" } : undefined}>
                  ردیف {fa(r.row)}: {r.first_name} {r.last_name} — کد {fa(r.personnel_code)}
                  {r.mobile && <> — موبایل <Mobile value={r.mobile} other={r.matches.find((m) => m.mobile)?.mobile} /></>}
                </Typography>
                {isDropped(r.row)
                  ? <Button size="small" onClick={() => onToggleDrop(r.row)} aria-label={`بازگردانی ردیف ${r.row} (هم‌نام)`}>بازگردانی</Button>
                  : <Button size="small" color="error" onClick={() => onToggleDrop(r.row)} aria-label={`کنار گذاشتن ردیف ${r.row} (هم‌نام)`}>کنار گذاشتن این ردیف</Button>}
              </Stack>
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

// ---------------------------------------------------------------- rows of the file that share a code or a mobile
const SHARED_FA = { personnel_code: "کد پرسنلی", mobile: "شمارهٔ موبایل" } as const;

export function ConflictNotice({ count, onOpen }: { count: number; onOpen: () => void }) {
  if (count <= 0) return null;
  return (
    <Alert severity="error" sx={{ mb: 1 }} action={<Button color="inherit" size="small" onClick={onOpen}>تعیین‌تکلیف</Button>}>
      {fa(count)} گروه از ردیف‌های فایل کد پرسنلی یا شمارهٔ موبایل مشترک دارند. هیچ‌کدام از این ردیف‌ها وارد نمی‌شود و «ورود» تا تعیین‌تکلیف غیرفعال است:
      یکی را نگه دارید (بقیه کنار گذاشته می‌شوند) یا همه را کنار بگذارید.
    </Alert>
  );
}

/** One row of a cluster or of a same-name group: code and mobile with the digits that differ from the other row marked. */
function FileRowLine({ r, other }: { r: PersonnelFileRow; other?: PersonnelFileRow }) {
  const codeDiff = differingPositions(String(r.personnel_code), other && String(other.personnel_code));
  const codeText = [...String(r.personnel_code)].map((c, i) => (codeDiff.has(i) ? <b key={i} style={{ color: "#c62828" }}>{c}</b> : <span key={i}>{c}</span>));
  return (
    <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center">
      <Typography variant="body2">ردیف {fa(r.row)}: {r.first_name} {r.last_name} — کد <Ltr>{codeText}</Ltr></Typography>
      {r.mobile && <Typography variant="body2" component="span">موبایل <Mobile value={r.mobile} other={other?.mobile} /></Typography>}
      {r.group_codes.length ? r.group_codes.map((g) => <Chip key={g} size="small" variant="outlined" label={<Ltr>{g}</Ltr>} />) : <Typography variant="caption" color="text.secondary">بدون گروه</Typography>}
    </Stack>
  );
}

export function ConflictDialog({ open, onClose, clusters, busy, onResolve }: {
  open: boolean; onClose: () => void; clusters: PersonnelFileConflict[]; busy: boolean;
  onResolve: (cluster: PersonnelFileConflict, keep: number | null) => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md" scroll="paper" aria-labelledby="conflict-title">
      <DialogTitle id="conflict-title">ردیف‌های دارای کد یا موبایل مشترک</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          در هر گروه، یک ردیف را نگه دارید یا همه را کنار بگذارید. پس از هر انتخاب فایل دوباره بررسی می‌شود. رقم‌های متفاوت قرمز شده‌اند.
        </Typography>
        <Stack gap={2} divider={<Divider flexItem />}>
          {clusters.map((c) => (
            <Stack key={c.rows[0].row} gap={1}>
              <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
                <Typography variant="subtitle2">مشترک: {c.shared.map((k) => SHARED_FA[k]).join(" و ")}</Typography>
                {c.same_name && <Chip size="small" color="info" label="احتمالاً یک نفر با شاخص‌های اشتباه" />}
              </Stack>
              {c.rows.map((r, i) => (
                <Stack key={r.row} direction="row" gap={1} alignItems="center" flexWrap="wrap">
                  <FileRowLine r={r} other={c.rows[i === 0 ? 1 : 0]} />
                  <Button size="small" variant="outlined" disabled={busy} onClick={() => onResolve(c, r.row)} aria-label={`نگه داشتن ردیف ${r.row}`}>نگه‌داشتن این ردیف</Button>
                </Stack>
              ))}
              <div><Button size="small" color="error" disabled={busy} onClick={() => onResolve(c, null)} aria-label={`کنار گذاشتن همهٔ ردیف‌های ${c.rows.map((r) => r.row).join("، ")}`}>همه کنار گذاشته شوند</Button></div>
            </Stack>
          ))}
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>بستن</Button></DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------- same name in the file, different code AND mobile (warning only)
export function SameNameInFileNotice({ count, onOpen }: { count: number; onOpen: () => void }) {
  if (count <= 0) return null;
  return (
    <Alert severity="info" sx={{ mb: 1 }} action={<Button color="inherit" size="small" onClick={onOpen}>مشاهده</Button>}>
      {fa(count)} نام در فایل چند بار آمده است، با کد و موبایل متفاوت؛ احتمالاً افراد متفاوتی هستند. این هشدار ورود را متوقف نمی‌کند.
    </Alert>
  );
}

export function SameNameInFileDialog({ open, onClose, groups }: { open: boolean; onClose: () => void; groups: PersonnelSameNameInFile[] }) {
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md" scroll="paper" aria-labelledby="same-in-file-title">
      <DialogTitle id="same-in-file-title">نام‌های تکراری در فایل</DialogTitle>
      <DialogContent dividers>
        <Stack gap={1.5} divider={<Divider flexItem />}>
          {groups.map((g) => <Stack key={g.rows[0].row} gap={0.5}>{g.rows.map((r, i) => <FileRowLine key={r.row} r={r} other={g.rows[i === 0 ? 1 : 0]} />)}</Stack>)}
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>بستن</Button></DialogActions>
    </Dialog>
  );
}
