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
Login · forced/voluntary change-password · Reports list and detail (all roles, Phase 7b) · Dashboard (MANAGEMENT, AUDITOR, at `/dashboard`) · Users (MANAGEMENT writes, AUDITOR reads) ·
Groups · Equipment · Report types (everyone reads their scope; MANAGEMENT writes) · Settings (MANAGEMENT only).

## Equipment import page (Phase 5)
`/equipment/import`, MANAGEMENT only: group + file → preview → confirm; history with undo. Uploads use `request(..., { form })`
(no Content-Type header, the browser adds the boundary); the template is fetched with `{ blob: true }` through the authenticated client.

## Report entry page (Phase 6)
`/reports/new` (USER, EXPERT, MANAGEMENT; AUDITOR has no menu entry and is redirected). Backend rules: `docs/report-creation.md`.
- **Type first.** The page opens with the type chooser only: one card per type with an auto-generated rules summary («ساعت کار: الزامی · تجهیز: اختیاری») and a «؟» guide (management-written `help_fa`); the last used type is highlighted. After choosing, the rest of the form follows that type; «تغییر نوع» brings the chooser back.
- **Three modes for labor AND equipment** (`REQUIRED` / `OPTIONAL` = hidden behind a button / `NONE`). Changing the type keeps what was typed in memory, but the NEW type decides what is shown and what is sent; if data becomes hidden a visible notice says so, hidden data is never sent, and the button/back-to-previous-type brings it back. REQUIRED labor is pre-filled with the author and `DEFAULT_LABOR_MINUTES`; removing the author's own row first asks for confirmation, then warns with «افزودن خودم»; submitting with nobody listed is blocked («ساعت کاری وارد نشده است»).
- Order: type → equipment (search + «میان‌بر» chips; or the optional button) → group (only for a report without equipment; preselected when you have one) → Jalali date + time → description → labor (hours and minutes boxes, whole numbers, max 24 h, presets, live total). People come from `/reports/participant-candidates` (same eligibility function as the server check); changing the report's group removes people not eligible there, with a notice.
- **Favorite people (Phase 6d):** in every person picker a star beside the search box toggles «فقط ستاره‌دارها» (stored on the server per user; shared by all rows of the form), and every listed person has a star at the far end of the row (the author's own entry has none). Starring never selects the person; a row that already holds a person can still be searched (the picker gives MUI ONE stable `value` object, otherwise MUI resets the text box to the name on every keystroke); un-starring in starred-only mode removes the person at once and shows a message at the top with «بازگردانی» and a close button (several messages stack, newest on top, each with its own timer and undo); the messages are rendered in `<body>` (Portal) and shifted by `window.visualViewport.offsetTop`, so on phones (keyboard open, zoom) they stay inside the visible area, not at the top of the page (state and messages: `pages/report/favorites.tsx`; the list always re-reads the server after a change). Details and rules: `docs/report-creation.md`.
- **Dates**: two text boxes (Jalali date, 24 h time; Persian or Latin digits); conversion in `lib/jalali.ts` uses the same `Intl` formatter that renders dates, so display and input cannot disagree; non-existent days are rejected.
- **Two layers protect what the author types** (2026-10-24):
  1. **Device-local working copy** (`lib/localDraft.ts`, `localStorage`, keyed by user id, time-stamped, remembers the server draft id/version it was based on). Written ~0.3 s after every edit and when the page is hidden; costs the server nothing; survives offline editing, a killed tab, a reload (the Vite dev server reloads the page when its connection returns — production does not, but phones kill tabs). Removed on submit, on «دورانداختن پیش‌نویس» and on explicit sign-out; KEPT when the session merely expires; every OTHER user's copy is deleted the moment a different user signs in.
  2. **Server draft** (cross-device, ONE per user) — only for report TEXT, i.e. large work: choosing a type/equipment/people never creates one. Schedule (`lib/saveSchedule.ts`): first save after ~100 changed characters or ~25 s since typing started, the next after 70 / 20 s, then 45 / 15 s, with a floor of 20 characters / 10 s (whichever comes first); plus an immediate save when the page is hidden (app switch, screen lock) and the button «ذخیرهٔ پیش‌نویس».
- **Opening the page decides between the two copies**: nothing → empty form; server draft only (another device) → restored automatically (nothing to lose); local only → restored with a banner; both and the local copy is built on the current server version → the local one (it is newer, e.g. edits made offline); both and the server moved on (or the local copy never reached the server) → **the author chooses** (times shown) and the other version is kept for «بازگرداندن» (undo) until the next server draft version or the submit. A local copy built on a draft that no longer exists (submitted/deleted elsewhere) is restored but cannot be re-submitted by accident (see below).
- **Sign-out** (explicit) deletes the author's server draft(s) and the local copies; when this device holds unsaved report work it asks first («خروج و حذف پیش‌نویس»). It is best-effort with ONE ~4 s deadline for the whole clean-up (listing and deleting; in-flight requests are cancelled when it passes): offline or stalled, signing out still works.
- **One submission = one report.** Every attempt of a submission carries the same `client_request_id` (a retry after a lost response returns the same report: `already_created`); a second tab/device holding the same draft gets `draft_not_found`, which BLOCKS the plain button — only «ثبت به‌عنوان گزارش جدید» (new key) or «شروع فرم جدید» continue. Re-entry is guarded (Enter twice / double tap = one request).
- A `409` conflict (changed or created elsewhere) halts autosave and offers «بارگذاری نسخهٔ ذخیره‌شده»; a `404` on save never recreates the draft. Submit halts autosave, waits at most 8 s for an in-flight save, and creates a draft first when none exists.
- **No request hangs the UI**: every API call times out after 30 s (uploads/downloads 120 s) and fails with «ارتباط با سرور برقرار نشد»; a heartbeat (`POST /reports/heartbeat`, 60 s) warns when the server is unreachable.
- Reloading never renders the previous load's data (loads are stamped with an epoch): a discarded draft cannot reappear.
- **Report types page** (management/auditor only: no menu entry, route guarded; users meet the types through the picker and its guide) edits `labor_mode`, `equipment_mode` and the guide text.
- **Landing page** (`lib/access.ts: landingPath`): every signed-in role starts at `/reports` (Phase 7b, below); the dashboard is at `/dashboard`.
- Not done (later): offline-lite on phones, idle-timeout UI countdown, UX batch (shorter menus, «اکنون» rounding, day buttons, apply-to-all), quick-add people, teams.

## Personnel import page (phase-personnel, Pe)
Route `/personnel/import` (MANAGEMENT only; menu entry «ورود گروهی افراد»). Code: `src/pages/personnel/` (`PersonnelImportPage.tsx`, pure logic in `personnelImportState.ts`, Persian texts in `personnelImportMessages.ts`), API in `personnelImportApi` (`api/resources.ts`).
- Flow: choose `.xlsx`/`.csv` -> ONE `POST /personnel/import/preview` (no corrections) -> the answer and the file stay in page state (a refresh starts over) -> `POST /personnel/import/commit` with the file, `preview_sha256` and the corrections list.
- Two lists: «قابل ورود» (counts, the 10-row `sample` the server returns, and the FULL list of rows that need a group decision) and «نامعتبر» (rows with row errors, including duplicate personnel code or mobile; they are not imported and not fixable here). Both lists show 50 at a time with «نمایش بیشتر» and «X از Y». The full list of valid rows is NOT available before commit (the backend returns only the sample; Amin's decision, 2026-11-18: no backend change, feedback after use); the people of a batch are listed after commit by the history page (`Ph`).
- Fixing invalid group codes: only by choosing one of the ACTIVE groups (`GET /groups`, no free typing), by removing the code (`x`, the person stays) or by dropping the row. The preview is not repeated after a fix: the counts are computed in the page (`summarize`) and the server re-validates every correction at commit. «ورود» stays disabled while a row with an undecided code remains or nothing is importable.
- After `import_conflict`, `correction_group_invalid`, `file_changed`, `nothing_to_import` or a stale-corrections answer (`correction_row_not_found`, `correction_token_not_found`, `duplicate_correction`) nothing was imported: the page shows the personnel text of the code and starts over. `group_issues_unresolved` (a group changed after the preview) also starts over, and the group list is reloaded; `invalid_corrections` keeps the state. The personnel texts of the shared codes are page-level overrides (`personnelErrorMessage`), so the equipment import keeps its own texts.
- `CSV` problem report BEFORE commit: `POST /personnel/import/problems.csv` with the file and the CURRENT corrections, saved as a blob (the request carries the manager's token; there is no public link). AFTER commit the report is built in the page from the commit answer's `errors` (`importedProblemsCsv`; the file is never re-analysed once the people exist, the database would report them as taken). The `CSV` columns are `row, first_name, last_name, personnel_code, problem_code, description_fa` (names absent from an error stay empty).
- Limits: replacement options come from ALL pages of `GET /groups` (active ones only); the commit is blocked above 2,000 corrections (the server's limit) and `invalid_corrections` keeps the file and the decisions; token keys are prefixed so a code like `constructor` is an ordinary token.
- The link to the import history page is added with `Ph`.
- **Sub-phase `Pj` (frontend of `Pi`; no backend change):** both lists show «نام‌خانوادگی (کد پرسنلی)» (`personLabel`; the code alone when the last name is absent: the backend omits the key, it never sends `null`). The template button is «قالب Excel», a plain download link to `${BASE_URL}personnel-import-template.xlsx` (`frontend/public/`); the old `CSV` template button and its function are gone. The help text names the Persian headers and says a mobile with or without the leading zero is accepted.
- **Same-name notice** (non-blocking): ONE warning above the lists (`SameNameNotice`) plus a «هم‌نام‌های موجود» dialog (`SameNameDialog`): per file row its matches (code or «بدون کد», active, «دارای پروفایل», groups, «و N مورد دیگر» from `matches_total`), with BOTH mobile numbers (only when the backend sends them: `personnel.mobile.view`) and the differing digits in red. Rows dropped through a group decision leave the count and the dialog (`sameNamesAfterFixes`); a list shorter than `same_name_count` is flagged as incomplete.
- **Conflict clusters** (`file_conflicts`): an error-coloured banner («تعیین‌تکلیف») plus a dialog (`ConflictDialog`) with every row of each cluster (names, code, mobile, groups; differing digits in red). «نگه‌داشتن این ردیف» keeps that row and drops the others, «همه کنار گذاشته شوند» drops all; after each choice the preview is re-run with the rows chosen so far (`dupRows`), the group decisions are kept, a failed re-run keeps the page as it was. «ورود» is disabled while a cluster is open (`canCommit`), and the server also refuses (`file_conflicts_unresolved`, which restarts the page). A same name with different code AND mobile (`same_name_in_file`) is an info banner plus a read-only dialog. A drop decided in a group row stays a drop even when a repeated preview no longer lists the row as a group issue (`droppedByFix`). A file has at most 200 rows.


### Personnel import history page (phase-personnel, Ph)
Route `/personnel/import/history` (MANAGEMENT only). Entry points: the menu group «ورود گروهی» (below) and the «تاریخچهٔ ورود گروهی» button on the import page (at the opposite end of the header from «قالب Excel»). AUDITOR gets no page (Amin 2026-11-23), although the read endpoints stay open to AUDITOR. Code: `PersonnelImportHistoryPage.tsx`, pure helpers in `personnelHistory.ts`, texts for `batch_changed`, `nothing_to_cancel`, `import_batch_not_found` in `personnelImportMessages.ts`, API `personnelImportApi.batches/batchPeople/cancelPreview/cancel`. No backend change.
- List: one clickable card per batch (no buttons on the card), 25 at a time with «نمایش بیشتر» (appends the next 25; a stale answer never replaces a newer one); «X از Y ردیف وارد شد» (`created_count` of `created_count + rejected_count`, which equals every row of the file because a commit is refused while a group issue or a conflict is left); every batch has an explicit status chip: «بدون لغو», «بخشی لغو شده», «کامل لغو شده».
- Details dialog (opens on a click of the card): summary, the people as they are NOW (names, code, groups, inactive / has-profile chips; 25 per page from the server), and the cancel section at the bottom. Mobile numbers are shown at once on a desktop screen and on a phone only after «نمایش شماره‌ها» (a convenience, not a security measure: the server decides who receives the number, capability `personnel.mobile.view`).
- Cancel (two steps inside the dialog; shown only while `remaining_count > 0`, so a partly cancelled batch can be cancelled again): «لغو این ورود…» loads the preview (writes nothing: how many go, how many stay and why: profile, reports, labor rows, stars); the confirm needs the tick «متوجه‌ام که حذف این افراد برگشت‌پذیر نیست» and sends the preview's `fingerprint`. On `batch_changed` or `nothing_to_cancel` nothing was deleted: the message is shown, the numbers are reloaded, the tick is cleared and the manager confirms again (never repeated automatically). After success a notice «N نفر حذف شد و M نفر ماند.» is shown and the list is reloaded (everything already shown, at most 100).
- The `CSV` problem report is NOT part of the history: the file is not stored, so a past batch cannot produce it (the report is available on the import page before and right after the commit).
- Menu (`AppShell.tsx`): MANAGEMENT sees ONE group «ورود گروهی» (collapsible) with three pages: «ورود گروهی تجهیزات», «ورود گروهی افراد», «تاریخچهٔ ورود گروهی افراد»; the equipment import history will join it later. The group opens by itself when the route is one of these pages (also when the manager had closed it and moves in through a page link); only the current page is highlighted. Other roles see none of it.
- Fine-tune candidates (Amin, 2026-11-23, NOT built): a switch «نمایش لغوشده‌ها» (default off; needs a `status` filter in the batches endpoint); per-person cancel (one person of a batch); a per-person removable / not-removable status with the reasons in the people list (needs the reasons per person from the backend).
## Reports list, detail and equipment history (Phase 7b)
`/` sends EVERY signed-in role to `/reports` (`lib/access.ts: landingPath`, decided by Amin 2026-11-07); what the list shows is
decided by the backend scope (docs/report-views.md). The dashboard moved to `/dashboard`.
- **List** (`pages/reports/ReportsListPage.tsx`): table on desktop, cards on phones (same `md` breakpoint as the shell). Table columns
  come from `GET /reports/columns` (only `default_visible` ones that have a cell renderer; a future per-user choice only changes that
  list); `event_datetime`/`created_at` headers sort. Filters and sort sit behind one «فیلتر و مرتب‌سازی» button (closed by default on a phone, open on desktop; a badge counts active filters, «پاک کردن فیلترها» resets them; the sort selector is the only sort control on phones). Filters: report number, equipment code, description text, type, group, Jalali
  from/to date (typed text; an invalid date is shown and never sent; `to` = last minute of that day), «مشارکت من», «فقط عمومی». Text
  filters are debounced; any filter change restarts from the first page; «بیشتر» appends the next cursor page, and an answer that
  arrives after the filters changed is dropped. General reports carry an «عمومی (بدون تجهیز)» chip.
- The shell's menu button toggles the drawer (a second tap closes it; fixed in 7b).
- **Equipment history** = the same list with `?equipment_id=…&equipment=CODE` (entry: the history icon on each row of the equipment page,
  and the equipment link in a report). A chip shows and clears the filter; `other_group_reports_may_exist` shows the notice
  «ممکن است گزارش‌هایی از گروه قبلی وجود داشته باشد» (never a number).
- **Detail** (`ReportDetailPage.tsx`): full description, lock state, and labor behind a collapsed button («دیدن ساعات کاری ثبت‌شده» / «پنهان کردن»). With rows the button appears (wording «دیدن ساعت کاری من» and an own-row-only note when `participants_complete` is false); a complete empty list shows «برای این گزارش ساعت کاری ثبت نشده است»; when the viewer may see no row at all the whole labor section is omitted (no button, and never a «no labor recorded» claim). Missing, foreign and
  soft-deleted reports give one neutral message (`404 report_not_found`).
- Not yet: the «edited» marker (7c), lock/delete actions (7d), priority (7e–7g), per-user column choice, Jalali date picker (6e).

## Forgotten password (current process)
There is no email/SMS service in the MVP, so there is no self-service reset. The user tells a manager; the manager opens
**Users -> actions -> "تعیین رمز موقت"**, enters a temporary password (the user must change it at next login, all their sessions
are ended). The login page says so. A later "request a reset" page would only record a request for managers to act on
(username-only form, identical response for existing/unknown names, rate-limited) — needs a new table and its own decision.

## Not yet covered
Real-browser run (only jsdom tests so far); bundle splitting (single ~600 kB chunk); report edit/lock/priority screens (Phase 7c+); Audit-log viewer.

## Users list (sub-phase Pf)

Page `/users` (`pages/UsersPage.tsx`), read-only part of the personnel users panel; creating and editing people comes in `Pk` and `Pl`.

- Columns: name (with the username under it), «کد پرسنلی», mobile (MANAGEMENT only: AUDITOR gets no column because the server sends no number; on a phone the column is added with «نمایش شماره‌ها»), role label (or «—»), group tags, state tags («فعال/غیرفعال», «دارای حساب/بدون حساب», «ورود خاموش» for a profile whose login is off, «تغییر رمز در انتظار»). The «؟» in the state header explains the tags.
- Group cell: tags of the group codes; MANAGEMENT and AUDITOR show «مدیر» / «بازرس ارشد» and are never marked; a person with `needs_group` shows «بدون گروه» and the whole row is tinted. The server already orders such people first on every page (`needs_group` is one server definition shared with the banner).
- Filters: role, active, «حساب» (`has_login`); the search also matches a personnel code exactly.
- `NoGroupBanner` (MANAGEMENT only; on the users page and on the landing page `/reports`): the text and count come from `GET /users/no-group-alert`; «×» hides it for the browser session (`sessionStorage`, per user id); «دیگر نشان نده» calls the dismiss endpoint (the server then shows it again only when the count grows) and hides it for the session; a failed dismiss keeps the banner and the button says «ثبت نشد».
- `components/HelpHint.tsx`: a «؟» that opens after a 1-second hover pause and closes by itself after about 5 seconds; a click or tap opens it and the next closes it (a click-opened help does not time out); keyboard focus opens it.
- Words: the dashboard figure and the groups-page column say «پرسنل»; the role `USER` is displayed «تکنسین کاربر» (the label comes from the database, migration `c5a1f7d3e902`).
- The legacy create form (`POST /users`) is untouched until `Pk`.

