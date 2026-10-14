# Frontend (Phase 4b)

React 18 + TypeScript + Vite + MUI (RTL, Vazirmatn font bundled locally — no external CDN, which matters for users in Iran).

## Run
```bash
cd frontend && cp .env.example .env && npm install
npm run dev          # http://localhost:5173  (use "localhost", not 127.0.0.1)
npm test             # vitest (45 tests)       npm run typecheck      npm run build
```
Backend must be running (`uvicorn app.main:app --reload` in `backend/`) with an admin created via
`python -m app.cli create-user ...`. Log in with that user.

## Structure (logic is deliberately separate from look, so the UI library can be swapped later at low cost)
| Folder | Contents |
|---|---|
| `src/api/` | `http.ts` (client, token handling), `resources.ts` (one function per endpoint), `types.ts` |
| `src/auth/` | `AuthProvider` (session state), `guards` (route protection — convenience only, the API enforces everything) |
| `src/i18n/messages.ts` | Persian text for every stable backend error code |
| `src/lib/` | `dates.ts` (Jalali / Asia/Tehran display), `access.ts`, `useLoad.ts` |
| `src/components/`, `src/pages/` | MUI presentation |

## Session rules (implements docs/auth.md)
* Access token: **memory only** (a test fails if it ever reaches localStorage/sessionStorage/cookies). A page reload
  restores the session through the HttpOnly refresh cookie.
* Refresh is **single-flight** (one shared promise per tab, Web Locks across tabs); React StrictMode's double mount
  still issues one refresh. `/auth/refresh` and `/auth/logout` send `X-Requested-With: ems-web`.
* 401 -> one refresh -> retry once; a second 401 or a failed refresh signs the user out with a notice.
* `403 password_change_required` -> `/change-password`.

## Dates
The server stores UTC. The UI shows the Persian calendar in `Asia/Tehran` via the browser's `Intl` (no dependency;
handles the historical +04:30 DST). A timestamp without a timezone designator is treated as UTC. Tests run in a
non-UTC timezone and share boundary fixtures with the backend (`tests/test_jalali.py`). `jalaali-js` is only needed when
users TYPE dates (Phase 6).

## Pages
Login · forced/voluntary change-password · Dashboard (MANAGEMENT, AUDITOR) · Users (MANAGEMENT writes, AUDITOR reads) ·
Groups · Equipment · Report types (everyone reads their scope; MANAGEMENT writes) · Settings (MANAGEMENT only).

## Forgotten password (current process)
There is no email/SMS service in the MVP, so there is no self-service reset. The user tells a manager; the manager opens
**Users -> actions -> "تعیین رمز موقت"**, enters a temporary password (the user must change it at next login, all their sessions
are ended). The login page says so. A later "request a reset" page would only record a request for managers to act on
(username-only form, identical response for existing/unknown names, rate-limited) — needs a new table and its own decision.

## Not yet covered
Real-browser run (only jsdom tests so far); bundle splitting (single ~600 kB chunk); report pages (Phase 6+); Audit-log viewer.
