import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, getAccessToken, request, refreshSession, setAccessToken, setSessionHandlers } from "./http";
import { json, makeUser, mockFetch, resetClientState, tokenBody } from "../test/utils";

beforeEach(() => resetClientState());
afterEach(() => resetClientState());

describe("request()", () => {
  it("sends the bearer token, JSON body and query string; skips empty query values", async () => {
    setAccessToken("abc");
    const m = mockFetch({ "POST /users": () => json(201, { id: 1 }) });
    await request("/users", { method: "POST", body: { a: 1 }, query: { q: "x", empty: "", none: undefined, n: 0 } });
    const c = m.calls[0];
    expect(c.headers.get("Authorization")).toBe("Bearer abc");
    expect(c.headers.get("Content-Type")).toBe("application/json");
    expect(c.body).toEqual({ a: 1 });
    expect(Object.fromEntries(c.query)).toEqual({ q: "x", n: "0" });
  });

  it("login-style calls (auth:false) never send a token and never trigger a refresh on 401", async () => {
    setAccessToken("abc");
    const m = mockFetch({ "POST /auth/login": () => json(401, { detail: "invalid_credentials" }) });
    await expect(request("/auth/login", { method: "POST", body: {}, auth: false })).rejects.toMatchObject({ status: 401, code: "invalid_credentials" });
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0].headers.get("Authorization")).toBeNull();
  });

  it("on 401 refreshes ONCE (with the CSRF header) and retries with the new token", async () => {
    setAccessToken("old");
    let first = true;
    const m = mockFetch({
      "GET /users": (c) => (c.headers.get("Authorization") === "Bearer tok-boss" ? json(200, { items: [] }) : json(401, { detail: "not_authenticated" })),
      "POST /auth/refresh": () => { first = false; return json(200, tokenBody(makeUser())); },
    });
    await expect(request("/users")).resolves.toEqual({ items: [] });
    expect(first).toBe(false);
    expect(m.count("POST /auth/refresh")).toBe(1);
    expect(m.calls.find((c) => c.path === "/auth/refresh")!.headers.get("X-Requested-With")).toBe("ems-web");
    expect(getAccessToken()).toBe("tok-boss");
  });

  it("many parallel 401s share ONE refresh (a second use of the same refresh token would end the session)", async () => {
    setAccessToken("old");
    const m = mockFetch({
      "GET /users": (c) => (c.headers.get("Authorization") === "Bearer tok-boss" ? json(200, []) : json(401, { detail: "not_authenticated" })),
      "GET /groups": (c) => (c.headers.get("Authorization") === "Bearer tok-boss" ? json(200, []) : json(401, { detail: "not_authenticated" })),
      "POST /auth/refresh": async () => { await new Promise((r) => setTimeout(r, 20)); return json(200, tokenBody(makeUser())); },
    });
    await Promise.all([request("/users"), request("/groups"), request("/users"), request("/groups")]);
    expect(m.count("POST /auth/refresh")).toBe(1);
  });

  it("refresh failure signs out: handler called, token cleared, original 401 surfaced", async () => {
    setAccessToken("old");
    const expired = vi.fn();
    setSessionHandlers({ expired });
    mockFetch({ "GET /users": () => json(401, { detail: "not_authenticated" }), "POST /auth/refresh": () => json(401, { detail: "invalid_refresh_token" }) });
    await expect(request("/users")).rejects.toMatchObject({ status: 401, code: "not_authenticated" });
    expect(expired).toHaveBeenCalledTimes(1);
    expect(getAccessToken()).toBeNull();
  });

  it("a 401 that persists after a successful refresh also ends the session (no refresh loop)", async () => {
    const expired = vi.fn();
    setSessionHandlers({ expired });
    const m = mockFetch({ "GET /users": () => json(401, { detail: "not_authenticated" }), "POST /auth/refresh": () => json(200, tokenBody(makeUser())) });
    await expect(request("/users")).rejects.toBeInstanceOf(ApiError);
    expect(m.count("POST /auth/refresh")).toBe(1);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("403 password_change_required notifies the app", async () => {
    const need = vi.fn();
    setSessionHandlers({ passwordChange: need });
    mockFetch({ "GET /users": () => json(403, { detail: "password_change_required" }) });
    await expect(request("/users")).rejects.toMatchObject({ status: 403, code: "password_change_required" });
    expect(need).toHaveBeenCalledTimes(1);
  });

  it("normalises error shapes: plain code, object detail, Retry-After, validation, non-JSON, network", async () => {
    mockFetch({
      "GET /a": () => json(409, { detail: "username_taken" }),
      "GET /b": () => json(409, { detail: { code: "group_has_active_equipment", count: 3 } }),
      "GET /c": () => json(429, { detail: "too_many_attempts" }, { "Retry-After": "120" }),
      "GET /d": () => json(422, { detail: [{ loc: ["body"], msg: "bad" }] }),
      "GET /e": () => new Response("<html>boom</html>", { status: 502 }),
    });
    await expect(request("/a")).rejects.toMatchObject({ code: "username_taken" });
    await expect(request("/b")).rejects.toMatchObject({ code: "group_has_active_equipment", detail: { count: 3 } });
    await expect(request("/c")).rejects.toMatchObject({ code: "too_many_attempts", retryAfter: 120 });
    await expect(request("/d")).rejects.toMatchObject({ code: "validation_error" });
    await expect(request("/e")).rejects.toMatchObject({ code: "http_502" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(request("/f")).rejects.toMatchObject({ status: 0, code: "network_error" });
  });

  it("204 responses resolve to undefined", async () => {
    mockFetch({ "POST /auth/logout": () => json(204) });
    await expect(request("/auth/logout", { method: "POST", csrf: true, auth: false })).resolves.toBeUndefined();
  });
});

describe("token storage", () => {
  it("the access token never touches localStorage, sessionStorage or document.cookie", async () => {
    localStorage.clear();
    sessionStorage.clear();
    mockFetch({ "POST /auth/refresh": () => json(200, tokenBody(makeUser())), "GET /users": () => json(200, []) });
    await refreshSession();
    await request("/users");
    expect(getAccessToken()).toBe("tok-boss");
    setAccessToken("set-after-login");
    expect(getAccessToken()).toBe("set-after-login");
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe("");
  });
});

describe("refreshSession()", () => {
  it("concurrent callers get the same promise and a later call starts a fresh refresh", async () => {
    const m = mockFetch({ "POST /auth/refresh": () => json(200, tokenBody(makeUser())) });
    const [a, b] = [refreshSession(), refreshSession()];
    await Promise.all([a, b]);
    expect(m.count("POST /auth/refresh")).toBe(1);
    await refreshSession();
    expect(m.count("POST /auth/refresh")).toBe(2);
  });
});
