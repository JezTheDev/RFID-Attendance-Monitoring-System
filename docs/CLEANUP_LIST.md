# Cleanup list (Phase 1, read-only)

Branch `cleanup` from `main` @ 1d30de6, 2026-11-25. Nothing below has been changed yet.
Each item has a **proof** (what was searched) and a **recommendation**:
DELETE, KEEP (why), ARCHIVE (move to `docs/archive/`) or UPDATE (fix text).

How the searches were run:
- **CSS:** every `.class` / `#id` in each CSS file, searched as a whole word in every
  `frontend/**/*.html` and `*.js`. Each hit was then checked by hand for class names
  built in code (`rate-${…}`, `mark-${…}`) and for state classes that Bootstrap adds.
- **JS:** every `export` in `frontend/` and `backend/src/`, searched in all
  `.js/.mjs/.html` files and `Server.gs`. Also every top-level function/const used only
  once in its own file. Every `data-action="…"` was matched to its handler.
- **Files:** each basename in `frontend/assets` and `tools/` was searched (`git grep -F`)
  across the whole repo.

---

## 1. CSS

### 1a. `auth.css`: leftovers of the old sign-up + sliding-panel login → DELETE

`index.html` only has `.auth-card--single` with one `.auth-pane--signin`. There is no
sign-up form, no maroon overlay panel and no role cards. These selectors match nothing
in any HTML or JS file:

| Lines (approx.) | Rules | Proof |
|---|---|---|
| 2–3 | header comment "sign in / sign up … sliding maroon panel" | text only. Reword it. |
| 47–55 | `.auth-pane--signup`, `.auth-card[data-mode="signup"] …` | No `signup` class or `data-mode="signup"` anywhere. `data-mode` is always `"signin"` (index.html:20) |
| 61–123 | `.auth-overlay` (+ `::before/::after`), `@property --glow-x`, `.auth-brand …` | 0 hits for `auth-overlay`, `auth-brand` |
| 125–160 | `.auth-faces`, `.auth-face`, `.auth-face--signup/--signin` | 0 hits |
| 162–171 | `.auth-overlay h1`, `.auth-accent`, `.auth-overlay .hero-points …` | 0 hits |
| 173–243 | `.auth-cta`, `.auth-roles`, `.auth-role*` (admin/instructor/student) | 0 hits |
| 251 | `#signUpForm` | 0 hits |
| 372–422 | `.auth-row`, `.auth-segment*`, `#suTypeInstructor` (account-type switch) | 0 hits |
| 423–457 | `.auth-strength*` (password-strength bar) | 0 hits |
| 458–507 | `.auth-check*` (checkbox) | 0 hits |
| 557 + 795 | `.auth-switch-mobile` | 0 hits |
| 605–617 | `.auth-btn--ghost` | 0 hits (the page uses `auth-btn--primary` only) |
| 625 | `.auth-btn:hover .bi-send` | no `bi-send` icon anywhere |
| 673–693 | `.auth-divider` | 0 hits |
| 786–791, 799–800 | sign-up / `.auth-row` / `.auth-strength-label` rules in the mobile `@media` | same as above |
| keyframes | `authEdgeFlow` (only used by `.auth-overlay::after`) | 2 hits, both in the dead overlay rule |

Keep in auth.css: `.auth-pane--signin`, `.was-switched` (auth-forms.js:94),
`.is-shaking` (auth-forms.js:178), the forgot view, the splash, `.auth-card--single`,
and every other keyframe (each one is used by a live rule).
Estimated removal: about 300 of 1025 lines.

### 1b. `app.css`: old login layout → DELETE

| Lines | Rules | Proof |
|---|---|---|
| 39–41 | `.login-hero h1` | 0 hits for `login-hero` in HTML/JS |
| 564–601 | `.login-hero`, `.login-hero h1/p`, `.hero-points`, `.hero-points .bi` | 0 hits |
| 604–616 | `.login-form` (+ media query) | 0 hits (the page uses `.auth-form`) |

KEEP in app.css. The script flagged these, but they are used:
- `.rate-success/-warning/-danger/-secondary`: built in code, `rate-${rateTone(rate)}` (attendance-ui.js:156)
- `.mark-success/…`: built in code, `mark mark-${MARK[key].tone}` (instructor-reports.js:219, 237)
- `.offcanvas-backdrop`, `.modal-backdrop`, `.hiding`: Bootstrap adds these at run time (sidebar offcanvas, modals)

### 1c. Rules that override or repeat other rules → KEEP (no change in this cleanup)

- `app.css` has 24 selectors that appear more than once (e.g. `:root` at 1 and 626,
  `.app-sidebar` at 84/631/1034, `.user-chip` at 207/829/1202). Most of them are
  repeated on purpose: a later "polish" layer, or a copy inside a media query.
  `design-matcha.css` has 15 of these, and `auth.css` has 3.
- `design-matcha.css` overrides most colours in app.css/auth.css. This is the
  **design switch** documented in `theme.css` (delete the `@import` to go back to maroon/gold).
- Why keep: merging these is a refactor, not a cleanup. Every merge can change the order
  rules apply in, and that is exactly what the layout checker would have to catch.
  Smaller option if you want it later: merge only the exact duplicates, one file at a time,
  with a checker run after each file.

### 1d. CSS files

| File | Used by | Recommendation |
|---|---|---|
| `app.css` | all 19 pages | KEEP |
| `auth.css` | `index.html` | KEEP (trim per 1a) |
| `bubbles.css` | `index.html` | KEEP (login background bubbles) |
| `theme.css` | all 19 pages | KEEP (the design switch) |
| `design-matcha.css` | `@import` in theme.css | KEEP (the live design) |

## 2. Images

| File | Used by | Recommendation |
|---|---|---|
| `img/logo.svg` | all pages + bubbles.js | KEEP |
| `img/logo-matcha.svg` | design-matcha.css:294, 370, 374 | KEEP |

## 3. JavaScript

- **Files:** every JS file is loaded by a page or imported. `instructor-history.js` has no
  page of its own, but it is imported by instructor-attendance/-dashboard/-reports. → KEEP all.
- **Exports used only inside their own file** (the `export` keyword is not needed, but the code is used):
  `api.js ApiError`, `attendance-ui.js SESSION_PHASE`, `backend/src`: `DEVICE_TABS`,
  `DEVICE_ACTIONS`, `findUserByUsername`, `USERNAME_PATTERN`, `DEVICE_STATUSES`,
  `statusFor`, `summarize`. → KEEP. Removing `export` saves nothing. CLAUDE.md names
  `DEVICE_ACTIONS` and `statusFor`, and the backend ones are exposed through the Bundle namespace.
- **Functions defined but never called:** none found (frontend, backend/src, tools).
- **Buttons with no handler:** none. All `data-action` values are handled: `sign-out`,
  `toggle-sidebar` (ui.js:182, 233), `retry` (resource-manager.js:174, account.js:76,
  admin-attendance.js:161), `cancel-change` (auth-forms.js:250). Every HTML `id` is used
  by JS, CSS or a `for=`/`aria-*` link.
- `auth-forms.js:92` keeps old `#signup` links working by sending them to sign in. → KEEP
  (one line, so old bookmarks do not break).

## 4. tools/

| Tool | References | Recommendation |
|---|---|---|
| `build_apps_script.mjs` | CLAUDE.md, READMEs, server-gs.test.js | KEEP |
| `measure_device_api.mjs`, `measure_admin_reports.mjs` | CLAUDE.md, docs | KEEP |
| `live_device_test.mjs` | CLAUDE.md, Server.gs, live-device-tool.test.js | KEEP |
| `check_layout.mjs` (+ `backend/tests/helpers/layout-api.js`) | RELEASE_READINESS | KEEP. Add it to CLAUDE.md (missing from the tools list) |
| `preview_server.mjs` | **no references anywhere** | **KEEP + document**. See below. |

**Why keep `preview_server.mjs`:** it does a different job from `check_layout.mjs`.
- `check_layout.mjs` is automated. It takes Playwright screenshots against a small fake
  API (`layout-api.js`), with frozen data and no real logins.
- `preview_server.mjs` is interactive. It runs the **real** `Server.gs` + `Bundle.gs` on
  a fake Sheet with the TEST seed data, so you can sign in as admin/instructor/student
  and click through every flow, including from a phone on the same Wi-Fi.

Phase 2's "local click-through of every page per role" needs preview_server.mjs.
Recommendation: add one line for it to CLAUDE.md and the root README.
Note: it listens on `0.0.0.0` (your LAN can reach it). The data is fake, so that is acceptable.

## 5. docs/

| Doc | Referenced by | Recommendation |
|---|---|---|
| `PROJECT_CONTEXT.md`, `BACKEND_VERIFICATION.md`, `Device_API_Spec.md`, `PRODUCTION_SETUP.md`, `RELEASE_READINESS.md` | (your keep list) | KEEP |
| `PAPER_SYSTEM_LOGIC.md` | none (new, 2026-11-25) | KEEP (current thesis reference) |
| `ADMIN_FRONTEND_AUDIT.md` | **none** | ARCHIVE (2026-11-20 audit, done) |
| `INSTRUCTOR_FRONTEND_AUDIT.md` | **none** | ARCHIVE |
| `STUDENT_FRONTEND_AUDIT.md` | **none** | ARCHIVE |
| `FINAL_BACKEND_REVIEW.md` | CLAUDE.md:6 ("current state"), RELEASE_READINESS:251 (P9), wrapup-fixes.test.js:1 (comment) | ARCHIVE. RELEASE_READINESS is now the current state. Update the 3 references to `docs/archive/FINAL_BACKEND_REVIEW.md` |
| `RFID_Attendance_System_Architecture.md` | Device_API_Spec, BACKEND_VERIFICATION, PAPER_SYSTEM_LOGIC | **Your call.** It is the "Proposed" architecture (983 lines). It is older than the code, but the paper and the API spec cite it. I lean KEEP, because it is thesis material and linked from current docs. |
| `docs/archive/**` | — | KEEP (already history) |

### READMEs: stale text → UPDATE

- `README.md` "Status (2026-11-18)" table: says the Device API is "Not started" and the
  firmware is "Not in this repository yet". Both are wrong now (step 4 is done, and `firmware/` exists).
  The docs row names "final review". Add `check_layout.mjs` and `preview_server.mjs` to the tools row.
- `frontend/README.md`: the status row says "Polish comes in Step 3" (done). It says
  "Design system (PSU maroon/gold)", but the live design is Matcha via `theme.css` →
  `design-matcha.css`. The css folder line does not list `theme.css` / `design-matcha.css`.
  "Run it locally" should mention `node tools/preview_server.mjs` (fake data, no live API).
- `CLAUDE.md:5-6` points to FINAL_BACKEND_REVIEW as current (see above). The `tools/`
  block is missing `check_layout.mjs` and `preview_server.mjs`.

## 6. Repo root and ignored files

| Item | State | Recommendation |
|---|---|---|
| `README.md`, `CLAUDE.md`, `package.json`, `.gitattributes`, `.gitignore` | tracked | KEEP |
| `node_modules/` (playwright, for check_layout), `layout-shots/`, `.claude/` | in .gitignore | KEEP (local only) |
| `.superpowers/sdd/REDESIGN_PLAN/` | ignored via `.git/info/exclude` | KEEP (local only, not in the repo) |
| Stray or temporary tracked files | none found | — |

### Finding: the firmware secrets template is ignored by mistake → your call (1-line fix)

The pattern `firmware/**/secrets*.h` (.gitignore:2) also matches
**`secrets.example.h`** (`git check-ignore -v` confirms it). Only `rfid_attendance.ino`
is tracked. A fresh clone has no template, so the firmware cannot be set up from the repo.
I read the file: it holds placeholders only (`your-wifi-name`, `XXXXXXXX`,
`paste-the-64-character-device-key-here`). No real secrets.
Fix: add `!firmware/**/secrets.example.h` to .gitignore and commit the example.
Also: `.gitignore` lines 1 and 10 both say `firmware/**/secrets.h`, which line 2 already
covers. → DELETE those two duplicate lines (`secrets.h` stays ignored by line 2).

## 7. Git branches merged into main (list only, nothing deleted)

Local (28): `admin-attendance`, `admin-corrections`, `admin-frontend`,
`backend-production-cleanup`, `backend-reset`, `backend-verification`,
`backend-wrapup-fixes`, `date-filters`, `docs-device-spec-v02`, `final-backend-review`,
`fix-bug-1`, `fix-bug-2`, `fix-bug-3`, `fix-bug-5`, `fix-bug-6`, `hash-iterations-300`,
`instructor-frontend`, `login-backend`, `release-check`, `settings-api`, `step4a-speed`,
`step4b-devices`, `step4c-session-engine`, `step4d-submit-scans`,
`step4e-heartbeat-roster`, `step4f-live-test`, `student-frontend`, `temp-passwords`.
Remote: `origin/backend-work`.
**Not merged:** `redesign` (keep it until you decide).
To delete the local ones later: `git branch -d <name>`. It refuses any branch that is not merged.

---

## Phase 2 plan (after approval)

1. Baseline first: run the FULL checker on the untouched tree,
   `node tools/check_layout.mjs --write-baseline <scratch>/before.json`.
2. Apply only the approved items (1a, 1b, 5 archive moves, README/CLAUDE.md updates,
   and optionally the .gitignore fix).
3. Verify: `npm test`, `node tools/build_apps_script.mjs` (Bundle.gs must not change,
   because no backend code changes), `node tools/check_layout.mjs --compare <scratch>/before.json`
   (must not get worse), then click through every page per role on `preview_server.mjs`.
4. One commit on `cleanup`.

---

## Phase 2 result (2026-11-25)

Approved and done: 1a + 1b (auth.css 1025 → 623 lines, app.css −58 lines), the 4 docs
archived and their 3 links fixed, preview_server + check_layout + firmware added to
CLAUDE.md, root + frontend READMEs updated, .gitignore fix (`secrets.example.h`
committed, `git check-ignore` still ignores `firmware/rfid_attendance/secrets.h`), and the
28 merged local branches deleted with `git branch -d` (`main`, `redesign` and the remote kept).
`RFID_Attendance_System_Architecture.md` kept.

Verification:
- `npm test`: 621 pass, 0 fail.
- Build: no backend change. A rebuild only changes the date header and some blank-line
  whitespace, so the generated files were not committed.
- Full layout checker (3 engines x 7 widths x 19 pages): before = after. The item lists
  are identical. touch_target is 1729 both times (already there before), and every other check is 0.
- Login page pixel check (old CSS vs new CSS, 3 engines x 6 widths x sign-in/forgot):
  33–35 of 36 identical. The rest is render noise: the same CSS compared with itself gives the same mismatches.
- Click-through on `preview_server.mjs`: the login page (wrong password → "Incorrect
  username or password.", forgot view and back, forced password change) and every page for
  admin (10), instructor (4) and student (4). 0 console errors, 0 API errors, 0 error boxes,
  no sideways scrolling. Sign-out works for every role.
