import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, IconButton, Stack } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import { reportsApi } from "../../api/resources";
import type { Candidate } from "../../api/types";
import { errorMessage } from "../../i18n/messages";

/** Shared state of the person picker's starred shortlist (Phase 6d): every picker row on the form uses ONE controller, so
 *  the "starred only" switch and a star set in one row are seen by all rows. The server is the source of truth; the picker
 *  patches its own list at once for speed and `version` makes every picker re-read the server after any change. */
export interface Toast { id: number; text: string; severity: "info" | "error"; undo?: Candidate }
export const TOAST_MAX = 4;            // more than this at once would cover the form: the oldest one is dropped
export const TOAST_MS = 5000;          // plain messages
export const TOAST_UNDO_MS = 6000;     // messages with «بازگردانی» stay a little longer
export interface FavoritesController {
  favoritesOnly: boolean;
  version: number;
  setFavoritesOnly: (value: boolean) => void;
  /** Star (`star` true) or un-star `c`. Resolves true when the server accepted it. Never throws. */
  toggle: (c: Candidate, star: boolean) => Promise<boolean>;
  /** A request for this person is still in flight: a second tap must change nothing (neither list nor server). */
  isBusy: (id: number) => boolean;
  /** Newest first: a new message pushes the older ones down; each one leaves on its own timer. */
  toasts: Toast[];
  dismissToast: (id: number) => void;
  /** Star `c` again and close the message `toastId` it came from. */
  undo: (toastId: number, c: Candidate) => Promise<void>;
}

export function useFavorites(initialFavoritesOnly: boolean): FavoritesController {
  const [favoritesOnly, setOnly] = useState(initialFavoritesOnly);
  const [version, setVersion] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((t: Omit<Toast, "id">) => setToasts((l) => [{ ...t, id: ++seq.current }, ...l].slice(0, TOAST_MAX)), []);
  const dismissToast = useCallback((id: number) => setToasts((l) => l.filter((t) => t.id !== id)), []);
  const busy = useRef(new Set<number>()); // one request per person at a time: a double tap cannot send two
  const filterSave = useRef<Promise<void>>(Promise.resolve()); // filter writes run in call order: the last choice is the last write
  const filterRequest = useRef(0);                              // id of the newest choice; only it may roll the switch back
  const confirmed = useRef(initialFavoritesOnly);               // the value the server last accepted (what a failed save falls back to)
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const setFavoritesOnly = useCallback((value: boolean) => {
    const request = ++filterRequest.current;
    setOnly(value);
    bump();
    filterSave.current = filterSave.current
      .then(() => reportsApi.setFavoritesFilter(value))
      .then(() => { confirmed.current = value; }, (e) => { // the choice is a convenience: a failed save never blocks the later ones
        if (request !== filterRequest.current) return;       // a newer choice supersedes this failure: leave the screen alone
        setOnly(confirmed.current);
        bump();
        push({ text: `ذخیرهٔ این انتخاب انجام نشد: ${errorMessage(e)}`, severity: "error" });
      });
  }, [bump, push]);

  const toggle = useCallback(async (c: Candidate, star: boolean) => {
    if (busy.current.has(c.id)) return false;
    busy.current.add(c.id);
    try {
      if (star) await reportsApi.addFavorite(c.id);
      else {
        const res = await reportsApi.removeFavorite(c.id);
        // Over the quota an undo would be refused, so no «بازگردانی» is offered; the message says why instead (Amin, 2026-11-02).
        if (res?.can_restore === false) push({ text: `«${c.full_name}» از ستاره‌دارها برداشته شد. تعداد ستاره‌دارهای شما از سقف بیشتر است؛ بازگردانی ممکن نیست.`, severity: "info" });
        else push({ text: `«${c.full_name}» از ستاره‌دارها برداشته شد.`, severity: "info", undo: c });
      }
      return true;
    } catch (e) {
      push({ text: errorMessage(e), severity: "error" });
      return false;
    } finally {
      busy.current.delete(c.id);
      bump(); // success or failure: re-read, so the lists show what the server really has
    }
  }, [bump, push]);

  const isBusy = useCallback((id: number) => busy.current.has(id), []);
  const undo = useCallback(async (toastId: number, c: Candidate) => { dismissToast(toastId); await toggle(c, true); }, [dismissToast, toggle]);
  return { favoritesOnly, version, setFavoritesOnly, toggle, isBusy, toasts, dismissToast, undo };
}

/** The messages sit at the TOP, under the app bar, newest first. Every message has its own close button (MUI hides the built-in one
 *  as soon as an action is given) and its own timer; «بازگردانی» belongs to the message it came from, so several quick un-stars can
 *  each be undone. */
function ToastItem({ t, ctrl }: { t: Toast; ctrl: FavoritesController }) {
  const { id, undo } = t;
  const { dismissToast } = ctrl;
  useEffect(() => {
    const timer = setTimeout(() => dismissToast(id), undo ? TOAST_UNDO_MS : TOAST_MS);
    return () => clearTimeout(timer);
  }, [id, undo, dismissToast]);
  return (
    <Alert severity={t.severity} variant="filled" sx={{ pointerEvents: "auto", alignItems: "center" }}
      action={
        <>
          {t.undo && <Button color="inherit" size="small" onClick={() => void ctrl.undo(t.id, t.undo!)}>بازگردانی</Button>}
          <IconButton color="inherit" size="small" aria-label="بستن پیام" onClick={() => ctrl.dismissToast(t.id)}><CloseIcon fontSize="small" /></IconButton>
        </>
      }>
      {t.text}
    </Alert>
  );
}

export function FavoritesToast({ ctrl }: { ctrl: FavoritesController }) {
  if (ctrl.toasts.length === 0) return null;
  return (
    <Stack component="section" aria-label="پیام‌های ستاره‌دارها" spacing={1}
      sx={{ position: "fixed", top: { xs: 64, sm: 72 }, left: "50%", transform: "translateX(-50%)", width: "min(92vw, 440px)",
        zIndex: (th) => th.zIndex.snackbar, pointerEvents: "none" }}>
      {ctrl.toasts.map((t) => <ToastItem key={t.id} t={t} ctrl={ctrl} />)}
    </Stack>
  );
}
