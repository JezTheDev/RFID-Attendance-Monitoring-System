# Stage 2: device.getRoster v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** getRoster returns cards + 48 h of tap windows for the device's room, versioned by a content hash.

**Architecture:** Move resolveScan's per-date slot lookup into `roomSlots()` (sessions.js) and the enrolled_at check into `joinedAfter()` (portal.js); getRoster (handlers/device.js) builds windows from them.

**Tech Stack:** Node ES modules, node:test, Apps Script (Bundle.gs generated).

**Spec:** `docs/superpowers/specs/2026-11-27-stage2-offline-design.md`

## Global Constraints

- Bundle.gs ES2020; no npm deps; all Sheet cells plain text; Asia/Manila.
- No schema change. Never print/commit secrets. Do not touch DEV-RM301-01 / RM301 / CEA101 / admin.test.
- Do not change submitScans behaviour or speed.

## Review Focus

- Window across midnight / 48 h edge: a slot on day 3 that starts before now+48h is included → test "includes a window that starts before now+48h on the third date".
- Window already in progress at `now` (start < now < end) is included → covered in the 15-min test (now = 08:10).
- Manual session in the room → listed as a window (manual and cancelled manual) → test.
- Inactive student with an active card is not in `cards` or `uids` → revoked/inactive test.
- No active term on a date → no windows that date → test.

---

### Task 1: extract `roomSlots` (refactor, resolveScan unchanged)

**Files:** Modify `backend/src/sessions.js`; Test: existing `backend/tests/sessions.test.js`, `live-test.test.js`, `submit-scans.test.js`.

**Produces:** `roomSlots(db, roomId, date) -> null | { manual: Slot[], scheduled: Slot[] }`, `Slot = { classId, start:'HH:mm', end:'HH:mm', session?, schedule? }`. `null` = no active term on `date`. `manual` includes cancelled manual sessions.

- [ ] Implement; resolveScan filters `manual` by not-cancelled + covers, `scheduled` by covers (same order as today).
- [ ] `npm test`: all existing tests pass unchanged.

### Task 2: `joinedAfter` (refactor)

**Files:** Modify `backend/src/handlers/portal.js` (statusFor uses it). **Produces:** `joinedAfter(db, classId, studentId, date, endHHmm) -> boolean`.

- [ ] Implement; `npm test` passes unchanged.

### Task 3: getRoster v2 (TDD)

**Files:** Modify `backend/src/handlers/device.js`, `backend/src/actions.js` (reads add `Terms Classes Schedules ClassSessions Enrollments`, writes `Devices`); Test: `backend/tests/heartbeat-roster.test.js` (rewrite getRoster block), `backend/tests/server-gs.test.js` (getRoster now locks, writes 1 Devices row).

Tests (fixture: device in RM-0001, NOW Mon 2026-11-23 08:10 Manila, CLS-0001 MON 08:00-10:00 in RM-0001):
- `room filtering`: windows only for RM-0001 (CLS-0002 is RM-0002) → labels `['CPE301 3A']` within 48 h.
- `start = start-15min`: `windows[0].start === Date.parse('2026-11-23T07:45:00+08:00')/1000`, `end === …T10:00…`.
- `cancelled flag`: a cancelled ClassSession for the slot → `cancelled:true`, still listed.
- `enrolled_at`: student enrolled at 09:00 today is in `uids`; one with enrolled_at after the window end is not.
- `revoked cards excluded`: from `cards` and `uids`; inactive students too.
- `version`: two calls without changes → same; changing a schedule time, an enrollment, a cancellation, a card, a setting → different; time moving 1 min (no window drops) → same.
- `changed:false`: `known_version` = current → `{changed:false, roster_version}` only.
- `bad key` → `INVALID_DEVICE_KEY`.
- `back-to-back`: CLS-0003 MON 10:00-12:00 in RM-0001 → two windows, second starts 09:45 (< first end 10:00).
- `manual session` listed; `no active term` → no windows; 48 h edge.
- stores `firmware_version`, `queue_count`, `last_seen_at`; bad values ignored.

- [ ] Write tests, see them fail; implement; pass; `node tools/build_apps_script.mjs`; `npm test`.

### Task 4: timing log (A2) + docs + ship

- [ ] Server.gs: one `console.log` per device.* request with lock/load/run/save ms (no behaviour change).
- [ ] Device_API_Spec 6.3 → v0.3; CLAUDE.md getRoster bullet; PAPER_SYSTEM_LOGIC getRoster line.
- [ ] `npm test`, build, commit, push main + `main:backend-work`.
- [ ] After Dan deploys: live getRoster (counts + ms), live submitScans timing from Executions log.
