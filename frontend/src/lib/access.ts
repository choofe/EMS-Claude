import type { AuthUser } from "../api/types";

/** UI convenience only — the backend enforces every one of these rules (never trust the client). */
export const isManagement = (u: AuthUser | null) => u?.role_code === "MANAGEMENT";
export const canViewAdmin = (u: AuthUser | null) => u?.role_code === "MANAGEMENT" || u?.role_code === "AUDITOR";
