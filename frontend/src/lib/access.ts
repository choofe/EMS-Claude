import type { AuthUser } from "../api/types";

/** UI convenience only — the backend enforces every one of these rules (never trust the client). */
export const isManagement = (u: AuthUser | null) => u?.role_code === "MANAGEMENT";
export const canViewAdmin = (u: AuthUser | null) => u?.role_code === "MANAGEMENT" || u?.role_code === "AUDITOR";
/** May create reports (AUDITOR is strictly read-only). The backend enforces this; the UI only hides the entry. */
export const canReport = (u: AuthUser | null) => u?.role_code === "USER" || u?.role_code === "EXPERT" || u?.role_code === "MANAGEMENT";

/**
 * Where "/" sends each role after sign-in (decided 2026-10-17): USER -> report entry. EXPERT and MANAGEMENT/AUDITOR are meant
 * to land on the reports LIST (their group's / all reports, general reports visibly tagged); that list is Phase 7, so until
 * then EXPERT goes to report entry and MANAGEMENT/AUDITOR keep the dashboard. Switch the two marked lines in Phase 7.
 */
export function landingPath(u: AuthUser | null): string {
  if (canViewAdmin(u)) return "/"; // Phase 7: "/reports" (list of all reports)
  if (u?.role_code === "EXPERT") return "/reports/new"; // Phase 7: "/reports" (list of own-group reports)
  if (u?.role_code === "USER") return "/reports/new";
  return "/equipment";
}
