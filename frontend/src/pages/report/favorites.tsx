import { useCallback, useRef, useState } from "react";
import { Alert, Button, Snackbar } from "@mui/material";
import { reportsApi } from "../../api/resources";
import type { Candidate } from "../../api/types";
import { errorMessage } from "../../i18n/messages";

/** Shared state of the person picker's starred shortlist (Phase 6d): every picker row on the form uses ONE controller, so
 *  the "starred only" switch and a star set in one row are seen by all rows. The server is the source of truth; the picker
 *  patches its own list at once for speed and `version` makes every picker re-read the server after any change. */
export interface Toast { text: string; severity: "info" | "error"; undo?: Candidate }
export interface FavoritesController {
  favoritesOnly: boolean;
  version: number;
  setFavoritesOnly: (value: boolean) => void;
  /** Star (`star` true) or un-star `c`. Resolves true when the server accepted it. Never throws. */
  toggle: (c: Candidate, star: boolean) => Promise<boolean>;
  /** A request for this person is still in flight: a second tap must change nothing (neither list nor server). */
  isBusy: (id: number) => boolean;
  toast: Toast | null;
  dismissToast: () => void;
  undo: (c: Candidate) => Promise<void>;
}

export function useFavorites(initialFavoritesOnly: boolean): FavoritesController {
  const [favoritesOnly, setOnly] = useState(initialFavoritesOnly);
  const [version, setVersion] = useState(0);
  const [toast, setToast] = useState<Toast | null>(null);
  const busy = useRef(new Set<number>()); // one request per person at a time: a double tap cannot send two
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const setFavoritesOnly = useCallback((value: boolean) => {
    setOnly(value);
    bump();
    reportsApi.setFavoritesFilter(value).catch((e) => { // the choice is a convenience: on failure fall back to what the server has
      setOnly(!value);
      bump();
      setToast({ text: `ذخیرهٔ این انتخاب انجام نشد: ${errorMessage(e)}`, severity: "error" });
    });
  }, [bump]);

  const toggle = useCallback(async (c: Candidate, star: boolean) => {
    if (busy.current.has(c.id)) return false;
    busy.current.add(c.id);
    try {
      await (star ? reportsApi.addFavorite(c.id) : reportsApi.removeFavorite(c.id));
      setToast(star ? null : { text: `«${c.full_name}» از ستاره‌دارها برداشته شد.`, severity: "info", undo: c });
      return true;
    } catch (e) {
      setToast({ text: errorMessage(e), severity: "error" });
      return false;
    } finally {
      busy.current.delete(c.id);
      bump(); // success or failure: re-read, so the lists show what the server really has
    }
  }, [bump]);

  const isBusy = useCallback((id: number) => busy.current.has(id), []);
  const undo = useCallback(async (c: Candidate) => { setToast(null); await toggle(c, true); }, [toggle]);
  return { favoritesOnly, version, setFavoritesOnly, toggle, isBusy, toast, dismissToast: () => setToast(null), undo };
}

/** One message at a time, at the bottom; the undo button is the safety net for an accidental un-star. */
export function FavoritesToast({ ctrl }: { ctrl: FavoritesController }) {
  const t = ctrl.toast;
  return (
    <Snackbar open={t !== null} autoHideDuration={t?.undo ? 7000 : 6000} onClose={(_, reason) => { if (reason !== "clickaway") ctrl.dismissToast(); }}
      anchorOrigin={{ vertical: "bottom", horizontal: "center" }}>
      <Alert severity={t?.severity ?? "info"} variant="filled" onClose={ctrl.dismissToast}
        action={t?.undo ? <Button color="inherit" size="small" onClick={() => void ctrl.undo(t.undo!)}>بازگردانی</Button> : undefined}>
        {t?.text}
      </Alert>
    </Snackbar>
  );
}
