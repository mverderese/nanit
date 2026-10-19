import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import * as nanit from './nanit/client.js';
import { NanitAuthError } from './nanit/client.js';
import { authorizeBaby, getNanitSession, ToolError, type CallerSession } from './session.js';
import { tzOffsetMinutes } from './timezone.js';
import { isValidTimezone } from './config.js';
import { applyAnnotation, getAdjustedAgeMonths, pickMainNight, scoreNight } from './scoring/sleep-scorer.js';
import { getNightsForWindow, loadScoredNights, toHistoryPoint } from './scoring/night-history.js';
import { getWindowActivity } from './scoring/night-activity.js';
import { localDateStr, localToUnix, nightWindowFromDateStr, pastNightDates } from './scoring/night-windows.js';
import { loadDays, napExpectations, summarizeDays } from './scoring/daytime.js';
import { detectMilestones, toHistoryNights } from './scoring/milestones.js';
import { detectRegressions } from './scoring/regression-detector.js';

const babyUid = z.string().min(1).max(64).describe('Baby id from list_babies');
const timezone = z.string().max(64).optional()
  .describe('IANA time zone for night windows, e.g. America/Chicago. Defaults to the zone chosen at sign-in.');
const birthdate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
  .describe("YYYY-MM-DD. Defaults to the baby's birthdate in Nanit.");
const prematureWeeks = z.number().int().min(0).max(20).optional()
  .describe('Weeks born early, to use adjusted age. Default 0.');
const bedtimeHour = z.number().int().min(0).max(23).optional().describe('Usual bedtime hour (0-23), default 19.');
const wakeHour = z.number().int().min(0).max(23).optional().describe('Usual wake hour (0-23), default 8.');
const when = z.union([z.string().max(40), z.number()]);

const scoring = { baby_uid: babyUid, timezone, birthdate, premature_weeks: prematureWeeks, bedtime_hour: bedtimeHour, wake_hour: wakeHour };

// Observed 2026-10-19: /messages returns at most 50 items whatever the limit (500 /events reach about a week).
// No paging parameter is known for either endpoint, and no open-source Nanit client pages them, so these are the real reach.
const MESSAGES_MAX = 50;
const EVENTS_MAX = 500;

/** Camera state event fields get_raw_events passes through; everything else (signed video links etc.) is dropped. */
const STATE_EVENT_FIELDS = ['uid', 'key', 'title', 'time', 'begin_ts', 'end_ts', 'duration', 'last_state_duration', 'confidence', 'source', 'camera_uid', 'created_at'];

/** Shallow copy of a calendar entry without any field whose value is (or contains) a link. */
function dropUrls<T extends object>(entry: T): T {
  return Object.fromEntries(Object.entries(entry).filter(([, v]) => !/https?:\/\//i.test(JSON.stringify(v) ?? ''))) as T;
}

interface Ctx {
  session: CallerSession;
  tzOffset: number;
  baby: Awaited<ReturnType<typeof authorizeBaby>>;
}
type ScoringArgs = { baby_uid: string; timezone?: string; birthdate?: string; premature_weeks?: number; bedtime_hour?: number; wake_hour?: number };

/** Parse a unix-seconds number/string, a YYYY-MM-DD date (local midnight; end = next midnight), or an ISO datetime. */
export function parseWhen(v: string | number, tzOffset: number, edge: 'start' | 'end'): number {
  if (typeof v === 'number') return Math.floor(v);
  const s = v.trim();
  if (/^\d{9,11}$/.test(s)) return Number(s);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return localToUnix(+m[1], +m[2] - 1, +m[3] + (edge === 'end' ? 1 : 0), 0, tzOffset);
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new ToolError(`Can't read "${v}" as a date. Use YYYY-MM-DD, an ISO datetime, or unix seconds.`);
  return Math.floor(t / 1000);
}

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function fail(err: unknown): CallToolResult {
  let msg: string;
  if (err instanceof ToolError) msg = err.message;
  else if (err instanceof NanitAuthError) msg = 'Nanit rejected the saved sign-in. Disconnect and reconnect the Nanit connector.';
  else msg = 'Nanit request failed. Try again in a minute.';
  if (!(err instanceof ToolError) && !(err instanceof NanitAuthError)) console.error('[tool] error:', (err as Error)?.message);
  return { isError: true, content: [{ type: 'text', text: msg }] };
}

export function createMcpServer(defaultTimezone: string): McpServer {
  const server = new McpServer({ name: 'nanit', version: '0.1.0' });
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

  function tool<S extends z.ZodRawShape>(
    name: string, description: string, shape: S,
    run: (args: z.infer<z.ZodObject<S>>, c: Ctx) => Promise<unknown>,
  ) {
    server.registerTool(name, { description, inputSchema: shape, annotations }, (async (args: any, extra: any) => {
      try {
        const session = getNanitSession(extra.authInfo, defaultTimezone);
        const tz = (args as { timezone?: string }).timezone ?? session.timezone;
        if (!isValidTimezone(tz)) throw new ToolError(`"${tz}" is not a valid IANA time zone.`);
        const baby = await authorizeBaby(session, args.baby_uid);
        return ok(await run(args, { session, tzOffset: tzOffsetMinutes(tz), baby }));
      } catch (err) {
        return fail(err);
      }
    }) as any);
  }

  const rangeParams = (a: ScoringArgs, c: Ctx, days: number) => ({
    token: c.session.token,
    babyUid: a.baby_uid,
    days,
    birthdate: a.birthdate ?? c.baby.birthdate,
    prematureWeeks: a.premature_weeks ?? 0,
    bedtimeHour: a.bedtime_hour ?? 19,
    wakeHour: a.wake_hour ?? 8,
    tzOffset: c.tzOffset,
  });

  // list_babies has no baby_uid, so it can't go through tool()
  server.registerTool('list_babies', {
    description: 'List the babies on the signed-in Nanit account (id, name, birthdate).',
    inputSchema: {}, annotations,
  }, async (_args, extra) => {
    try {
      const session = getNanitSession(extra.authInfo, defaultTimezone);
      const { babies } = await nanit.getBabies(session.token);
      return ok({ babies: babies.map(b => ({ baby_uid: b.uid, name: b.name, birthdate: b.birthdate, due_date: b.due_date })) });
    } catch (err) {
      return fail(err);
    }
  });

  tool('get_sleep_score',
    "Score a night of sleep (0-100) with duration, continuity, longest-stretch and timing sub-scores, wake list (self-settled vs parent visit) and age expectations. Give `date` (the evening the night started, YYYY-MM-DD; default last night) or an explicit `start`/`end`.",
    { ...scoring, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), start: when.optional(), end: when.optional() },
    async (a, c) => {
      let start: number, end: number, date: string;
      const p = rangeParams(a, c, 1);
      if (a.start !== undefined || a.end !== undefined) {
        if (a.start === undefined || a.end === undefined) throw new ToolError('Give both start and end.');
        start = parseWhen(a.start, c.tzOffset, 'start');
        end = parseWhen(a.end, c.tzOffset, 'end');
        if (end <= start || end - start > 3 * 86400) throw new ToolError('end must be after start, within 3 days.');
        date = localDateStr(start, c.tzOffset);
      } else {
        date = a.date ?? pastNightDates(1, c.tzOffset)[0];
        ({ start, end } = nightWindowFromDateStr(date, p.bedtimeHour, p.wakeHour, c.tzOffset));
      }
      const [nights, activity] = await Promise.all([
        getNightsForWindow(c.session.token, a.baby_uid, start, end),
        getWindowActivity(c.session.token, a.baby_uid, start, end),
      ]);
      if (nights.length === 0) return { date, scores: [], note: 'No sleep data in that window.' };
      const main = pickMainNight(nights);
      const scores = nights.map(raw => {
        const night = applyAnnotation(raw, null);
        return {
          is_main: raw === main,
          ...scoreNight(raw, { birthdate: p.birthdate, prematureWeeks: p.prematureWeeks, tzOffset: c.tzOffset, bedtimeHour: p.bedtimeHour, activity }),
          night_start: night.night_start,
          night_end: night.night_end,
          segment_count: night.sleep_segments.length,
        };
      });
      return { date, adjusted_age_months: Math.round(getAdjustedAgeMonths(p.birthdate, p.prematureWeeks) * 10) / 10, scores };
    });

  tool('get_sleep_trend', 'Nightly sleep score and key stats for the last N completed nights (default 7), oldest first; nights with no data are null.',
    { ...scoring, days: z.number().int().min(1).max(60).optional() },
    async (a, c) => {
      const p = rangeParams(a, c, a.days ?? 7);
      const byDate = new Map((await loadScoredNights(p)).map(n => [n.date, toHistoryPoint(n)]));
      return { trend: pastNightDates(p.days, c.tzOffset).map(d => byDate.get(d) ?? { date: d, score: null, total_sleep_minutes: null }) };
    });

  tool('get_sleep_days', 'Whole days of crib sleep (night plus naps) with nap counts, wake windows, 24h totals and age-based expectations. Last N days including today (default 14). Only crib naps are visible.',
    { ...scoring, days: z.number().int().min(1).max(31).optional() },
    async (a, c) => {
      const p = rangeParams(a, c, a.days ?? 14);
      const dates = [...pastNightDates(p.days - 1, c.tzOffset), localDateStr(Date.now() / 1000, c.tzOffset)];
      const adj = getAdjustedAgeMonths(p.birthdate, p.prematureWeeks);
      const expectations = napExpectations(adj);
      const result = await loadDays(p, dates, expectations);
      return { ...result, summary: summarizeDays(result.days), expectations: { adjusted_age_months: Math.round(adj * 10) / 10, ...expectations } };
    });

  tool('get_milestones', 'Sleep achievements (records, streaks, big improvements) across the last N nights (default 14).',
    { ...scoring, days: z.number().int().min(1).max(60).optional() },
    async (a, c) => {
      const p = rangeParams(a, c, a.days ?? 14);
      const history = (await loadScoredNights(p)).map(toHistoryPoint);
      return { milestones: detectMilestones(toHistoryNights(history), c.tzOffset), nights_analyzed: history.length };
    });

  tool('get_regression_alerts', 'Detect worsening sleep patterns (declining scores, more wakes, shorter stretches, drifting bedtime) over the last N nights (default 10).',
    { ...scoring, days: z.number().int().min(3).max(60).optional() },
    async (a, c) => {
      const p = rangeParams(a, c, a.days ?? 10);
      const history = (await loadScoredNights(p)).map(toHistoryPoint);
      return { alerts: detectRegressions(history, c.tzOffset), nights_analyzed: history.length };
    });

  tool('get_care_events', 'Non-sleep events logged in Nanit (feeds, diaper changes, etc.) between `start` and `end` (YYYY-MM-DD, ISO datetime, or unix seconds; max 31 days).',
    { baby_uid: babyUid, timezone, start: when, end: when },
    async (a, c) => {
      const start = parseWhen(a.start, c.tzOffset, 'start');
      const end = parseWhen(a.end, c.tzOffset, 'end');
      if (end <= start || end - start > 31 * 86400) throw new ToolError('end must be after start, within 31 days.');
      const { calendar } = await nanit.getCalendarEvents(c.session.token, a.baby_uid, start, end);
      const events = calendar.filter(e => e.type !== 'auto_sleep');
      return { events, all_types: [...new Set(calendar.map(e => e.type))] };
    });

  tool('get_sensor_events', `Nanit sound, motion and temperature alerts for the baby, newest first. Nanit only serves its newest ${MESSAGES_MAX} alerts (usually the last few days) and has no paging, so older alerts can't be reached; available_from is the oldest alert time served. The type filter is applied within those ${MESSAGES_MAX}.`,
    { baby_uid: babyUid, timezone, limit: z.number().int().min(1).max(MESSAGES_MAX).optional(), type: z.string().max(40).optional().describe('Comma-separated filter: SOUND, MOTION, TEMPERATURE') },
    async (a, c) => {
      // Always fetch the full window so a type filter isn't starved by a small limit
      const { messages } = await nanit.getMessages(c.session.token, a.baby_uid, MESSAGES_MAX);
      const types = a.type ? a.type.toUpperCase().split(',').map(t => t.trim()) : null;
      const matching = types ? messages.filter(m => types.includes(m.type)) : messages;
      return {
        messages: matching.slice(0, a.limit ?? MESSAGES_MAX),
        available_from: messages.length ? Math.min(...messages.map(m => m.time)) : null,
      };
    });

  tool('get_raw_events', `Unprocessed Nanit data for a time window: every calendar entry (auto_sleep segments and care events) plus the camera state events (PUT_TO_SLEEP, FELL_ASLEEP, WOKE_UP, VISIT, REMOVED, ...). No scoring or grouping. Max 3 days. State events come from Nanit's newest ${EVENTS_MAX} camera events (about a week back; Nanit has no paging): state_events_available_from is the oldest one served, and state_events_truncated is true when the window starts before it. They carry timing fields only (uid, key, title, time, begin_ts, end_ts, duration, last_state_duration, confidence, source, camera_uid, created_at); video, clip and thumbnail links are left out.`,
    { baby_uid: babyUid, timezone, start: when, end: when },
    async (a, c) => {
      const start = parseWhen(a.start, c.tzOffset, 'start');
      const end = parseWhen(a.end, c.tzOffset, 'end');
      if (end <= start || end - start > 3 * 86400) throw new ToolError('end must be after start, within 3 days.');
      const [{ calendar }, feed] = await Promise.all([
        nanit.getCalendarEvents(c.session.token, a.baby_uid, start, end),
        nanit.getEvents(c.session.token, a.baby_uid, EVENTS_MAX),
      ]);
      const raw = ((feed?.events ?? []) as any[]).filter(e => typeof e.time === 'number');
      const state_events = raw
        .filter(e => e.time >= start && e.time <= end)
        .sort((x, y) => x.time - y.time)
        // Allowlist: the feed also carries raw_videos/playlist/url/clip_url (pre-signed S3 links); this server is data-only
        .map(e => Object.fromEntries(STATE_EVENT_FIELDS.filter(k => k in e).map(k => [k, e[k]])));
      const availableFrom = raw.length ? Math.min(...raw.map(e => e.time)) : null;
      return {
        range: { start, end },
        calendar: [...calendar].sort((x, y) => x.begin_ts - y.begin_ts).map(dropUrls),
        state_events,
        state_events_available_from: availableFrom,
        // Fewer than EVENTS_MAX back means Nanit sent its whole history, so nothing was cut off
        state_events_truncated: raw.length >= EVENTS_MAX && (availableFrom === null || start < availableFrom),
      };
    });

  return server;
}
