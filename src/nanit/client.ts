import type {
  NanitLoginResponse,
  NanitBabiesResponse,
  NanitCalendarResponse,
  NanitMessagesResponse,
} from './types.js';

const baseUrl = 'https://api.nanit.com';
const userAgent = 'Nanit/6.0.0 (iOS; iPhone; Scale/2.00)';
const apiVersion = '1';
const platform = 'unknown';
const serviceVersion = '3.52.0 (882)';

// Tagged error — indicates the user's Nanit token is invalid/expired and should be re-authed
// Login rejected by Nanit, with the HTTP status so callers can tell bad credentials from outages
export class NanitLoginError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'NanitLoginError';
  }
}

export class NanitAuthError extends Error {
  statusCode = 401;
  constructor(message = 'Nanit authentication expired') {
    super(message);
    this.name = 'NanitAuthError';
  }
}

function assertNotAuthError(status: number, context: string): void {
  if (status === 401 || status === 403) {
    throw new NanitAuthError(`${context} failed: ${status}`);
  }
}

function headers(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': userAgent,
    'nanit-api-version': apiVersion,
  };
  if (token) {
    h['Authorization'] = `token ${token}`;
  }
  return h;
}

export async function login(email: string, password: string): Promise<NanitLoginResponse> {
  const res = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ email, password }),
  });

  if (res.status === 482) {
    const data = await res.json();
    return { ...data, _mfa_required: true } as NanitLoginResponse;
  }

  if (!res.ok) {
    throw new NanitLoginError(res.status, `Login failed: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

export async function loginMfa(
  email: string,
  password: string,
  mfaToken: string,
  mfaCode: string,
  channel: string,
): Promise<NanitLoginResponse> {
  const res = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      email,
      password,
      mfa_token: mfaToken,
      mfa_code: mfaCode,
      channel,
    }),
  });

  if (!res.ok) {
    throw new NanitLoginError(res.status, `MFA login failed: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

export async function refreshToken(
  accessToken: string,
  refreshTokenValue: string,
): Promise<NanitLoginResponse> {
  const res = await fetch(`${baseUrl}/tokens/refresh`, {
    method: 'POST',
    headers: headers(accessToken),
    body: JSON.stringify({ refresh_token: refreshTokenValue }),
  });

  if (!res.ok) {
    // Refresh rejections require a new login; rate limiting remains retryable.
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      throw new NanitAuthError(`Token refresh failed: ${res.status}`);
    }
    throw new Error(`Token refresh failed: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

export async function getBabies(token: string): Promise<NanitBabiesResponse> {
  const res = await fetch(`${baseUrl}/babies`, {
    headers: headers(token),
  });

  if (!res.ok) {
    assertNotAuthError(res.status, 'Get babies');
    throw new Error(`Get babies failed: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

export async function getCalendarEvents(
  token: string,
  babyUid: string,
  start: number,
  end: number,
): Promise<NanitCalendarResponse> {
  const url = `${baseUrl}/babies/${babyUid}/calendar?start=${start}&end=${end}`;
  const res = await fetch(url, {
    headers: {
      ...headers(token),
      'X-Nanit-Platform': platform,
      'X-Nanit-Service': serviceVersion,
    },
  });

  if (!res.ok) {
    assertNotAuthError(res.status, 'Get calendar');
    throw new Error(`Get calendar failed: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

export async function getMessages(
  token: string,
  babyUid: string,
  limit: number = 100,
): Promise<NanitMessagesResponse> {
  const url = `${baseUrl}/babies/${babyUid}/messages?limit=${limit}`;
  const res = await fetch(url, {
    headers: headers(token),
  });

  if (!res.ok) {
    assertNotAuthError(res.status, 'Get messages');
    throw new Error(`Get messages failed: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

// Sleep data comes from the calendar endpoint (type: "auto_sleep")
// No separate sleep endpoint exists in the Nanit API.

// Events endpoint - returns events with pre-signed S3 video clip URLs
export async function getEvents(
  token: string,
  babyUid: string,
  limit: number = 50,
): Promise<any> {
  const url = `${baseUrl}/babies/${babyUid}/events?limit=${limit}`;
  const res = await fetch(url, {
    headers: headers(token),
  });

  if (!res.ok) {
    assertNotAuthError(res.status, 'Get events');
    throw new Error(`Get events failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return data;
}
