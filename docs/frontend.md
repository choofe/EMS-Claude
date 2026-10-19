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
users TYPE dates (Phase 6) — **not used**: typed Jalali dates are converted by `lib/jalali.ts`, which searches with the same `Intl` formatter that renders dates (so display and input can never disagree) and rejects non-existent days.

## Pages
Login · forced/voluntary change-password · Dashboard (MANAGEMENT, AUDITOR) · Users (MANAGEMENT writes, AUDITOR reads) ·
Groups · Equipment · Report types (everyone reads their scope; MANAGEMENT writes) · Settings (MANAGEMENT only).

## Equipment import page (Phase 5)
`/equipment/import`, MANAGEMENT only: group + file → preview → confirm; history with undo. Uploads use `request(..., { form })`
(no Content-Type header, the browser adds the boundary); the template is fetched with `{ blob: true }` through the authenticated client.

## Report entry page (Phase 6)
`/reports/new` (USER, EXPERT, MANAGEMENT; AUDITOR has no menu entry and is redirected). Backend rules: `docs/report-creation.md`.
- **Order**: report type → equipment (search + «میان‌بر» chips of your recent/frequent equipment; optional for general types) → group (only for a general report without equipment; preselected when you have one group) → Jalali date + time → description → labor.
- **Labor** by the type's `labor_mode`: `REQUIRED` pre-fills the author with `DEFAULT_LABOR_MINUTES` (default 30; setting editable by MANAGEMENT), removing the author's own row first asks for confirmation («حذف خودتان از فهرست ساعت‌ها؟»), then shows a warning with «افزودن خودم», and submitting with nobody listed is blocked with «ساعت کاری وارد نشده است»; `OPTIONAL` shows the section empty; `ON_REQUEST` shows the button «اضافه کردن ساعات افراد - اختیاری»; `NONE` has no section. Each person: **hours** and **minutes** boxes (whole numbers, max 24 h), preset buttons, live «مجموع: ۲ ساعت و ۱۵ دقیقه»; stored as minutes. People come from `/reports/participant-candidates` (same eligibility function as the server check); the server stays the authority.
- **Drafts**: the latest server draft is restored on open (equipment re-resolved, unavailable equipment dropped; names: server lookup → the signed-in author's own name → the name remembered in the draft → placeholder). Autosave 1.5 s after the last edit, and the button «ذخیرهٔ پیش‌نویس» saves immediately; status chip shows the last save. A blank form never creates a draft. Saves carry the draft `version`; a conflict (other tab/device) halts autosave and offers to reload instead of overwriting. Submit halts autosave, waits for an in-flight save, then submits `draft_id` (the server consumes the draft in the same transaction). One draft per user today (`MAX_DRAFTS_PER_USER`); the page uses the most recent one — a multi-draft picker is future work.
- **Heartbeat**: `POST /reports/heartbeat` every 60 s while the page is open; on failure the page warns that changes are not being saved.
- **Group change**: eligible people depend on the report's group. When another equipment/group changes the group, picked people who are not eligible there are removed with a visible warning (skipped when the candidate list is incomplete, i.e. 100 entries — the server then decides on submit). Same-group changes touch nobody.
- **Landing page** (`lib/access.ts: landingPath`): USER and EXPERT start at `/reports/new`; MANAGEMENT/AUDITOR keep the dashboard. Decided target: EXPERT → reports list of own groups, MANAGEMENT/AUDITOR → list of all reports (general reports visibly tagged) — the list is Phase 7; switch the two marked lines then.
- **Report types page** now edits `labor_mode` and «تجهیز الزامی» (off = general report type).
- Not done (Phase 11 / later): offline-lite on phones, idle-timeout UI countdown.

## Forgotten password (current process)
There is no email/SMS service in the MVP, so there is no self-service reset. The user tells a manager; the manager opens
**Users -> actions -> "تعیین رمز موقت"**, enters a temporary password (the user must change it at next login, all their sessions
are ended). The login page says so. A later "request a reset" page would only record a request for managers to act on
(username-only form, identical response for existing/unknown names, rate-limited) — needs a new table and its own decision.

## Not yet covered
Real-browser run (only jsdom tests so far); bundle splitting (single ~600 kB chunk); report detail/history pages (Phase 7+); Audit-log viewer.
