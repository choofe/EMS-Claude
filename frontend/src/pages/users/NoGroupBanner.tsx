import { useState } from "react";
import { Alert, Button, IconButton } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import { Link as RouterLink } from "react-router-dom";
import { usersApi } from "../../api/resources";
import { useAuth } from "../../auth/AuthProvider";
import { isManagement } from "../../lib/access";
import { toPersianDigits } from "../../lib/dates";
import { useLoad } from "../../lib/useLoad";

const PREFIX = "ems.noGroupBanner.hidden.";
const key = (id: number) => `${PREFIX}${id}`;
/** «Closed for this session» ends with the sign-in session: called at every explicit sign-in and sign-out. */
export function clearNoGroupBannerFlags() {
  try { Object.keys(sessionStorage).filter((k) => k.startsWith(PREFIX)).forEach((k) => sessionStorage.removeItem(k)); } catch { /* storage unavailable */ }
}
const hiddenThisSession = (id: number) => { try { return sessionStorage.getItem(key(id)) === "1"; } catch { return false; } };
const hideForSession = (id: number) => { try { sessionStorage.setItem(key(id), "1"); } catch { /* storage may be unavailable: the banner just returns on reload */ } };

/**
 * «People without a group» banner (MANAGEMENT only; the server's `no-group-alert` rule decides whether it is due).
 * «×» closes it for this browser session; «دیگر نشان نده» stores the current count on the server (it returns in a later
 * session only if the count has grown) and also hides it for the rest of this session.
 */
export function NoGroupBanner({ refreshKey }: { refreshKey?: unknown }) {
  const { user } = useAuth();
  const manage = isManagement(user);
  const alert = useLoad(() => (manage ? usersApi.noGroupAlert() : Promise.resolve(null)), [manage, refreshKey]);  // re-read after the users list changed: the server lowers its stored count only when it sees the lower count
  const [closed, setClosed] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!manage || !user || closed || !alert.data?.show || hiddenThisSession(user.id)) return null;
  const close = () => { hideForSession(user.id); setClosed(true); };
  return (
    <Alert severity="warning" sx={{ mb: 2 }} role="status"
      action={<IconButton size="small" aria-label="بستن" onClick={close}><CloseIcon fontSize="small" /></IconButton>}>
      {toPersianDigits(String(alert.data.count))} نفر از پرسنل فعال هنوز در هیچ گروهی عضو نیستند.{" "}
      <Button component={RouterLink} to="/users" size="small">مشاهده در لیست کاربران</Button>
      <Button size="small" color="inherit" disabled={failed}
        onClick={async () => { try { await usersApi.dismissNoGroupAlert(); close(); } catch { setFailed(true); } }}>
        {failed ? "ثبت نشد" : "دیگر نشان نده"}
      </Button>
    </Alert>
  );
}
