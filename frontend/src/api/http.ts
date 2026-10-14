/**
 * HTTP client. Security model (docs/auth.md):
 *  - the ACCESS token lives only in this module's memory (never localStorage/cookies);
 *  - the refresh token is an HttpOnly cookie we cannot read; /auth/refresh and /auth/logout need the CSRF header;
 *  - refresh is SINGLE-FLIGHT inside the tab (one shared promise) and across tabs (Web Locks): the server treats a
 *    second use of the same refresh token as theft and ends the session.
 */
import type { TokenResponse } from "./types";

const API_BASE: string = import.meta.env.VITE_API_BASE_URL ?? "";
const CSRF_HEADERS = { "X-Requested-With": "ems-web" };

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public detail: Record<string, unknown> = {},
    public retryAfter?: number,
  ) {
    super(code);
  }
}

let accessToken: string | null = null;
let onSessionExpired: (() => void) | null = null;
let onPasswordChangeRequired: (() => void) | null = null;

export const setAccessToken = (token: string | null) => {
  accessToken = token;
};
export const getAccessToken = () => accessToken;
export const setSessionHandlers = (h: { expired?: () => void; passwordChange?: () => void }) => {
  onSessionExpired = h.expired ?? null;
  onPasswordChangeRequired = h.passwordChange ?? null;
};

async function toApiError(res: Response): Promise<ApiError> {
  let code = `http_${res.status}`;
  let detail: Record<string, unknown> = {};
  try {
    const body = await res.json();
    if (typeof body?.detail === "string") code = body.detail;
    else if (body?.detail && typeof body.detail === "object" && !Array.isArray(body.detail)) {
      detail = body.detail;
      if (typeof detail.code === "string") code = detail.code;
    } else if (res.status === 422) code = "validation_error";
  } catch {
    /* non-JSON error body: keep the generic code */
  }
  const retry = Number(res.headers.get("Retry-After"));
  return new ApiError(res.status, code, detail, Number.isFinite(retry) && retry > 0 ? retry : undefined);
}

async function rawFetch(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(`${API_BASE}${path}`, { credentials: "include", ...init });
  } catch {
    throw new ApiError(0, "network_error");
  }
}

async function doRefresh(): Promise<TokenResponse> {
  const res = await rawFetch("/auth/refresh", { method: "POST", headers: CSRF_HEADERS });
  if (!res.ok) throw await toApiError(res);
  const body = (await res.json()) as TokenResponse;
  accessToken = body.access_token;
  return body;
}

let refreshInFlight: Promise<TokenResponse> | null = null;

/** Single-flight refresh. Across tabs, Web Locks serialise it so the second tab uses the already-rotated cookie. */
export function refreshSession(): Promise<TokenResponse> {
  if (!refreshInFlight) {
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    const run = locks ? locks.request("ems-refresh", doRefresh) : doRefresh();
    refreshInFlight = Promise.resolve(run).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Query;
  /** false for endpoints that must not carry/refresh a token (login). */
  auth?: boolean;
  csrf?: boolean;
}

function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, query, auth = true, csrf = false } = opts;
  const send = () =>
    rawFetch(withQuery(path, query), {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(csrf ? CSRF_HEADERS : {}),
        ...(auth && accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  let res = await send();
  if (res.status === 401 && auth) {
    try {
      await refreshSession();
    } catch {
      accessToken = null;
      onSessionExpired?.();
      throw await toApiError(res);
    }
    res = await send();
    if (res.status === 401) {
      accessToken = null;
      onSessionExpired?.();
    }
  }
  if (!res.ok) {
    const err = await toApiError(res);
    if (res.status === 403 && err.code === "password_change_required") onPasswordChangeRequired?.();
    throw err;
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}
