import type { AuthUser } from "../api/types";

/** UI convenience only — the backend enforces every one of these rules (never trust the client). */
export const isManagement = (u: AuthUser | null) => u?.role_code === "MANAGEMENT";
export const canViewAdmin = (u: AuthUser | null) => u?.role_code === "MANAGEMENT" || u?.role_code === "AUDITOR";
/** May create reports (AUDITOR is strictly read-only). The backend enforces this; the UI only hides the entry. */
export const canReport = (u: AuthUser | null) => u?.role_code === "USER" || u?.role_code === "EXPERT" || u?.role_code === "MANAGEMENT";
