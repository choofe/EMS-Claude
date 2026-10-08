import { CircularProgress, Box } from "@mui/material";
import { Navigate, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "./AuthProvider";
import { canViewAdmin, isManagement } from "../lib/access";

function Splash() {
  return (
    <Box sx={{ display: "grid", placeItems: "center", minHeight: "60vh" }}>
      <CircularProgress aria-label="در حال بارگذاری" />
    </Box>
  );
}

/** Signed in AND not blocked by a pending password change. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status, user } = useAuth();
  const location = useLocation();
  if (status === "loading") return <Splash />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (user.must_change_password) return <Navigate to="/change-password" replace />;
  return <>{children}</>;
}

/** Signed in (a pending password change is allowed): the change-password page itself. */
export function RequireSession({ children }: { children: ReactNode }) {
  const { status, user } = useAuth();
  const location = useLocation();
  if (status === "loading") return <Splash />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

export function RequireRole({ check, children }: { check: "admin-view" | "management"; children: ReactNode }) {
  const { user } = useAuth();
  const ok = check === "management" ? isManagement(user) : canViewAdmin(user);
  return ok ? <>{children}</> : <Navigate to="/" replace />;
}
