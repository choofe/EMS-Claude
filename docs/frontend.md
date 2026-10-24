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
- **Type first.** The page opens with the type chooser only: one card per type with an auto-generated rules summary («ساعت کار: الزامی · تجهیز: اختیاری») and a «؟» guide (management-written `help_fa`); the last used type is highlighted. After choosing, the rest of the form follows that type; «تغییر نوع» brings the chooser back.
- **Three modes for labor AND equipment** (`REQUIRED` / `OPTIONAL` = hidden behind a button / `NONE`). Changing the type keeps what was typed in memory, but the NEW type decides what is shown and what is sent; if data becomes hidden a visible notice says so, hidden data is never sent, and the button/back-to-previous-type brings it back. REQUIRED labor is pre-filled with the author and `DEFAULT_LABOR_MINUTES`; removing the author's own row first asks for confirmation, then warns with «افزودن خودم»; submitting with nobody listed is blocked («ساعت کاری وارد نشده است»).
- Order: type → equipment (search + «میان‌بر» chips; or the optional button) → group (only for a report without equipment; preselected when you have one) → Jalali date + time → description → labor (hours and minutes boxes, whole numbers, max 24 h, presets, live total). People come from `/reports/participant-candidates` (same eligibility function as the server check); changing the report's group removes people not eligible there, with a notice.
- **Dates**: two text boxes (Jalali date, 24 h time; Persian or Latin digits); conversion in `lib/jalali.ts` uses the same `Intl` formatter that renders dates, so display and input cannot disagree; non-existent days are rejected.
- **One draft per user.** The user's draft is restored on open (equipment re-resolved, unavailable equipment dropped; names: server lookup → the signed-in author → the name stored in the draft → placeholder). Autosave 1.5 s after the last edit, immediately when the page is hidden (app switch / screen lock), and with the button «ذخیرهٔ پیش‌نویس». A blank form never creates a draft. `409` conflict (changed or created elsewhere) halts autosave and offers «بارگذاری نسخهٔ ذخیره‌شده»; `404` (submitted/deleted elsewhere) halts autosave and offers «شروع فرم جدید» — it never recreates the draft. Submit halts autosave, waits at most 8 s for an in-flight save, creates a draft first when none exists, then submits `draft_id`, so a retry after a lost response cannot create a second report.
- **No request hangs the UI**: every API call times out after 30 s (uploads/downloads 120 s) and fails with «ارتباط با سرور برقرار نشد»; a heartbeat (`POST /reports/heartbeat`, 60 s) warns when the server is unreachable.
- Reloading never renders the previous load's data (loads are stamped with an epoch): a discarded draft cannot reappear.
- **Report types page** edits `labor_mode`, `equipment_mode` and the guide text.
- **Landing page** (`lib/access.ts: landingPath`): USER and EXPERT start at `/reports/new`; MANAGEMENT/AUDITOR keep the dashboard until the Phase 7 reports list exists (two marked lines to switch).
- Not done (later): offline-lite on phones, idle-timeout UI countdown, UX batch (shorter menus, «اکنون» rounding, day buttons, apply-to-all), quick-add people, teams.

## Forgotten password (current process)
There is no email/SMS service in the MVP, so there is no self-service reset. The user tells a manager; the manager opens
**Users -> actions -> "تعیین رمز موقت"**, enters a temporary password (the user must change it at next login, all their sessions
are ended). The login page says so. A later "request a reset" page would only record a request for managers to act on
(username-only form, identical response for existing/unknown names, rate-limited) — needs a new table and its own decision.

## Not yet covered
Real-browser run (only jsdom tests so far); bundle splitting (single ~600 kB chunk); report detail/history pages (Phase 7+); Audit-log viewer.
