# PROJECT CONTEXT
## IoT-Based RFID Attendance Monitoring System

> Converted from `PROJECT CONTEXT.pdf` (primary requirements document).
> Newer team decisions in `CLAUDE.md` override this document where they conflict
> (e.g., password login instead of Google Sign-In, no demo mode).

## 1. Project Overview

- **Project Title:** IoT-Based RFID Attendance Monitoring System
- **Institution:** Pampanga State University (formerly Don Honorio Ventura State University)
- **Department:** Computer Engineering
- **Course:** ELECTIVE 1 – CpE Professional Elective 1
- **Project Type:** Hardware and Software Integration / IoT-Based System

**Project Goal:** Develop a functional, web-based RFID attendance monitoring application integrated with an ESP32 microcontroller. The system will allow students to record attendance by tapping their RFID cards. Attendance records will be timestamped, synchronized with an online database, and displayed through a web application.

This project is intended not only for final project demonstration but also as a foundation for an application that can potentially be used in actual classrooms and expanded in the future.

## 2. Project Background

The Computer Engineering Department currently uses traditional attendance methods such as manual roll calls and paper-based attendance sheets. These methods can be time-consuming, prone to human error, and inconvenient when managing large numbers of students.

The proposed solution uses RFID technology to automate attendance recording, reduce manual work, and provide accessible attendance records.

## 3. Project Objectives

1. Read student RFID cards using an MFRC522 reader connected to an ESP32.
2. Validate RFID UIDs against registered student records.
3. Automatically record attendance with accurate timestamps.
4. Synchronize attendance records with an online database using Wi-Fi.
5. Provide a web-based attendance dashboard.
6. Support offline attendance buffering and automatic synchronization when connectivity returns.
7. Monitor the battery status of the device.

## 4. Hardware Components

| Component | Purpose |
|---|---|
| ESP32 | Main microcontroller and Wi-Fi communication |
| MFRC522 | RFID card reader |
| RFID Cards | Student identification |
| LCD1602 with I2C | Displays scan results |
| Red and Green LEDs | Scan status indicators |
| Active Buzzer | Audio feedback |
| 2N2222 Transistor | Buzzer driver |
| Two 18650 Li-ion batteries | Power supply |
| TP4056 charging module | Battery charging and protection |
| MT3608 boost converter | Boosts battery voltage to 5V |
| Voltage divider | Battery voltage monitoring |

The two 18650 cells are planned to be connected in parallel (2P), with an estimated combined nominal capacity of 4000 mAh.

## 5. Hardware Workflow

1. Student taps an RFID card.
2. MFRC522 reads the card's UID.
3. ESP32 receives the UID.
4. ESP32 checks whether the UID is registered.
5. ESP32 checks whether the scan is a duplicate.
6. ESP32 generates a timestamped attendance record.
7. ESP32 sends the attendance data through Wi-Fi.
8. Google Apps Script receives the data.
9. The attendance record is saved in Google Sheets.
10. The web application displays the attendance record.

When the internet is unavailable, the ESP32 should temporarily store pending attendance records and synchronize them after reconnection.

## 6. Required System Features

Basic features (from the project proposal):
- RFID-based attendance recording.
- Online database synchronization.
- Accurate timestamping.
- Web-based attendance dashboard.
- Rechargeable battery operation.

Additional features:
- Offline buffering and automatic synchronization.
- LED and buzzer feedback.
- Low-battery monitoring with dashboard alerts.
- Duplicate-scan prevention.

Expected scan feedback:

| Scan Result | LED | Buzzer |
|---|---|---|
| Accepted | Green | One short beep |
| Duplicate | No special LED required | Two short beeps |
| Unregistered | Red | One long beep |

The final behavior should be coordinated with the hardware team's actual implementation.

## 7. Software Development Direction

The main software deliverable is a web-based application called the RFID Attendance Management System. The application should be:
- Responsive on desktop, tablets, and mobile browsers.
- Easy to use for students and instructors.
- Organized and maintainable.
- Designed for future expansion.
- Connected to actual ESP32 attendance records.
- Hosted using free services as much as possible.

This must be a functional application, not merely a static dashboard or a UI prototype.

## 8. Intended Application Users

The primary end-users are students, but the system also requires administrative users to manage attendance operations.

**Admin**
- Manage student accounts.
- Register and assign RFID UIDs.
- Manage instructors.
- Manage courses and sections.
- View all attendance records.
- Generate reports.
- Monitor device status.
- Manage application settings.

**Instructor**
- View assigned classes and sections.
- Monitor student attendance.
- View class attendance history.
- Filter attendance by date.
- Generate and export class reports.

**Student**
- Log in to their personal account.
- View their attendance summary.
- View personal attendance history.
- Check scan dates and timestamps.
- Filter their records by date.
- View their registered student information.

Students must not be allowed to edit their own attendance records or access other students' private records.

## 9. Proposed Dashboard Modules

**A. Admin Dashboard**
- Total registered students.
- Total instructors.
- Present students today.
- Attendance statistics.
- Student management.
- Instructor management.
- Course and section management.
- Attendance management.
- Reports.
- Device monitoring.

**B. Instructor Dashboard**
- Assigned classes.
- Total students per section.
- Present and absent counts.
- Recent attendance activity.
- Attendance history.
- Report generation.

**C. Student Portal**
- Personal attendance overview.
- Attendance percentage.
- Attendance history.
- Date and time of each scan.
- Personal profile.

## 10. Proposed Technology Stack

The initial technology stack should prioritize zero additional software expenses.

- **Frontend:** HTML, CSS, JavaScript, Bootstrap
- **Initial Backend/API:** Google Apps Script
- **Initial Database:** Google Sheets
- **Hosting:** GitHub Pages
- **Hardware Programming:** Arduino IDE, ESP32 Arduino Core, WiFi.h, MFRC522 library, HTTPClient.h, LiquidCrystal_I2C
- **IoT Communication:** HTTP requests between ESP32 and Google Apps Script.
- **Online Data Storage:** Google Sheets, accessed through Google Apps Script.

Firebase Authentication and Firestore may be evaluated as a future upgrade if the application requires stronger authentication, database security rules, and more scalable data handling.

Do not introduce paid services unless explicitly approved.

## 11. Proposed Software Architecture

```
ESP32 + MFRC522
      ↓
Wi-Fi / HTTP Request
      ↓
Google Apps Script API
      ↓
Google Sheets
      ↓
Web Application
      ↓
Admin / Instructor / Student Portals
```

- The frontend must not directly expose sensitive database information.
- All access to student information and attendance records must go through an appropriately secured backend.
- The system must validate user identity and permissions before providing private information.
- The ESP32 should use a separate device communication mechanism rather than using student-facing login credentials.

## 12. Initial Database Structure

The proposed Google Sheets database will contain these worksheets:

- **Users:** user_id, email, password/authentication reference, role, account_status
- **Students:** student_id, rfid_uid, first_name, last_name, course, section, email, account_status
- **Instructors:** instructor_id, name, email, account_status
- **Courses:** course_id, course_name
- **Sections:** section_id, course_id, section_name, instructor_id
- **Attendance:** attendance_id, student_uid, student_id, student_name, date, timestamp, device_id, sync_status
- **Devices:** device_id, device_name, battery_voltage, wifi_status, last_updated

The database structure is preliminary. Review and improve it before implementation.

In particular, attendance should eventually support class schedules and attendance sessions so the system can distinguish attendance for different classes and avoid incorrectly treating a student's scan as a universal daily attendance record.

## 13. Important System Logic

**RFID Validation**
- Read the UID from the RFID card.
- Check if it exists in the registered student database.
- Reject unregistered cards.
- Return the appropriate scan result.

**Duplicate Prevention**
- Prevent accidental repeated scans.
- The proposal initially specifies a five-minute duplicate window.
- The duplicate rule should be configurable.

**Timestamping**
- Synchronize the ESP32 clock through an NTP server.
- Record the appropriate date and time.
- Use a consistent timezone, preferably Asia/Manila for display.

**Offline Synchronization**
- Save records locally in ESP32 flash storage when uploading fails.
- Retry uploads after Wi-Fi reconnects.
- Remove buffered records only after successful server confirmation.
- Prevent duplicate records during synchronization.

**Dashboard Updates**
- Display real attendance data.
- Show device status and battery readings.
- Clearly distinguish pending offline records from successfully synchronized records.

## 14. Security and Privacy Requirements

The application may eventually contain real student information. Security must be considered from the beginning.

- Role-based access control.
- Secure authentication.
- Passwords must never be stored in plaintext.
- Students can only access their own records.
- Instructors can only access their assigned classes.
- Admin functions must be protected.
- Never expose secret API credentials in frontend JavaScript.
- Validate incoming ESP32 requests.
- Protect against unauthorized attendance submissions.
- Validate and sanitize user inputs.
- Avoid exposing the complete Google Sheets database publicly.
- Use test data during development.
- Obtain appropriate school approval before processing real student information.

RFID UIDs alone should not be treated as strong proof of identity because cards can potentially be copied or emulated.

## 15. Five-Week Implementation Timeline

**Week 1 – Planning and Circuit Simulation**
- Hardware: identify objectives and required components; prepare schematic diagram; simulate circuit; review and improve the design.
- Software: finalize application requirements; design dashboard wireframes; plan database structure; prepare initial frontend UI; plan API communication.

**Week 2 – Ordering Components and Breadboarding**
- Hardware: order components; assemble breadboard circuit; connect RFID reader and ESP32; upload initial firmware; test RFID card detection.
- Software: set up Google Sheets; develop initial Google Apps Script API; create basic frontend pages; implement sample student and attendance records; prepare ESP32 request format.

**Week 3 – PCB Design and Ordering**
- Hardware: finalize PCB layout; submit PCB for printing.
- Software: connect ESP32 with Google Apps Script; receive RFID UIDs; process and store attendance; display actual attendance records; test communication and timestamps.

**Week 4 – PCB Assembly and Enclosure Fabrication**
- Hardware: solder and assemble PCB; design and print enclosure; integrate components.
- Software: complete student portal; complete admin and instructor modules; add reports and dashboard statistics; add battery and device monitoring; integrate with actual hardware.

**Week 5 – Final Testing and Evaluation**
- Test RFID recognition.
- Test registered and unregistered cards.
- Test duplicate-scan prevention.
- Test offline buffering and synchronization.
- Test dashboard data accuracy.
- Perform stress testing.
- Fix bugs.
- Finalize deployment and documentation.

## 16. Development Preferences and Working Rules

1. Act as a senior software developer, system architect, and technical mentor.
2. Guide development step by step.
3. Explain technical decisions in understandable language.
4. Avoid unnecessary refactoring.
5. Do not replace working features without a valid reason.
6. Preserve existing UI and functionality when modifying the code.
7. Inspect the existing project before making changes.
8. Do not assume that files, APIs, or database structures exist without checking.
9. Avoid implementing too many features at once.
10. Prioritize a functional minimum viable product before advanced features.
11. Provide complete code changes when requested.
12. Clearly identify which files need modification.
13. Test and verify changes where possible.
14. Consider desktop and mobile responsiveness.
15. Prioritize free and sustainable solutions.
16. Never claim that an integration works unless it has actually been tested.
17. Ask before introducing a new framework, paid service, or major architectural change.
18. Keep a record of completed features, pending work, known bugs, and architectural decisions.

When working with an existing repository, inspect its folder structure and relevant files before suggesting changes. Do not blindly generate a new project that conflicts with existing work.

## 17. Expected Final Output

- A working ESP32 RFID attendance device.
- A functional online attendance database.
- A responsive web application.
- An admin portal.
- An instructor portal.
- A student portal.
- Automatic RFID attendance recording.
- Attendance history and reports.
- Offline synchronization.
- Device monitoring.
- A deployed application accessible through a web browser.

The system should be developed with future expansion in mind, even if the initial implementation has limitations due to the five-week development period and zero additional software budget.

## 18. Important Notes for the AI Assistant

This is an ongoing academic engineering project. The user is particularly responsible for software planning and development.

Do not restart the planning process from scratch. Use this document as the initial project context.

The actual implementation details may change depending on hardware testing, available components, project progress, and instructor feedback.

Always distinguish between:
- Features already implemented.
- Features currently being developed.
- Features only planned or proposed.

Do not treat proposed features as completed features.

When a technical decision has multiple possible approaches, explain the trade-offs and recommend a practical solution that fits the project timeline, budget, and team capabilities.