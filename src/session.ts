import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import * as nanit from './nanit/client.js';
import type { NanitBaby } from './nanit/types.js';

export interface CallerSession {
  /** Nanit access token, taken only from the caller's own sealed bearer token. */
  token: string;
  timezone: string;
  email: string;
}

/** An error whose message is safe and useful to show the model. */
export class ToolError extends Error {}

/** Derive the Nanit session from the verified bearer token; tools never accept one as a parameter. */
export function getNanitSession(authInfo: AuthInfo | undefined, defaultTimezone: string): CallerSession {
  const extra = authInfo?.extra as { nanitToken?: unknown; timezone?: unknown; email?: unknown } | undefined;
  if (!extra || typeof extra.nanitToken !== 'string' || !extra.nanitToken) {
    throw new ToolError('Not signed in. Reconnect the Nanit connector.');
  }
  return {
    token: extra.nanitToken,
    timezone: typeof extra.timezone === 'string' && extra.timezone ? extra.timezone : defaultTimezone,
    email: typeof extra.email === 'string' ? extra.email : '',
  };
}

/** The baby, only if it belongs to the caller's Nanit account. */
export async function authorizeBaby(session: CallerSession, babyUid: string): Promise<NanitBaby> {
  const { babies } = await nanit.getBabies(session.token);
  const baby = babies.find(b => b.uid === babyUid);
  if (!baby) throw new ToolError('No baby with that baby_uid on your Nanit account. Use list_babies to see valid ids.');
  return baby;
}
