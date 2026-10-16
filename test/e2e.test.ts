import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import { buildApp } from '../src/app.js';
import { loadSettings } from '../src/config.js';
import { nightWindowFromDateStr, pastNightDates } from '../src/scoring/night-windows.js';
import { tzOffsetMinutes } from '../src/timezone.js';

const TZ = 'America/New_York';
let server: Server;
let base: string;
const realFetch = globalThis.fetch;
const nanitCalls: string[] = [];

const BABY = { uid: 'baby1', id: 1, name: 'Ada', birthdate: '2025-06-01' };
const PASSWORD = 'hunter2-secret';
let nightStart = 0;

function mockNanit(url: string, init?: RequestInit): Response {
  const u = new URL(url);
  nanitCalls.push(`${init?.method ?? 'GET'} ${u.pathname}`);
  const auth = new Headers(init?.headers).get('authorization');
  if (u.pathname === '/login') {
    const b = JSON.parse(String(init!.body));
    if (b.password !== PASSWORD) return new Response('{}', { status: 401 });
    if (!b.mfa_code) return Response.json({ mfa_token: 'mt', channel: 'sms', phone_suffix: '1234' }, { status: 482 });
    if (b.mfa_token !== 'mt' || b.mfa_code !== '123456') return new Response('{}', { status: 401 });
    return Response.json({ access_token: 'nat1', refresh_token: 'nrt1' });
  }
  if (u.pathname === '/tokens/refresh') {
    return Response.json({ access_token: 'nat2', refresh_token: 'nrt2' });
  }
  if (!auth?.startsWith('token nat')) return new Response('{}', { status: 401 });
  if (u.pathname === '/babies') return Response.json({ babies: [BABY] });
  if (u.pathname === '/babies/baby1/calendar') {
    const t = nightStart + 3600;
    return Response.json({ calendar: [
      { uid: 'a', baby_uid: 'baby1', type: 'auto_sleep', begin_ts: t, end_ts: t + 5 * 3600, duration: 5 * 3600, time: t },
      { uid: 'b', baby_uid: 'baby1', type: 'auto_sleep', begin_ts: t + 5 * 3600 + 600, end_ts: t + 11 * 3600, duration: 6 * 3600 - 600, time: t },
      { uid: 'c', baby_uid: 'baby1', type: 'bottle_feed', begin_ts: t, end_ts: t, duration: 0, time: t },
    ] });
  }
  if (u.pathname === '/babies/baby1/events') {
    return Response.json({ events: [
      { uid: 'e1', key: 'WOKE_UP', time: nightStart + 7200, media_urls: { thumbnail: 'https://signed.example/t.png' } },
      { uid: 'e2', key: 'VISIT', time: nightStart + 90000 },
    ] });
  }
  return new Response('{}', { status: 404 });
}

before(async () => {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input?.url ?? input);
    return url.startsWith('https://api.nanit.com') ? mockNanit(url, init) : realFetch(input, init);
  }) as typeof fetch;
  const date = pastNightDates(1, tzOffsetMinutes(TZ))[0];
  nightStart = nightWindowFromDateStr(date, 19, 8, tzOffsetMinutes(TZ)).start;
  // The OAuth issuer URL must equal the address we listen on, so find a free port first
  const secret = randomBytes(32).toString('base64');
  const port = await new Promise<number>(resolve => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const p = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(p));
    });
  });
  base = `http://127.0.0.1:${port}`;
  await new Promise<void>(resolve => {
    server = buildApp(loadSettings({ TOKEN_SECRET: secret, PUBLIC_BASE_URL: base, DEFAULT_TIMEZONE: TZ }))
      .listen(port, '127.0.0.1', resolve as () => void);
  });
});

after(() => { globalThis.fetch = realFetch; server.close(); });

const REDIRECT = 'http://127.0.0.1:9999/callback';
const b64 = (b: Buffer) => b.toString('base64url');

async function register(redirect = REDIRECT) {
  return realFetch(`${base}/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Test', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  });
}

async function authorize(clientId: string, challenge: string) {
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', scope: 'nanit' });
  const r = await realFetch(`${base}/authorize?${q}`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get('location')!);
  assert.equal(loc.pathname, '/login');
  return loc.searchParams.get('req')!;
}

const post = (path: string, body: Record<string, string>) =>
  realFetch(`${base}${path}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });

async function signIn() {
  const reg = await (await register()).json() as any;
  const verifier = b64(randomBytes(32));
  const challenge = b64(createHash('sha256').update(verifier).digest());
  const req = await authorize(reg.client_id, challenge);

  // Step 1: password -> MFA challenge page carrying a sealed blob, not the password
  const step1 = await post('/login', { req, email: 'Mom@Example.com', password: PASSWORD, timezone: TZ });
  assert.equal(step1.status, 200);
  const html = await step1.text();
  assert.match(html, /verification code/i);
  assert.ok(!html.includes(PASSWORD));
  assert.match(step1.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  assert.equal(step1.headers.get('cache-control'), 'no-store');
  const blob = /name=mfa value="([^"]+)"/.exec(html)![1];

  // Wrong code re-renders; right code redirects with a code
  const bad = await post('/login', { req, mfa: blob, mfa_code: '000000', timezone: TZ });
  assert.equal(bad.status, 400);
  const step2 = await post('/login', { req, mfa: blob, mfa_code: '123456', timezone: TZ });
  assert.equal(step2.status, 302);
  const cb = new URL(step2.headers.get('location')!);
  assert.equal(cb.origin + cb.pathname, REDIRECT);
  assert.equal(cb.searchParams.get('state'), 'xyz');

  const tok = await realFetch(`${base}/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: reg.client_id, code: cb.searchParams.get('code')!, code_verifier: verifier, redirect_uri: REDIRECT }),
  });
  assert.equal(tok.status, 200);
  return { reg, req, blob, tokens: await tok.json() as any };
}

let rpcId = 0;
async function rpc(token: string | null, method: string, params: unknown) {
  const r = await realFetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token && { authorization: `Bearer ${token}` }) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  return r;
}
async function callTool(token: string, name: string, args: unknown) {
  const r = await rpc(token, 'tools/call', { name, arguments: args });
  assert.equal(r.status, 200);
  return (await r.json() as any).result;
}

test('rejects redirect URIs outside the allowlist', async () => {
  assert.equal((await register('https://evil.example/cb')).status, 400);
  assert.equal((await register('http://evil.example/cb')).status, 400);
  assert.equal((await register('https://claude.ai/api/mcp/auth_callback')).status, 201);
});

test('full flow: DCR, authorize, MFA sign-in, token, tools, refresh', async () => {
  const { tokens } = await signIn();
  assert.match(tokens.access_token, /^nma_/);
  assert.match(tokens.refresh_token, /^nmr_/);
  assert.ok(!tokens.access_token.includes('nat1'));

  const list = await (await rpc(tokens.access_token, 'tools/list', {})).json() as any;
  const names = list.result.tools.map((t: any) => t.name).sort();
  assert.deepEqual(names, ['get_care_events', 'get_milestones', 'get_raw_events', 'get_regression_alerts', 'get_sensor_events', 'get_sleep_days', 'get_sleep_score', 'get_sleep_trend', 'list_babies']);
  assert.ok(list.result.tools.every((t: any) => t.annotations.readOnlyHint === true));

  const babies = JSON.parse((await callTool(tokens.access_token, 'list_babies', {})).content[0].text);
  assert.deepEqual(babies.babies.map((b: any) => b.baby_uid), ['baby1']);

  const score = await callTool(tokens.access_token, 'get_sleep_score', { baby_uid: 'baby1' });
  assert.ok(!score.isError, score.content?.[0]?.text);
  const parsed = JSON.parse(score.content[0].text);
  assert.equal(parsed.scores.length, 1);
  assert.ok(parsed.scores[0].total_score > 0 && parsed.scores[0].total_score <= 100);
  assert.equal(parsed.scores[0].details.wake_count, 1);

  const care = JSON.parse((await callTool(tokens.access_token, 'get_care_events', { baby_uid: 'baby1', start: pastNightDates(2, 0)[0], end: pastNightDates(1, 0)[0] })).content[0].text);
  assert.deepEqual(care.events.map((e: any) => e.type), ['bottle_feed']);

  const trend = await callTool(tokens.access_token, 'get_sleep_trend', { baby_uid: 'baby1', days: 3 });
  assert.equal(JSON.parse(trend.content[0].text).trend.length, 3);
});

test('get_raw_events returns calendar + state events, strips media URLs, bounds the range', async () => {
  const { tokens } = await signIn();
  const date = pastNightDates(1, tzOffsetMinutes(TZ))[0];
  const res = await callTool(tokens.access_token, 'get_raw_events', { baby_uid: 'baby1', start: nightStart, end: nightStart + 86400 });
  assert.ok(!res.isError, res.content?.[0]?.text);
  const raw = JSON.parse(res.content[0].text);
  assert.equal(raw.calendar.length, 3);
  assert.deepEqual(raw.state_events.map((e: any) => e.key), ['WOKE_UP']); // VISIT is outside the window
  assert.ok(!JSON.stringify(raw).includes('signed.example'));
  const tooLong = await callTool(tokens.access_token, 'get_raw_events', { baby_uid: 'baby1', start: date, end: '2099-01-01' });
  assert.equal(tooLong.isError, true);
});

test('refresh token exchange', async () => {
  const { reg, tokens } = await signIn();
  const r = await realFetch(`${base}/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: reg.client_id, refresh_token: tokens.refresh_token }),
  });
  assert.equal(r.status, 200);
  const next = await r.json() as any;
  assert.ok(nanitCalls.includes('POST /tokens/refresh'));
  const babies = await callTool(next.access_token, 'list_babies', {});
  assert.ok(!babies.isError);
  // A refresh token can't be used as an access token and vice versa
  assert.equal((await rpc(tokens.refresh_token, 'tools/list', {})).status, 401);
});

test('baby_uid not on the account is rejected, not served', async () => {
  const { tokens } = await signIn();
  for (const tool of ['get_sleep_score', 'get_sleep_trend', 'get_sleep_days', 'get_milestones', 'get_regression_alerts', 'get_sensor_events', 'get_raw_events']) {
    const res = await callTool(tokens.access_token, tool, { baby_uid: 'someone-elses-baby', start: '2025-01-01', end: '2025-01-02' });
    assert.equal(res.isError, true, tool);
    assert.match(res.content[0].text, /No baby with that baby_uid/);
  }
  const care = await callTool(tokens.access_token, 'get_care_events', { baby_uid: 'someone-elses-baby', start: '2025-01-01', end: '2025-01-02' });
  assert.equal(care.isError, true);
  assert.ok(!nanitCalls.some(c => c.includes('someone-elses-baby')));
});

test('missing, forged and wrong-type bearer tokens are rejected', async () => {
  assert.equal((await rpc(null, 'tools/list', {})).status, 401);
  assert.equal((await rpc('nma_forged', 'tools/list', {})).status, 401);
  assert.equal((await rpc('garbage', 'tools/list', {})).status, 401);
  const { reg } = await signIn();
  assert.equal((await rpc(reg.client_id, 'tools/list', {})).status, 401);
});

test('a code or MFA blob cannot be reused with a different authorization request or client', async () => {
  const { reg, blob } = await signIn();
  const other = await authorize(reg.client_id, b64(randomBytes(32)));
  const r = await post('/login', { req: other, mfa: blob, mfa_code: '123456', timezone: TZ });
  assert.equal(r.status, 400);
  assert.match(await r.text(), /expired/i);

  // Code issued to client A is useless to client B
  const regB = await (await register()).json() as any;
  const verifier = b64(randomBytes(32));
  const req = await authorize(reg.client_id, b64(createHash('sha256').update(verifier).digest()));
  const s1 = await post('/login', { req, email: 'a@b.c', password: PASSWORD, timezone: TZ });
  const blob2 = /name=mfa value="([^"]+)"/.exec(await s1.text())![1];
  const s2 = await post('/login', { req, mfa: blob2, mfa_code: '123456', timezone: TZ });
  const code = new URL(s2.headers.get('location')!).searchParams.get('code')!;
  const t = await realFetch(`${base}/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: regB.client_id, code, code_verifier: verifier, redirect_uri: REDIRECT }),
  });
  assert.equal(t.status, 400);
});

test('wrong password shows an error without leaking details', async () => {
  const reg = await (await register()).json() as any;
  const req = await authorize(reg.client_id, b64(randomBytes(32)));
  const r = await post('/login', { req, email: 'a@b.c', password: 'nope', timezone: TZ });
  assert.equal(r.status, 400);
  assert.match(await r.text(), /incorrect/i);
  assert.equal((await post('/login', { req: 'nmq_bad', email: 'a@b.c', password: 'x' })).status, 400);
});
