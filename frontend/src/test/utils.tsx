import { render } from "@testing-library/react";
import { ThemeProvider } from "@mui/material";
import { MemoryRouter } from "react-router-dom";
import { StrictMode } from "react";
import { vi } from "vitest";
import { AppRoutes } from "../App";
import { AuthProvider } from "../auth/AuthProvider";
import { setAccessToken, setSessionHandlers } from "../api/http";
import type { AuthUser } from "../api/types";
import { theme } from "../theme/theme";

export const json = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export interface Call { method: string; path: string; query: URLSearchParams; body: unknown; headers: Headers }
type Handler = (call: Call) => Response | Promise<Response>;

/** fetch stub keyed by "METHOD /path". An unmocked request FAILS the test instead of silently passing. */
export function mockFetch(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://api.test");
    const method = (init?.method ?? "GET").toUpperCase();
    const call: Call = { method, path: url.pathname, query: url.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: new Headers(init?.headers) };
    calls.push(call);
    const handler = routes[`${method} ${url.pathname}`];
    if (!handler) throw new Error(`Unmocked request: ${method} ${url.pathname}`);
    return handler(call);
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn, count: (key: string) => calls.filter((c) => `${c.method} ${c.path}` === key).length };
}

export const makeUser = (over: Partial<AuthUser> = {}): AuthUser => ({
  id: 1, username: "boss", full_name: "مدیر سامانه", role_code: "MANAGEMENT", role_label_fa: "مدیریت", group_ids: [], must_change_password: false, ...over,
});

export const tokenBody = (user: AuthUser) => ({ access_token: "tok-" + user.username, token_type: "bearer", expires_in: 900, must_change_password: user.must_change_password, user });

export function resetClientState() {
  setAccessToken(null);
  setSessionHandlers({});
  vi.unstubAllGlobals();
}

export function renderApp(path: string, opts: { strict?: boolean } = {}) {
  const tree = (
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </MemoryRouter>
    </ThemeProvider>
  );
  return render(opts.strict ? <StrictMode>{tree}</StrictMode> : tree);
}
