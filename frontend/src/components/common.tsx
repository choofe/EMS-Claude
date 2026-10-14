import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TablePagination, Typography,
} from "@mui/material";
import { errorMessage } from "../i18n/messages";
import { formatJalaliDateTime, toPersianDigits } from "../lib/dates";

export function Ltr({ children }: { children: ReactNode }) {
  return <span dir="ltr" style={{ unicodeBidi: "embed", display: "inline-block" }}>{children}</span>;
}

export function DateText({ value }: { value: string | null | undefined }) {
  return <span>{formatJalaliDateTime(value)}</span>;
}

export function StatusChip({ active }: { active: boolean }) {
  return <Chip size="small" label={active ? "فعال" : "غیرفعال"} color={active ? "success" : "default"} variant={active ? "filled" : "outlined"} />;
}

export function PageHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={1} sx={{ mb: 2 }}>
      <Typography variant="h5" component="h1">{title}</Typography>
      <Stack direction="row" gap={1} flexWrap="wrap">{actions}</Stack>
    </Stack>
  );
}

export function ErrorAlert({ error }: { error: unknown }) {
  if (!error) return null;
  return <Alert severity="error" sx={{ my: 1 }}>{errorMessage(error)}</Alert>;
}

export function Loading() {
  return <Box sx={{ display: "grid", placeItems: "center", py: 6 }}><CircularProgress size={28} aria-label="در حال بارگذاری" /></Box>;
}

export function Empty({ text = "موردی پیدا نشد." }: { text?: string }) {
  return <Typography color="text.secondary" sx={{ py: 4, textAlign: "center" }}>{text}</Typography>;
}

export function Pager(p: { total: number; page: number; rowsPerPage: number; onPage: (n: number) => void; onRows: (n: number) => void }) {
  return (
    <TablePagination
      component="div" count={p.total} page={p.page} rowsPerPage={p.rowsPerPage} rowsPerPageOptions={[10, 25, 50]}
      onPageChange={(_, n) => p.onPage(n)} onRowsPerPageChange={(e) => p.onRows(Number(e.target.value))}
      labelRowsPerPage="تعداد در صفحه"
      labelDisplayedRows={({ from, to, count }) => toPersianDigits(`${from}–${to} از ${count}`)}
    />
  );
}

interface FormDialogProps {
  open: boolean;
  title: string;
  submitLabel?: string;
  danger?: boolean;
  onClose: () => void;
  onSubmit: () => Promise<unknown>;
  children?: ReactNode;
}

/** Dialog with a submit handler that shows the server's (Persian-mapped) error and keeps the dialog open on failure. */
export function FormDialog({ open, title, submitLabel = "ذخیره", danger, onClose, onSubmit, children }: FormDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { if (open) setError(null); }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <form onSubmit={submit} noValidate>
        <DialogTitle>{title}</DialogTitle>
        <DialogContent>
          <Stack gap={2} sx={{ pt: 1 }}>
            {children}
            <ErrorAlert error={error} />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={onClose} disabled={busy}>انصراف</Button>
          <Button type="submit" variant="contained" color={danger ? "error" : "primary"} disabled={busy}>{submitLabel}</Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

export function ConfirmDialog(p: { open: boolean; title: string; text: string; confirmLabel?: string; danger?: boolean; onClose: () => void; onConfirm: () => Promise<unknown> }) {
  return (
    <FormDialog open={p.open} title={p.title} submitLabel={p.confirmLabel ?? "تأیید"} danger={p.danger} onClose={p.onClose} onSubmit={p.onConfirm}>
      <Typography>{p.text}</Typography>
    </FormDialog>
  );
}
