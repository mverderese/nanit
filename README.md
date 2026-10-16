# nanit-mcp

A small, stateless [MCP](https://modelcontextprotocol.io) server that gives Claude **read-only** access to your
[Nanit](https://www.nanit.com) baby monitor's sleep data, plus deterministic sleep scoring. No AI provider,
no video, no audio, no database.

The scoring math (night windows, wake classification, 0-100 score, milestones, regression alerts) is ported
from [mlevitin-create/blair](https://github.com/mlevitin-create/blair), the fork this repo started from. That
fork's web app is gone from this repo; its history and code remain at the link above.

## How it works

- Each user signs in with their **own Nanit account** (including MFA) on this server's sign-in page.
- Every OAuth artifact is an AES-256-GCM sealed token under `TOKEN_SECRET`; the server stores nothing.
- Tools never take a token as a parameter. They derive the Nanit session from the caller's own sealed bearer
  token, and a `baby_uid` is accepted only after confirming it is on that caller's Nanit account.

## Tools (all read-only)

| Tool | What it returns |
|---|---|
| `list_babies` | Babies on the account |
| `get_sleep_score` | Score + breakdown for a night (`date`, or `start`/`end`) |
| `get_sleep_trend` | Per-night scores for the last N nights |
| `get_sleep_days` | Nights + crib naps, wake windows, 24h totals |
| `get_milestones` | Records, streaks, improvements |
| `get_regression_alerts` | Worsening sleep patterns |
| `get_care_events` | Feeds, diaper changes, other non-sleep events |
| `get_sensor_events` | Sound / motion / temperature alerts |

Scoring tools take optional `timezone`, `birthdate` (defaults to Nanit's), `premature_weeks`, `bedtime_hour`
and `wake_hour`. Manual night corrections and stored baby profiles are intentionally not supported: they would
need server-side state.

## Run locally

```bash
npm install
cp .env.example .env   # set TOKEN_SECRET
TOKEN_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))") \
  PUBLIC_BASE_URL=http://127.0.0.1:8000 npm run dev
claude mcp add --transport http nanit http://127.0.0.1:8000/mcp
```

## Deploy (Vercel)

Set `TOKEN_SECRET` (required) and optionally `PUBLIC_BASE_URL` / `DEFAULT_TIMEZONE`. Leave Deployment
Protection off for the production domain so Claude can reach it. Then add `https://<your-domain>/mcp` as a custom
connector in Claude. Rotate secrets by prepending a new one to `TOKEN_SECRET` (comma-separated); removing the
old one signs everyone out.

## Security notes

- The MFA step carries the password through the browser as an AES-GCM sealed blob (5 min TTL, bound to the
  authorization request). It is the most sensitive point; review `src/oauth.ts` (`mfaBlob`).
- Redirect URIs are limited to Claude's callbacks and loopback (`ALLOW_LOOPBACK_REDIRECTS=false` disables loopback).
  PKCE is required, codes live 5 minutes, access tokens 30 minutes.
- Stateless limits: codes can be replayed within their TTL (still needs the PKCE verifier), and there is no
  revocation endpoint because Nanit has no way to revoke a refresh token. Rotating `TOKEN_SECRET` invalidates everything.
- The sign-in page sets `Cache-Control: no-store`, a strict CSP, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`.

## Test

```bash
npm test
```
