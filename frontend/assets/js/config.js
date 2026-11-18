export const CONFIG = Object.freeze({
  APP_NAME: 'RFID Attendance',
  ORGANIZATION: 'Pampanga State University · Computer Engineering',

  // The Web App URL from Apps Script (Deploy > Manage deployments), ends in /exec
  API_URL: 'https://script.google.com/macros/s/AKfycbywaKk753y64eFmUqpA0ZvcKZJrkSIXol_vFxz9gECwTyO8LkvGYC91FZ2s_d_2pRyh7Q/exec',

  // OAuth Web client ID for "Sign in with Google" (leave '' until it is set up)
  GOOGLE_CLIENT_ID: '',

  // Show "Test as Admin / Instructor / Student" buttons (removed with the new login).
  // The server must also have ALLOW_TEST_LOGIN = true. Turn both OFF before real use.
  TEST_LOGIN: true,

  TIMEZONE: 'Asia/Manila',
});
