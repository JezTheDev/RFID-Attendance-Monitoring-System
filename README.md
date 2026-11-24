# IoT-Based RFID Attendance Monitoring System

Pampanga State University — Department of Computer Engineering.

Students tap an RFID card on an **ESP32 + MFRC522** reader in the classroom.
The reader sends the scan to a **Google Apps Script Web App**, which records
attendance in a **private Google Sheet**. A static website (GitHub Pages) has
three portals: **Admin**, **Instructor** and **Student**.

```
ESP32 reader ─┐
              ├─POST─▶ Apps Script Web App ──▶ Google Sheet (one tab per table)
Website ──────┘
```

| Folder | Contents |
|---|---|
| `backend/` | Apps Script server + business logic + tests (see `backend/README.md`) |
| `frontend/` | Website for GitHub Pages (see `frontend/README.md`) |
| `tools/` | `build_apps_script.mjs` (builds Bundle.gs/SeedData.gs), `preview_server.mjs` (local preview on fake data), `check_layout.mjs` (layout checker), device/report measurement + live test scripts |
| `firmware/` | ESP32 sketch, stage 1 (copy `secrets.example.h` to `secrets.h`; never commit it) |
| `docs/` | Architecture, Device API spec, backend verification, release readiness, paper system logic, `PRODUCTION_SETUP.md`; `archive/` = old audits, final backend review and plans |

## Status (2026-11-25)

| Part | Status |
|---|---|
| Backend (Apps Script): router, sessions, role + ownership checks, LockService | Done |
| Admin portal: dashboard, students & RFID cards, instructors, admins, classes/schedules/enrollments, academic setup | Done |
| Instructor portal: dashboard, sessions, attendance corrections, roster, reports + CSV | Done |
| Student portal: overview, history, profile | Done |
| Unit tests for the business logic (`npm test`) | Done |
| Login: admin-created username/password accounts | Done: lockout, forced first-login password change, admin reset/unlock, account page |
| Device API (`device.submitScans`, heartbeat, roster) + session engine | Done (see `docs/Device_API_Spec.md`) |
| Firmware (ESP32 + MFRC522) | Stage 1 in `firmware/rfid_attendance/` |
| Website design | Matcha Latte (`frontend/assets/css/theme.css` → `design-matcha.css`) |

There is **no demo mode** and **no Google Sign-In**: the website always talks
to the live Apps Script backend. Fake data is only for a TEST Google Sheet
and the local preview (`tools/preview_server.mjs`).

## Quick commands

```bash
npm test                          # run unit tests (Node 20+, no installs needed)
node tools/build_apps_script.mjs  # rebuild backend/apps-script/Bundle.gs + SeedData.gs
node tools/preview_server.mjs     # local preview on FAKE data: http://localhost:8777
```

Project rules for contributors (and AI assistants): see `CLAUDE.md`.
