import { useState } from "react";
import {
  AppBar, Box, Divider, Drawer, IconButton, List, ListItemButton, ListItemIcon, ListItemText, Menu, MenuItem, Toolbar, Typography, useMediaQuery, useTheme,
} from "@mui/material";
import MenuIcon from "@mui/icons-material/Menu";
import DashboardIcon from "@mui/icons-material/SpaceDashboardOutlined";
import PeopleIcon from "@mui/icons-material/PeopleAltOutlined";
import GroupsIcon from "@mui/icons-material/WorkspacesOutlined";
import BuildIcon from "@mui/icons-material/PrecisionManufacturingOutlined";
import LabelIcon from "@mui/icons-material/LabelOutlined";
import SettingsIcon from "@mui/icons-material/SettingsOutlined";
import AccountIcon from "@mui/icons-material/AccountCircleOutlined";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { canViewAdmin, isManagement } from "../lib/access";

const DRAWER = 232;

export function AppShell() {
  const { user, logout } = useAuth();
  const theme = useTheme();
  const desktop = useMediaQuery(theme.breakpoints.up("md"));
  const [open, setOpen] = useState(false);
  const [menuEl, setMenuEl] = useState<HTMLElement | null>(null);
  const navigate = useNavigate();

  const items = [
    ...(canViewAdmin(user) ? [{ to: "/", label: "داشبورد", icon: <DashboardIcon /> }] : []),
    ...(canViewAdmin(user) ? [{ to: "/users", label: "کاربران", icon: <PeopleIcon /> }] : []),
    { to: "/groups", label: "گروه‌ها", icon: <GroupsIcon /> },
    { to: "/equipment", label: "تجهیزات", icon: <BuildIcon /> },
    { to: "/report-types", label: "انواع گزارش", icon: <LabelIcon /> },
    ...(isManagement(user) ? [{ to: "/settings", label: "تنظیمات", icon: <SettingsIcon /> }] : []),
  ];

  const nav = (
    <List component="nav" aria-label="منوی اصلی" sx={{ pt: 1 }}>
      {items.map((it) => (
        <ListItemButton key={it.to} component={NavLink} to={it.to} end={it.to === "/"} onClick={() => setOpen(false)}
          sx={{ "&.active": { bgcolor: "action.selected", fontWeight: 700 } }}>
          <ListItemIcon sx={{ minWidth: 40 }}>{it.icon}</ListItemIcon>
          <ListItemText primary={it.label} />
        </ListItemButton>
      ))}
    </List>
  );

  return (
    <Box sx={{ display: "flex", minHeight: "100vh" }}>
      <AppBar position="fixed" color="primary" sx={{ zIndex: (t) => t.zIndex.drawer + 1 }}>
        <Toolbar>
          {!desktop && (
            <IconButton color="inherit" edge="start" onClick={() => setOpen(true)} aria-label="باز کردن منو"><MenuIcon /></IconButton>
          )}
          <Typography variant="h6" component="div" sx={{ flexGrow: 1, fontSize: { xs: 16, md: 20 } }}>سامانه گزارش‌دهی نگهداری تجهیزات</Typography>
          <IconButton color="inherit" onClick={(e) => setMenuEl(e.currentTarget)} aria-label="حساب کاربری"><AccountIcon /></IconButton>
          <Menu anchorEl={menuEl} open={!!menuEl} onClose={() => setMenuEl(null)}>
            <MenuItem disabled sx={{ opacity: "1 !important", display: "block" }}>
              <Typography variant="subtitle2">{user?.full_name}</Typography>
              <Typography variant="caption" color="text.secondary">{user?.role_label_fa}</Typography>
            </MenuItem>
            <Divider />
            <MenuItem onClick={() => { setMenuEl(null); navigate("/change-password"); }}>تغییر رمز عبور</MenuItem>
            <MenuItem onClick={async () => { setMenuEl(null); await logout(); navigate("/login"); }}>خروج</MenuItem>
          </Menu>
        </Toolbar>
      </AppBar>
      <Drawer variant={desktop ? "permanent" : "temporary"} open={desktop || open} onClose={() => setOpen(false)} ModalProps={{ keepMounted: true }}
        sx={{ width: desktop ? DRAWER : 0, flexShrink: 0, "& .MuiDrawer-paper": { width: DRAWER, boxSizing: "border-box" } }}>
        <Toolbar />
        {nav}
      </Drawer>
      <Box component="main" sx={{ flexGrow: 1, p: { xs: 1.5, md: 3 }, minWidth: 0 }}>
        <Toolbar />
        <Outlet />
      </Box>
    </Box>
  );
}
