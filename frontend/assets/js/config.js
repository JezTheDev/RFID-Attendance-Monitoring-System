export const CONFIG = Object.freeze({
  APP_NAME: 'RFID Attendance',
  ORGANIZATION: 'Pampanga State University · Computer Engineering',

  // 'demo' = fake data inside the browser (no server needed)
  // 'live' = real data from the Google Sheet through the Apps Script Web App
  MODE: 'live',

  // Live mode: the Web App URL from Apps Script (Deploy > Manage deployments), ends in /exec
  API_URL: 'https://script.google.com/macros/s/AKfycbywaKk753y64eFmUqpA0ZvcKZJrkSIXol_vFxz9gECwTyO8LkvGYC91FZ2s_d_2pRyh7Q/exec',

  // Live mode: OAuth Web client ID for "Sign in with Google" (leave '' until it is set up)
  GOOGLE_CLIENT_ID: '',

  // Live mode: show "Test as Admin / Instructor / Student" buttons.
  // The server must also have ALLOW_TEST_LOGIN = true. Turn both OFF before real use.
  TEST_LOGIN: true,

  TIMEZONE: 'Asia/Manila',
});
