# Backend reset (restructure + remove demo mode + tests) — short design

Approved 2026-11-18.

**Why:** demo mode and Google Sign-In are dropped; the shared business logic
lives under `frontend/.../demo/` even though it is the real server logic, and
there are no tests. Next step (username/password login) needs a clean base.

**Goals:** handlers in `backend/src/`; live API only in the browser; fake
test data still loadable into a TEST Sheet; Node unit tests (`node --test`,
zero deps); CLAUDE.md + READMEs match reality.

**Non-goals:** new login, device API, session engine, any handler logic change.
**Anti-goals:** fake success responses; rewriting handlers; changing what
Server.gs does (only file names it mentions).

## Approaches considered
1. **Move handlers to `backend/src`, keep build-time bundling (chosen).**
   Smallest change; Server.gs and Bundle.gs shape stay the same.
2. Hand-port handlers into `.gs` files — duplicates logic, loses testability.
3. Use clasp + a bundler (esbuild) — adds npm deps the team does not need yet.

## Decisions
- `backend/src/{actions.js, utils.js, config.js, handlers/*.js}`.
  `demo-utils.js` → `utils.js`, `DemoError` → `AppError`. `config.js` exports
  only `TIMEZONE = 'Asia/Manila'` (closes ISS-20).
- Fake data: `backend/seed/seed-data.json` (converted once from demo-data.js —
  `openpyxl` is not installed here). `tools/xlsx_to_demo_data.py` →
  `tools/xlsx_to_seed_data.py`, now writes that JSON.
- Build: `tools/build_apps_script.mjs` reads `backend/src` + the JSON →
  `backend/apps-script/Bundle.gs` + `SeedData.gs`. Bundle still exposes `RFID`
  with `ACTIONS, READ, WRITE, setting, manilaNow, ...`.
- Frontend: `api.js` live only; `config.js` loses `MODE`; demo banner, "Reset
  demo data", `renderDemo`, `demo.reset`, `auth.demoSignIn` removed. Live
  test-login buttons + Google code stay untouched (next step removes them).
- Tests: `backend/test/*.test.js` + `backend/test/helpers/db.js` (small
  in-memory db). Root `package.json`: `"type": "module"`, `"test": "node --test"`.
