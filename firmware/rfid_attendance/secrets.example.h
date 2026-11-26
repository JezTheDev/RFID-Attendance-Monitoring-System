// Copy this file to secrets.h (same folder) and fill in your values.
// secrets.h is in .gitignore — NEVER commit it.

#pragma once

// First-boot default only. After that, Wi-Fi is set from a phone (setup mode).
#define WIFI_SSID   "your-wifi-name"
#define WIFI_PASS   "your-wifi-password"

// Apps Script Web App URL, ends with /exec
#define API_URL     "https://script.google.com/macros/s/XXXXXXXX/exec"

// From the admin Devices page
#define DEVICE_ID   "DEV-RM301-01"
#define DEVICE_KEY  "paste-the-64-character-device-key-here"

// Admin setup card: tapping it opens Wi-Fi setup mode. Must NOT be assigned to a student.
#define SETUP_CARD_UID  "AABBCCDD"
// Password of the setup hotspot (at least 8 characters)
#define SETUP_AP_PASS   "change-me-8-chars"
