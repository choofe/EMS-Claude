import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { authApi, reportsApi } from "../api/resources";
import { clearAllFor, purgeOtherUsers } from "../lib/localDraft";
import { refreshSession, setAccessToken, setSessionHandlers } from "../api/http";
import type { AuthUser, TokenResponse } from "../api/types";

type Status = "loading" | "authenticated" | "anonymous";

interface AuthContextValue {
  status: Status;
  user: AuthUser | null;
  notice: string | null;
  login: (username: string, password: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
  changePassword: (current: string, next: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const userRef = useRef<AuthUser | null>(null);
  userRef.current = user;

  const accept = useCallback((res: TokenResponse) => {
    purgeOtherUsers(res.user.id); // a different person signing in on this device must never find the previous user's unsaved report
    setAccessToken(res.access_token);
    setUser(res.user);
    setStatus("authenticated");
    setNotice(null);
    return res.user;
  }, []);

  useEffect(() => {
    setSessionHandlers({
      expired: () => {
        setUser(null);
        setStatus("anonymous");
        setNotice("نشست شما پایان یافت. دوباره وارد شوید.");
      },
      passwordChange: () => setUser((u) => (u ? { ...u, must_change_password: true } : u)),
    });
    // Page load: the access token is memory-only, so try the HttpOnly refresh cookie (single-flight: safe in StrictMode).
    refreshSession().then(accept).catch(() => setStatus("anonymous"));
    return () => setSessionHandlers({});
  }, [accept]);

  const login = useCallback(async (username: string, password: string) => accept(await authApi.login(username, password)), [accept]);

  const logout = useCallback(async () => {
    // Explicit sign-out discards the author's report draft on the server and on this device (Supervisor's rule, 2026-10-24).
    // Best effort and time-boxed: it must never keep someone from signing out. (A mere session EXPIRY keeps the local copy.)
    const uid = userRef.current?.id;
    try {
      const drafts = await Promise.race([reportsApi.drafts(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("slow")), 4000))]);
      await Promise.allSettled(drafts.map((d) => reportsApi.deleteDraft(d.id)));
    } catch { /* offline or slow: the draft stays on the server */ }
    if (uid !== undefined) clearAllFor(uid);
    try {
      await authApi.logout();
    } catch {
      /* the cookie is cleared server-side when reachable; locally we always sign out */
    }
    setAccessToken(null);
    setUser(null);
    setStatus("anonymous");
    setNotice(null);
  }, []);

  const changePassword = useCallback(
    async (current: string, next: string) => {
      accept(await authApi.changePassword(current, next));
    },
    [accept],
  );

  const value = useMemo(() => ({ status, user, notice, login, logout, changePassword }), [status, user, notice, login, logout, changePassword]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
