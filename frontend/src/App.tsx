import { CacheProvider } from "@emotion/react";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import { RequireAuth, RequireRole, RequireSession } from "./auth/guards";
import { AppShell } from "./components/AppShell";
import { canViewAdmin } from "./lib/access";
import { ChangePasswordPage } from "./pages/ChangePasswordPage";
import { DashboardPage } from "./pages/DashboardPage";
import { EquipmentPage } from "./pages/EquipmentPage";
import { GroupsPage } from "./pages/GroupsPage";
import { LoginPage } from "./pages/LoginPage";
import { ReportTypesPage } from "./pages/ReportTypesPage";
import { SettingsPage } from "./pages/SettingsPage";
import { UsersPage } from "./pages/UsersPage";
import { rtlCache } from "./theme/rtl";
import { theme } from "./theme/theme";

function Home() {
  const { user } = useAuth();
  return canViewAdmin(user) ? <DashboardPage /> : <Navigate to="/equipment" replace />;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/change-password" element={<RequireSession><ChangePasswordPage /></RequireSession>} />
      <Route element={<RequireAuth><AppShell /></RequireAuth>}>
        <Route index element={<Home />} />
        <Route path="/users" element={<RequireRole check="admin-view"><UsersPage /></RequireRole>} />
        <Route path="/groups" element={<GroupsPage />} />
        <Route path="/equipment" element={<EquipmentPage />} />
        <Route path="/report-types" element={<ReportTypesPage />} />
        <Route path="/settings" element={<RequireRole check="management"><SettingsPage /></RequireRole>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <CacheProvider value={rtlCache}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <BrowserRouter>
          <AuthProvider>
            <AppRoutes />
          </AuthProvider>
        </BrowserRouter>
      </ThemeProvider>
    </CacheProvider>
  );
}
