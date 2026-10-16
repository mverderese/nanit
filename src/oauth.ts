/**
 * A stateless OAuth 2.1 authorization server where users sign in with their Nanit account.
 *
 * Claude registers itself (DCR) and sends the user to /authorize. We seal the request and
 * redirect to /login. The user enters their Nanit email and password (and an MFA code if
 * Nanit asks for one); we sign in to Nanit once, seal the resulting Nanit tokens into an
 * authorization code, and redirect back to Claude. The token endpoint turns that into:
 *
 * - an access token holding the short-lived Nanit access token (what the tools use), and
 * - a refresh token holding the Nanit refresh token (used to mint new access tokens).
 *
 * The password is never stored. It is held only inside a sealed, 5-minute, request-bound
 * blob during the MFA step so it can round-trip through the browser (see mfaBlob below).
 * Nothing is stored server-side; see sealing.ts.
 *
 * Limits of being stateless: an authorization code can be replayed until it expires
 * (5 minutes, and only together with the PKCE verifier), and an old refresh token keeps
 * working until Nanit stops honoring it. There is no revocation endpoint: Nanit offers
 * no way to revoke a refresh token, so we don't pretend to. Rotating TOKEN_SECRET
 * invalidates every token at once.
 */
import { createHash } from 'node:crypto';
import type { Request, Response, Router } from 'express';
import express from 'express';
import {
  InvalidGrantError, InvalidRequestError, InvalidTokenError, ServerError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import * as nanit from './nanit/client.js';
import { NanitAuthError, NanitLoginError } from './nanit/client.js';
import { isValidTimezone, type Settings } from './config.js';
import { Sealer, fingerprint } from './sealing.js';

export const SCOPE = 'nanit';
const AUTH_REQUEST_TTL = 15 * 60;
const CODE_TTL = 5 * 60;
const MFA_TTL = 5 * 60;
// Nanit's own access token lifetime is about an hour; stay well inside it
const ACCESS_TTL = 30 * 60;
const REFRESH_TTL = 180 * 24 * 60 * 60;

const CLAUDE_CALLBACKS = new Set([
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
]);

/** Only Claude's hosted callback, plus loopback redirects for Claude Code. */
export function redirectUriAllowed(uri: string, allowLoopback: boolean): boolean {
  if (CLAUDE_CALLBACKS.has(uri)) return true;
  let u: URL;
  try { u = new URL(uri); } catch { return false; }
  return allowLoopback && u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

interface NanitSession { access_token: string; refresh_token: string }

function sessionFrom(res: { access_token?: string; refresh_token?: string }): NanitSession {
  if (!res.access_token || !res.refresh_token) throw new Error('Nanit returned no tokens');
  return { access_token: res.access_token, refresh_token: res.refresh_token };
}

export class StatelessOAuthProvider implements OAuthServerProvider {
  readonly sealer: Sealer;

  constructor(private settings: Settings) {
    this.sealer = new Sealer(settings.tokenSecrets);
  }

  // --- Clients ---------------------------------------------------------------------

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async (clientId: string) => {
        const data = this.sealer.open('client', clientId);
        return data ? { ...data.info, client_id: clientId } as OAuthClientInformationFull : undefined;
      },
      registerClient: async client => {
        const uris = (client.redirect_uris ?? []).map(String);
        const bad = uris.filter(u => !redirectUriAllowed(u, this.settings.allowLoopbackRedirects));
        if (uris.length === 0 || bad.length > 0) {
          throw new InvalidRequestError(`Redirect URI not allowed: ${bad.join(', ') || 'none'}`);
        }
        // The registration itself becomes the client id, so no client table is needed
        const { client_id: _ignored, client_id_issued_at, ...info } = client as any;
        return {
          ...info,
          client_id: this.sealer.seal('client', { info }, null),
          client_id_issued_at: client_id_issued_at ?? Math.floor(Date.now() / 1000),
        } as OAuthClientInformationFull;
      },
    };
  }

  // --- Authorization ---------------------------------------------------------------

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const req = this.sealer.seal('authreq', {
      cid: fingerprint(client.client_id),
      client_name: client.client_name || 'An MCP client',
      redirect_uri: params.redirectUri,
      code_challenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes?.length ? params.scopes : [SCOPE],
      resource: params.resource?.href,
    }, AUTH_REQUEST_TTL);
    res.redirect(302, `${this.settings.baseUrl}/login?req=${encodeURIComponent(req)}`);
  }

  private openCode(client: OAuthClientInformationFull, code: string) {
    const data = this.sealer.open('code', code);
    if (!data || data.cid !== fingerprint(client.client_id)) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    return data;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.openCode(client, code).code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string,
  ): Promise<OAuthTokens> {
    const data = this.openCode(client, code);
    if (redirectUri && redirectUri !== data.redirect_uri) throw new InvalidGrantError('redirect_uri mismatch');
    return this.issue(client, data, { access_token: data.nat, refresh_token: data.nrt });
  }

  // --- Refresh ---------------------------------------------------------------------

  async exchangeRefreshToken(
    client: OAuthClientInformationFull, refreshToken: string, scopes?: string[],
  ): Promise<OAuthTokens> {
    const data = this.sealer.open('refresh', refreshToken);
    if (!data || data.cid !== fingerprint(client.client_id)) throw new InvalidGrantError('Invalid refresh token');
    let session: NanitSession;
    try {
      session = sessionFrom(await nanit.refreshToken(data.nat, data.nrt));
    } catch (err) {
      if (err instanceof NanitAuthError) throw new InvalidGrantError('Nanit sign-in expired; reconnect to sign in again');
      throw new ServerError(`Couldn't reach Nanit: ${(err as Error).message}`);
    }
    // Scopes may only narrow
    const granted = scopes?.length ? scopes.filter(s => (data.scopes as string[]).includes(s)) : data.scopes;
    return this.issue(client, { ...data, scopes: granted }, session);
  }

  private issue(client: OAuthClientInformationFull, ctx: Record<string, any>, s: NanitSession): OAuthTokens {
    const common = {
      cid: fingerprint(client.client_id), email: ctx.email, scopes: ctx.scopes, resource: ctx.resource, tz: ctx.tz,
    };
    return {
      access_token: this.sealer.seal('access', { ...common, nat: s.access_token }, ACCESS_TTL),
      token_type: 'Bearer',
      expires_in: ACCESS_TTL,
      refresh_token: this.sealer.seal('refresh', { ...common, nat: s.access_token, nrt: s.refresh_token }, REFRESH_TTL),
      scope: (ctx.scopes as string[]).join(' '),
    };
  }

  // --- Access tokens ---------------------------------------------------------------

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const data = this.sealer.open('access', token);
    if (!data) throw new InvalidTokenError('Invalid or expired access token');
    return {
      token,
      clientId: data.cid,
      scopes: data.scopes,
      expiresAt: data.exp,
      resource: data.resource ? new URL(data.resource) : undefined,
      extra: { email: data.email, nanitToken: data.nat, timezone: data.tz },
    };
  }

  // --- Sign-in page ----------------------------------------------------------------

  loginRouter(): Router {
    const r = express.Router();
    r.use(express.urlencoded({ extended: false, limit: '16kb' }));
    r.get('/login', (req, res) => this.loginGet(req, res));
    r.post('/login', (req, res) => this.loginPost(req, res).catch(() => {
      sendPage(res, 'Something went wrong', '<p>Unexpected error. Go back to Claude and connect again.</p>', 500);
    }));
    return r;
  }

  private expired(res: Response) {
    sendPage(res, 'Sign-in link expired',
      '<p>This sign-in link is invalid or has expired. Go back to Claude and connect again.</p>', 400);
  }

  private loginGet(req: Request, res: Response) {
    const reqToken = String(req.query.req ?? '');
    const pending = this.sealer.open('authreq', reqToken);
    if (!pending) return this.expired(res);
    this.renderCredentials(res, reqToken, pending);
  }

  private async loginPost(req: Request, res: Response) {
    const form = req.body as Record<string, string | undefined>;
    const reqToken = form.req ?? '';
    const pending = this.sealer.open('authreq', reqToken);
    if (!pending) return this.expired(res);

    const tz = (form.timezone ?? '').trim() || this.settings.defaultTimezone;
    if (!isValidTimezone(tz)) {
      const msg = 'Enter a time zone name like America/Chicago or Europe/London.';
      return form.mfa
        ? this.renderMfa(res, reqToken, pending, form.mfa, tz, msg)
        : this.renderCredentials(res, reqToken, pending, form.email ?? '', msg, tz);
    }

    // Step 2: MFA code, with the credentials carried in a sealed blob
    if (form.mfa) return this.mfaStep(res, form, reqToken, pending, tz);

    // Step 1: email + password
    const email = (form.email ?? '').trim();
    const password = form.password ?? '';
    const retry = (msg: string, status = 400) => this.renderCredentials(res, reqToken, pending, email, msg, tz, status);
    if (!email || !password) return retry('Enter your email and password.');

    let result;
    try {
      result = await nanit.login(email, password);
    } catch (err) {
      return retry(...loginFailure(err));
    }
    if ((result as any)._mfa_required) {
      // mfaBlob: the password must survive one browser round trip to step 2. It travels only
      // as AES-GCM ciphertext (5 min TTL), bound to this authorization request and to the
      // Nanit MFA challenge, and is never logged or stored.
      const blob = this.sealer.seal('mfa', {
        rid: fingerprint(reqToken), email, password, mfa_token: result.mfa_token, channel: result.channel,
        phone_suffix: result.phone_suffix,
      }, MFA_TTL);
      return this.renderMfa(res, reqToken, pending, blob, tz);
    }
    try {
      return this.complete(res, pending, email, tz, sessionFrom(result));
    } catch {
      return retry('Nanit returned an unexpected response. Try again in a minute.', 502);
    }
  }

  private async mfaStep(res: Response, form: Record<string, string | undefined>, reqToken: string, pending: any, tz: string) {
    const blobStr = form.mfa!;
    const blob = this.sealer.open('mfa', blobStr);
    if (!blob || blob.rid !== fingerprint(reqToken)) {
      return this.renderCredentials(res, reqToken, pending, '', 'That verification step expired. Sign in again.', tz, 400);
    }
    const code = (form.mfa_code ?? '').replace(/\s+/g, '');
    if (!/^\d{4,10}$/.test(code)) return this.renderMfa(res, reqToken, pending, blobStr, tz, 'Enter the numeric code Nanit sent you.', blob);
    try {
      const result = await nanit.loginMfa(blob.email, blob.password, blob.mfa_token, code, blob.channel);
      return this.complete(res, pending, blob.email, tz, sessionFrom(result));
    } catch (err) {
      const [msg] = loginFailure(err, true);
      return this.renderMfa(res, reqToken, pending, blobStr, tz, msg, blob);
    }
  }

  private complete(res: Response, pending: any, email: string, tz: string, s: NanitSession) {
    const code = this.sealer.seal('code', {
      cid: pending.cid,
      redirect_uri: pending.redirect_uri,
      code_challenge: pending.code_challenge,
      scopes: pending.scopes,
      resource: pending.resource,
      email: email.toLowerCase(),
      nat: s.access_token,
      nrt: s.refresh_token,
      tz,
    }, CODE_TTL);
    const target = new URL(pending.redirect_uri);
    target.searchParams.set('code', code);
    if (pending.state) target.searchParams.set('state', pending.state);
    res.set(SECURITY_HEADERS).redirect(302, target.href);
  }

  private consentBlurb(pending: any): string {
    const host = new URL(pending.redirect_uri).host;
    const loopback = /^(localhost|127\.0\.0\.1)(:|$)/.test(host);
    return `<p><strong>${esc(pending.client_name)}</strong> wants to read your baby's Nanit sleep data and
score it. It can't change anything in your account. You'll be sent back to <strong>${esc(host)}</strong>.</p>
${loopback ? `<p class=warn>This request will send access to a program running on this computer (${esc(host)}).
Only continue if you just connected Claude Code.</p>` : ''}`;
  }

  private renderCredentials(res: Response, req: string, pending: any, email = '', error = '', tz = '', status?: number) {
    const body = `${this.consentBlurb(pending)}
${error ? `<p class=error role=alert>${esc(error)}</p>` : ''}
<form method=post action=/login>
  <input type=hidden name=req value="${esc(req)}">
  <label>Nanit email<input name=email type=email autocomplete=username required value="${esc(email)}"></label>
  <label>Password<input name=password type=password autocomplete=current-password required></label>
  <label>Time zone<input id=tz name=timezone required autocapitalize=off spellcheck=false
    value="${esc(tz || this.settings.defaultTimezone)}"${tz ? ' data-keep' : ''}></label>
  <button type=submit>Sign in and allow</button>
</form>
<script>${TZ_SCRIPT}</script>
<p class=small>Your password is sent to Nanit to sign in and is never stored. If Nanit asks for a
verification code, you'll enter it on the next screen. Dates you give Claude are read in this time zone
unless you say otherwise.</p>`;
    sendPage(res, 'Connect your Nanit', body, status ?? (error ? 400 : 200));
  }

  private renderMfa(res: Response, req: string, pending: any, blobStr: string, tz: string, error = '', blob?: any) {
    const b = blob ?? this.sealer.open('mfa', blobStr);
    const where = b?.phone_suffix ? ` ending in ${esc(String(b.phone_suffix))}` : '';
    const body = `<p>Nanit sent a verification code${where ? ` to your phone${where}` : ''}. Enter it to finish signing in.</p>
${error ? `<p class=error role=alert>${esc(error)}</p>` : ''}
<form method=post action=/login>
  <input type=hidden name=req value="${esc(req)}">
  <input type=hidden name=mfa value="${esc(blobStr)}">
  <input type=hidden name=timezone value="${esc(tz)}">
  <label>Verification code<input name=mfa_code inputmode=numeric autocomplete=one-time-code required autofocus></label>
  <button type=submit>Verify and allow</button>
</form>
<p class=small>This step expires in 5 minutes.</p>`;
    sendPage(res, 'Verify your sign-in', body, error ? 400 : 200);
  }
}

/** [message, status] for a failed Nanit sign-in. Never echoes upstream details. */
function loginFailure(err: unknown, mfa = false): [string, number] {
  if (err instanceof NanitLoginError) {
    if (err.status === 429) return ['Nanit is rate limiting sign-ins. Wait a few minutes and try again.', 429];
    if (err.status >= 500) return ["Couldn't reach Nanit. Try again in a minute.", 502];
    return [mfa ? 'That code is incorrect or expired.' : 'Email or password is incorrect.', 400];
  }
  return ["Couldn't reach Nanit. Try again in a minute.", 502];
}

// Prefills the time zone field from the browser, unless the user already typed one
const TZ_SCRIPT = "const f=document.getElementById('tz');" +
  "if(f&&!f.hasAttribute('data-keep')){try{f.value=Intl.DateTimeFormat().resolvedOptions().timeZone||f.value}catch(e){}}";
const TZ_SCRIPT_HASH = createHash('sha256').update(TZ_SCRIPT).digest('base64');

const SECURITY_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  // form-action also governs the redirect after sign-in, to Claude or a Claude Code loopback port
  'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${TZ_SCRIPT_HASH}'; ` +
    "form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'",
  'Referrer-Policy': 'no-referrer',
};

const CSS = `
  :root { color-scheme: light dark; --fg:#1d1d1f; --bg:#f5f5f7; --card:#fff; --muted:#6e6e73; --accent:#0a66c2; }
  @media (prefers-color-scheme: dark) { :root { --fg:#f5f5f7; --bg:#111; --card:#1c1c1e; --muted:#a1a1a6; --accent:#4c9ee8; } }
  body { margin:0; font:16px/1.5 system-ui,-apple-system,sans-serif; color:var(--fg); background:var(--bg); }
  main { max-width:420px; margin:8vh auto; padding:24px; background:var(--card); border-radius:16px; }
  h1 { font-size:1.4rem; margin-top:0; }
  label { display:block; margin:14px 0; font-weight:600; }
  input { display:block; width:100%; box-sizing:border-box; margin-top:6px; padding:12px; font:inherit;
          border:1px solid var(--muted); border-radius:10px; background:transparent; color:inherit; }
  button { width:100%; padding:12px; font:inherit; font-weight:600; color:#fff; background:var(--accent);
           border:0; border-radius:10px; cursor:pointer; }
  .error { color:#d70015; } .warn { color:#b25000; } .small { color:var(--muted); font-size:.85rem; }
  @media (max-width:480px) { main { margin:0; border-radius:0; min-height:100vh; padding:16px; } }`;

export function sendPage(res: Response, title: string, body: string, status = 200) {
  res.status(status).set(SECURITY_HEADERS).type('html').send(`<!doctype html>
<html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><main><h1>${esc(title)}</h1>${body}</main></body></html>`);
}

export function infoPage(res: Response, settings: Settings) {
  sendPage(res, 'Nanit MCP server', `<p>This is a read-only Model Context Protocol server for Nanit sleep data and sleep scoring.</p>
<p>To use it, add <code>${esc(settings.mcpUrl)}</code> as a custom connector in Claude
(Settings → Connectors → Add custom connector), then sign in with your Nanit account.</p>`);
}
