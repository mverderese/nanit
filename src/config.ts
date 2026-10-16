export interface Settings {
  baseUrl: string;
  mcpUrl: string;
  tokenSecrets: string[];
  defaultTimezone: string;
  allowLoopbackRedirects: boolean;
}

export function isValidTimezone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  let baseUrl = (env.PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (!baseUrl) {
    // On Vercel: the stable production domain, or the branch's URL on preview deployments
    const host = env.VERCEL_ENV === 'production'
      ? env.VERCEL_PROJECT_PRODUCTION_URL
      : env.VERCEL_BRANCH_URL || env.VERCEL_URL;
    if (host) baseUrl = `https://${host}`;
  }
  if (!baseUrl) throw new Error("Set PUBLIC_BASE_URL to the server's public https URL");

  const tokenSecrets = (env.TOKEN_SECRET ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (tokenSecrets.length === 0) {
    throw new Error(`Set TOKEN_SECRET (generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")`);
  }

  const defaultTimezone = env.DEFAULT_TIMEZONE || 'America/New_York';
  if (!isValidTimezone(defaultTimezone)) throw new Error(`DEFAULT_TIMEZONE "${defaultTimezone}" is not a valid IANA time zone`);

  return {
    baseUrl,
    mcpUrl: `${baseUrl}/mcp`,
    tokenSecrets,
    defaultTimezone,
    allowLoopbackRedirects: (env.ALLOW_LOOPBACK_REDIRECTS ?? 'true').toLowerCase() !== 'false',
  };
}
