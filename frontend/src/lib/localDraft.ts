/**
 * Device-local working copy of the report form (2026-10-24). It protects what the author typed when the network drops,
 * the tab is killed, the page is reloaded (Vite dev server does that on reconnect) — none of which the server can see.
 * Cost to the server: zero. Keyed by user id; time-stamped; remembers which server draft version it was based on, so that on
 * the next visit the page can tell "my copy is the newest" from "someone saved a newer one elsewhere".
 *
 * Lifecycle: written on every change; removed on submit, discard and explicit logout; KEPT when the session merely expires;
 * every other user's copy is removed the moment a different user signs in (shared computers).
 * A second slot holds the version that was just replaced by a restore/choice, so «واگرد» can bring it back.
 */
import { newRowKey, type FormState } from "../pages/report/reportForm";

const MAIN = "ems.reportForm.";
const UNDO = "ems.reportForm.undo.";

export interface LocalSnapshot {
  v: 1;
  userId: number;
  savedAt: string; // ISO
  baseDraftId: number | null;
  baseVersion: number | null;
  form: FormState;
}

function store(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

function write(key: string, snap: LocalSnapshot) {
  try { store()?.setItem(key, JSON.stringify(snap)); } catch { /* quota / private mode: the server draft remains the safety net */ }
}

function read(key: string, userId: number): LocalSnapshot | null {
  try {
    const raw = store()?.getItem(key);
    if (!raw) return null;
    const snap = JSON.parse(raw) as LocalSnapshot;
    if (snap?.v !== 1 || snap.userId !== userId || !snap.form || typeof snap.savedAt !== "string") return null;
    return { ...snap, form: { ...snap.form, labor: (snap.form.labor ?? []).map((r) => ({ ...r, key: newRowKey() })) } };
  } catch { return null; }
}

const remove = (key: string) => { try { store()?.removeItem(key); } catch { /* ignore */ } };

export const makeSnapshot = (userId: number, form: FormState, base: { draftId: number | null; version: number | null }, now: Date = new Date()): LocalSnapshot =>
  ({ v: 1, userId, savedAt: now.toISOString(), baseDraftId: base.draftId, baseVersion: base.version, form });

export const saveLocal = (snap: LocalSnapshot) => write(MAIN + snap.userId, snap);
export const loadLocal = (userId: number) => read(MAIN + userId, userId);
export const clearLocal = (userId: number) => remove(MAIN + userId);

export const saveUndo = (snap: LocalSnapshot) => write(UNDO + snap.userId, snap);
export const loadUndo = (userId: number) => read(UNDO + userId, userId);
export const clearUndo = (userId: number) => remove(UNDO + userId);

export function clearAllFor(userId: number) { clearLocal(userId); clearUndo(userId); }

/** Called when a user signs in: every other user's copies on this device are deleted. */
export function purgeOtherUsers(userId: number) {
  const s = store();
  if (!s) return;
  const doomed: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const key = s.key(i);
    if (!key || !key.startsWith(MAIN)) continue;
    const id = Number(key.startsWith(UNDO) ? key.slice(UNDO.length) : key.slice(MAIN.length));
    if (id !== userId) doomed.push(key);
  }
  doomed.forEach(remove);
}
