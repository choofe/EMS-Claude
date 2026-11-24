import { useEffect, useState } from "react";
import {
  AppBar, Box, Button, Collapse, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, Divider, Drawer, IconButton, List, ListItemButton, ListItemIcon, ListItemText, Menu, MenuItem, Toolbar, Typography, useMediaQuery, useTheme,
} from "@mui/material";
import MenuIcon from "@mui/icons-material/Menu";
import DashboardIcon from "@mui/icons-material/SpaceDashboardOutlined";
import PeopleIcon from "@mui/icons-material/PeopleAltOutlined";
import GroupsIcon from "@mui/icons-material/WorkspacesOutlined";
import BuildIcon from "@mui/icons-material/PrecisionManufacturingOutlined";
import LabelIcon from "@mui/icons-material/LabelOutlined";
import SettingsIcon from "@mui/icons-material/SettingsOutlined";
import ExpandLess from "@mui/icons-material/ExpandLess";
import ExpandMore from "@mui/icons-material/ExpandMore";
import ImportIcon from "@mui/icons-material/UploadFileOutlined";
import ListIcon from "@mui/icons-material/ListAltOutlined";
import ReportIcon from "@mui/icons-material/EditNoteOutlined";
import AccountIcon from "@mui/icons-material/AccountCircleOutlined";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { canReport, canViewAdmin, isManagement } from "../lib/access";
import { loadLocal } from "../lib/localDraft";

const DRAWER = 232;
/** The bulk-import pages live in one menu group (MANAGEMENT only); the equipment import history will join it later. */
const IMPORT_PAGES = [
  { to: "/equipment/import", label: "ورود گروهی تجهیزات" },
  { to: "/personnel/import", label: "ورود گروهی افراد" },
  { to: "/personnel/import/history", label: "تاریخچهٔ ورود گروهی افراد" },
];
const onImportPage = (path: string) => IMPORT_PAGES.some((p) => path === p.to || path.startsWith(`${p.to}/`));

export function AppShell() {
  const { user, logout } = useAuth();
  const [confirmLogout, setConfirmLogout] = useState(false);
  const signOut = async () => { setConfirmLogout(false); await logout(); navigate("/login"); };
  const theme = useTheme();
  const desktop = useMediaQuery(theme.breakpoints.up("md"));
  const [open, setOpen] = useState(false);
  const [menuEl, setMenuEl] = useState<HTMLElement | null>(null);
  const navigate = useNavigate();

  const items = [
    ...(canViewAdmin(user) ? [{ to: "/dashboard", label: "داشبورد", icon: <DashboardIcon /> }] : []),
    ...(canViewAdmin(user) ? [{ to: "/users", label: "کاربران", icon: <PeopleIcon /> }] : []),
    { to: "/reports", label: "گزارش‌ها", icon: <ListIcon /> },
    ...(canReport(user) ? [{ to: "/reports/new", label: "ثبت گزارش", icon: <ReportIcon /> }] : []),
    { to: "/groups", label: "گروه‌ها", icon: <GroupsIcon /> },
    { to: "/equipment", label: "تجهیزات", icon: <BuildIcon /> },
    ...(isManagement(user) ? [{ group: true as const, to: "#import", label: "ورود گروهی", icon: <ImportIcon /> }] : []),
    ...(canViewAdmin(user) ? [{ to: "/report-types", label: "انواع گزارش", icon: <LabelIcon /> }] : []), // users pick a type (with its guide) in the entry form
    ...(isManagement(user) ? [{ to: "/settings", label: "تنظیمات", icon: <SettingsIcon /> }] : []),
  ];

  const { pathname } = useLocation();
  const [importOpen, setImportOpen] = useState(onImportPage(pathname));
  useEffect(() => { if (onImportPage(pathname)) setImportOpen(true); }, [pathname]);

  const nav = (
    <List component="nav" aria-label="منوی اصلی" sx={{ pt: 1 }}>
      {items.map((it) => "group" in it ? (
        <div key={it.to}>
          <ListItemButton onClick={() => setImportOpen((v) => !v)} aria-expanded={importOpen}
            sx={onImportPage(pathname) ? { fontWeight: 700 } : undefined}>
            <ListItemIcon sx={{ minWidth: 40 }}>{it.icon}</ListItemIcon>
            <ListItemText primary={it.label} />
            {importOpen ? <ExpandLess /> : <ExpandMore />}
          </ListItemButton>
          <Collapse in={importOpen} timeout="auto" unmountOnExit>
            <List disablePadding>
              {IMPORT_PAGES.map((c) => (
                <ListItemButton key={c.to} component={NavLink} to={c.to} end onClick={() => setOpen(false)}
                  sx={{ paddingInlineStart: "56px", "&.active": { bgcolor: "action.selected", fontWeight: 700 } }}>
                  <ListItemText primary={c.label} primaryTypographyProps={{ variant: "body2" }} />
                </ListItemButton>
              ))}
            </List>
          </Collapse>
        </div>
      ) : (
        <ListItemButton key={it.to} component={NavLink} to={it.to} end={it.to === "/reports" || it.to === "/equipment"} onClick={() => setOpen(false)}
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
            <IconButton color="inherit" edge="start" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label="منو"><MenuIcon /></IconButton>
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
            <MenuItem onClick={() => { setMenuEl(null); if (user && loadLocal(user.id)) setConfirmLogout(true); else void signOut(); }}>خروج</MenuItem>
          </Menu>
        </Toolbar>
      </AppBar>
      <Dialog open={confirmLogout} onClose={() => setConfirmLogout(false)} aria-labelledby="confirm-logout">
        <DialogTitle id="confirm-logout">خروج از حساب؟</DialogTitle>
        <DialogContent>
          <DialogContentText>گزارشِ در حال نوشتنِ شما (روی این دستگاه و پیش‌نویس ذخیره‌شده‌اش روی سرور) با خروج حذف می‌شود. اگر می‌خواهید بعداً ادامه دهید، فقط صفحه را ترک کنید.</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmLogout(false)} autoFocus>انصراف</Button>
          <Button color="warning" onClick={() => void signOut()}>خروج و حذف پیش‌نویس</Button>
        </DialogActions>
      </Dialog>
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
