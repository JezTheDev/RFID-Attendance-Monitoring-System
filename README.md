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
| `tools/` | `build_apps_script.mjs` (builds Bundle.gs/SeedData.gs), `xlsx_to_seed_data.py` |
| `docs/` | Architecture, Device API spec, audit report, fake test-data workbook |

## Status (2026-11-18)

| Part | Status |
|---|---|
| Backend (Apps Script): router, sessions, role + ownership checks, LockService | Done |
| Admin portal: dashboard, students & RFID cards, instructors, admins, classes/schedules/enrollments, academic setup | Done |
| Instructor portal: dashboard, sessions, attendance corrections, roster, reports + CSV | Done |
| Student portal: overview, history, profile | Done |
| Unit tests for the business logic (`npm test`) | Done |
| Login: admin-created username/password accounts | Done (backend + basic login page): lockout, forced first-login password change, admin reset/unlock actions. Login page polish, Settings page and admin reset/unlock buttons are next |
| Device API (`device.submitScans`, heartbeat, roster) + session engine | Not started |
| Firmware | Not in this repository yet |

There is **no demo mode** and **no Google Sign-In**: the website always talks
to the live Apps Script backend. Fake data is only for a TEST Google Sheet.

## Quick commands

```bash
npm test                          # run unit tests (Node 20+, no installs needed)
node tools/build_apps_script.mjs  # rebuild backend/apps-script/Bundle.gs + SeedData.gs
```

Project rules for contributors (and AI assistants): see `CLAUDE.md`.
