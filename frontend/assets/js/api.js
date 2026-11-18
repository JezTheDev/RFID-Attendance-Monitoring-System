import { CONFIG } from './config.js';
import { getSession } from './session.js';

export class ApiError extends Error {
  constructor(code, message, fields = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.fields = fields;
  }
}

export async function callApi(action, payload = {}) {
  const session = getSession();
  const request = { action, session_token: session?.token ?? null, ...payload };

  const response = await sendToServer(request);

  if (!response || response.ok !== true) {
    throw new ApiError(
      response?.error?.code ?? 'UNKNOWN_ERROR',
      response?.error?.message ?? 'The request could not be completed.',
      response?.error?.fields ?? null,
    );
  }
  return response.data;
}

async function sendToServer(request) {
  if (!CONFIG.API_URL) {
    throw new ApiError('API_NOT_CONFIGURED', 'The server address has not been configured yet.');
  }

  let httpResponse;
  try {
    httpResponse = await fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(request),
    });
  } catch {
    throw new ApiError('NETWORK_ERROR', 'Cannot reach the server. Check your internet connection.');
  }

  if (!httpResponse.ok) {
    throw new ApiError('HTTP_ERROR', `The server responded with status ${httpResponse.status}.`);
  }

  try {
    return await httpResponse.json();
  } catch {
    throw new ApiError('BAD_RESPONSE', 'The server returned an invalid response.');
  }
}
