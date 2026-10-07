# Authentication & authorization (Phase 3)

## Design in one paragraph
Argon2id password hashes. Short-lived (15 min) JWT **access token** that carries only the user id; the
caller's role, groups and flags are re-read from the database on every request (so deactivation and
role changes apply immediately). Opaque **refresh token** (7 days) in an `HttpOnly` cookie, stored only as a
SHA-256 hash, rotated on every use; reuse of an already-rotated token revokes the whole session family.
Authorization = a code-defined role→capability→scope matrix (`app/core/permissions.py`, pinned by
`tests/test_permissions.py`) applied to queries by `app/core/scoping.py`.

## Endpoints
| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/auth/login` | – | `{username, password}` → `{access_token, expires_in, must_change_password, user}` + refresh cookie. All failures: `401 invalid_credentials`. Lockout: `429 too_many_attempts` + `Retry-After`. |
| POST | `/auth/refresh` | cookie + `X-Requested-With: ems-web` | Rotates the refresh token, returns a new access token. |
| POST | `/auth/logout` | cookie + `X-Requested-With: ems-web` | Revokes the session family, clears the cookie (`204`). |
| GET | `/auth/me` | Bearer | Works while a password change is pending. |
| POST | `/auth/change-password` | Bearer | `{current_password, new_password}`; ends all other sessions; returns a fresh session. `422 {code: password_policy, errors: [...]}`. |

While `must_change_password` is true, `/auth/refresh` is also refused (`401 invalid_refresh_token`, nothing is consumed):
the user logs in again (allowed) and changes the password. Login attempts for one username are serialised on PostgreSQL
(advisory lock); an attempt that arrives while another for the same username is still being processed gets
`429 too_many_attempts` with `Retry-After: 1`.

Other endpoints use `Depends(get_current_principal)` / `require_capability(Capability.X)`. While
`must_change_password` is true they answer `403 password_change_required`.

## Frontend contract
1. Keep the access token **in memory only** (never `localStorage`). Send `Authorization: Bearer <token>`.
2. On `401` or just before expiry call `/auth/refresh` with `credentials: "include"` and `X-Requested-With: ems-web`.
3. **Single-flight refresh**: never run two refreshes at once (e.g. two tabs/requests) — a second use of the same
   refresh token looks like theft and ends the session.
4. Password-policy error codes: `too_short`, `too_long`, `too_common`, `too_simple`, `same_as_username`, `same_as_current`.

## Policy and runtime settings
Defaults live in code; Management tunes them via `PUT /settings/{key}` (see `docs/management-api.md`; dashboard UI in Phase 4b).
Values are clamped to hard bounds, so a bad value can never weaken the policy below the floor.

| Key | Default | Bounds |
|---|---|---|
| `PASSWORD_MIN_LENGTH` | 8 | 8–64 |
| `LOGIN_MAX_ATTEMPTS` (per username, within the window) | 5 | 3–20 |
| `LOGIN_LOCKOUT_MINUTES` (window = lockout length) | 15 | 1–1440 |
| `LOGIN_MAX_ATTEMPTS_PER_IP` | 0 (off) | 0–100000 |

Raising `PASSWORD_MIN_LENGTH` takes effect at each user's next login: a password below the current policy sets
`must_change_password`. Env-only (not tunable at runtime): `JWT_SECRET_KEY`, `JWT_ALGORITHM`, cookie flags,
token lifetimes. In `production`/`staging` the app refuses to start with a weak/default secret or a non-Secure cookie.

## Operator CLI (run from `backend/`)
```bash
python -m app.cli create-user --username admin --full-name "Admin" --role MANAGEMENT   # prompts for password
python -m app.cli reset-password --username ali                # user must change it at next login
python -m app.cli force-password-change-all                    # EVERY active user, any password; ends all sessions
```

## Deployment notes (decide in Phase 12)
* **Same-site vs cross-site**: if frontend and API are on different *sites* (e.g. two free-tier hostnames), browsers
  may block the refresh cookie. Prefer one site (reverse-proxy `/api`, or sibling subdomains of one domain). If
  unavoidable: `REFRESH_COOKIE_SAMESITE=none` + `REFRESH_COOKIE_SECURE=true`.
* **Client IP**: behind a proxy, set `TRUST_FORWARDED_FOR=true` only with exactly one trusted proxy (the last
  `X-Forwarded-For` entry is used). Keep `LOGIN_MAX_ATTEMPTS_PER_IP=0` until real client IPs are confirmed,
  otherwise a shared proxy IP would lock everyone out.
* **Argon2 memory**: ~64 MiB per concurrent login; check against the host's RAM limit.

## Accepted risks / deferred (decided with the Supervisor or by phase)
* **Lockout can be used to annoy a known user**: anyone who knows a username can trigger a 15-minute lockout for it. This is
  the inherent cost of per-username lockout (approved). A per-IP backstop does not remove it and, behind a shared proxy,
  would make it worse — hence per-IP limiting stays off until real client IPs are confirmed (Phase 12).
* **CSRF guard** relies on the mandatory `X-Requested-With: ems-web` header (forces a CORS preflight for cross-site callers);
  the `Origin` check is an additional layer that only applies when the browser sends one.
* **Usernames are case-insensitive** (since Phase 4): stored lower-case; login and lockout lower-case the typed name, so case variants share one lockout bucket.
* **Proxy depth**: `TRUST_FORWARDED_FOR` assumes exactly one trusted proxy. A `TRUSTED_PROXY_COUNT` setting is a Phase 12 task once the hosting topology is known.

## Assumptions to confirm
* `USER` export scope is `OWN` (spec s.24 text) although the s.12 table cell reads "NO*". One line in `permissions.py` + one pinned test.
* Group membership is honoured even if the group was later deactivated (history stays visible to its members).
* Soft-deleted reports are not filtered by the scoping helpers; hiding them from non-Management is Phase 7.
