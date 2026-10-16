import * as nanit from '../nanit/client.js';
import { buildNightSummaries, type NightSummary } from './sleep-scorer.js';
import { getStateFeed, type StateEvent } from './night-activity.js';
import { localDateStr, localHour, localToUnix, nightWindowFromDateStr } from './night-windows.js';

/**
 * Daytime naps and 24-hour totals. Nanit's auto_sleep calendar already contains
 * every crib sleep (it's what the Nanit "Activity Tracker" histogram draws); the
 * night views just ask for the bedtime-to-morning window. Here we pull whole
 * days and split sleep blocks into night vs nap.
 *
 * Caveat shown in the UI: only naps taken in the crib are visible.
 */

export interface SleepBlock {
  kind: 'night' | 'nap';
  start: number;
  end: number;
  minutes: number; // asleep minutes (segments only, wakes excluded)
  segments: { start: number; end: number }[];
  /** Parent took the baby out while still asleep: the nap may have continued elsewhere. */
  removed_asleep?: boolean;
}

export interface DayStats {
  date: string; // local YYYY-MM-DD
  complete: boolean; // false for today
  /** When the night before ended (morning wake), if seen. */
  morning_wake: number | null;
  /** When this evening's night started, if seen. */
  bedtime: number | null;
  naps: SleepBlock[];
  nap_count: number;
  nap_minutes: number;
  longest_nap_minutes: number;
  /** Awake time between morning wake / naps / bedtime, in order. */
  wake_windows: WakeWindow[];
  /** Night sleep that ended this morning + naps today. Null if last night is missing. */
  total_24h_minutes: number | null;
}

export interface WakeWindow {
  start: number;
  end: number;
  minutes: number;
  /**
   * Set when the window probably includes sleep the crib didn't see: it follows
   * a nap the baby was carried out of asleep, or it's implausibly long for the age.
   * These are shown but left out of averages.
   */
  uncertain?: 'taken_out_asleep' | 'too_long';
}

export interface NapExpectations {
  naps: [number, number];
  daytime_hours: [number, number];
  wake_window_hours: [number, number];
}

/** Typical ranges by adjusted age, from common pediatric sleep guidance. */
export function napExpectations(adjAgeMonths: number): NapExpectations {
  if (adjAgeMonths < 3) return { naps: [4, 6], daytime_hours: [4, 6], wake_window_hours: [1, 1.5] };
  if (adjAgeMonths < 4) return { naps: [3, 5], daytime_hours: [3, 5], wake_window_hours: [1.25, 2] };
  if (adjAgeMonths < 6) return { naps: [3, 4], daytime_hours: [3, 4], wake_window_hours: [1.75, 2.5] };
  if (adjAgeMonths < 9) return { naps: [2, 3], daytime_hours: [2.5, 3.5], wake_window_hours: [2.5, 3.5] };
  if (adjAgeMonths < 12) return { naps: [2, 2], daytime_hours: [2, 3], wake_window_hours: [3, 4] };
  if (adjAgeMonths < 18) return { naps: [1, 2], daytime_hours: [2, 3], wake_window_hours: [3.5, 5] };
  return { naps: [1, 1], daytime_hours: [1.5, 2.5], wake_window_hours: [5, 6] };
}

export interface DaysParams {
  token: string;
  babyUid: string;
  bedtimeHour: number;
  wakeHour: number;
  tzOffset: number;
}

function toBlock(n: NightSummary, kind: SleepBlock['kind']): SleepBlock {
  return {
    kind,
    start: n.night_start,
    end: n.night_end,
    minutes: Math.round(n.total_duration_minutes),
    segments: n.sleep_segments.map(s => ({ start: s.begin_ts, end: s.end_ts })),
  };
}

/** Does the block cover any of 0:00-4:00 local? Sleep through the small hours is night sleep. */
function spansSmallHours(n: NightSummary, tzOffset: number): boolean {
  for (let t = n.night_start; t <= n.night_end; t += 15 * 60) {
    if (localHour(t, tzOffset) < 4) return true;
  }
  return localHour(n.night_end, tzOffset) < 4;
}

/**
 * Label blocks: the longest block starting in each night window (bedtime-2h ...
 * next morning) is that night, as is anything spanning the small hours.
 * Everything else is a nap.
 */
export function classifyBlocks(blocks: NightSummary[], dates: string[], p: Omit<DaysParams, 'token' | 'babyUid'>): SleepBlock[] {
  const nightSet = new Set<NightSummary>();
  for (const date of [...dates, prevDate(dates[0])]) {
    const w = nightWindowFromDateStr(date, p.bedtimeHour, p.wakeHour, p.tzOffset);
    const candidates = blocks.filter(b => b.night_start >= w.start - 2 * 3600 && b.night_start < w.end);
    const main = candidates.reduce<NightSummary | null>((best, b) => (!best || b.total_duration_minutes > best.total_duration_minutes ? b : best), null);
    if (main && main.total_duration_minutes >= 180) nightSet.add(main);
  }
  for (const b of blocks) if (spansSmallHours(b, p.tzOffset)) nightSet.add(b);
  return blocks.map(b => toBlock(b, nightSet.has(b) ? 'night' : 'nap'));
}

function prevDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d - 1));
  return t.toISOString().slice(0, 10);
}

export function dayStats(
  date: string,
  blocks: SleepBlock[],
  events: StateEvent[],
  tzOffset: number,
  today: string,
  /** Wake windows longer than this (minutes) are flagged as probably containing an untracked nap. */
  maxPlausibleWakeWindow: number = Infinity,
): DayStats {
  const [y, m, d] = date.split('-').map(Number);
  const dayStart = localToUnix(y, m - 1, d, 0, tzOffset);
  const dayEnd = localToUnix(y, m - 1, d + 1, 0, tzOffset);

  // The night that ended this morning, and the one that starts this evening
  const nights = blocks.filter(b => b.kind === 'night');
  const lastNight = [...nights].reverse().find(b => b.end > dayStart && b.end < dayStart + 15 * 3600) ?? null;
  const tonight = nights.find(b => b.start >= dayStart + 12 * 3600 && b.start < dayEnd + 4 * 3600) ?? null;

  const naps = blocks
    .filter(b => b.kind === 'nap' && localDateStr(b.start, tzOffset) === date)
    .map(b => ({
      ...b,
      removed_asleep: events.some(e => e.key === 'REMOVED_ASLEEP' && Math.abs(e.time - b.end) <= 10 * 60) || undefined,
    }));

  const morningWake = lastNight?.end ?? null;
  const bedtime = tonight?.start ?? null;
  const wakeWindows: WakeWindow[] = [];
  const pushWindow = (start: number, end: number, afterTakenOutAsleep: boolean) => {
    if (end <= start) return;
    const minutes = Math.round((end - start) / 60);
    const uncertain = afterTakenOutAsleep ? 'taken_out_asleep' as const : minutes > maxPlausibleWakeWindow ? 'too_long' as const : undefined;
    wakeWindows.push({ start, end, minutes, ...(uncertain && { uncertain }) });
  };
  let awakeSince = morningWake;
  let prevTakenOut = false;
  for (const nap of naps) {
    if (awakeSince !== null) pushWindow(awakeSince, nap.start, prevTakenOut);
    awakeSince = nap.end;
    prevTakenOut = !!nap.removed_asleep;
  }
  if (awakeSince !== null && bedtime !== null) pushWindow(awakeSince, bedtime, prevTakenOut);

  const napMinutes = naps.reduce((s, n) => s + n.minutes, 0);
  return {
    date,
    complete: date < today,
    morning_wake: morningWake,
    bedtime,
    naps,
    nap_count: naps.length,
    nap_minutes: napMinutes,
    longest_nap_minutes: naps.reduce((mx, n) => Math.max(mx, n.minutes), 0),
    wake_windows: wakeWindows,
    total_24h_minutes: lastNight ? lastNight.minutes + napMinutes : null,
  };
}

export interface DaysSummary {
  days_analyzed: number;
  days_with_crib_naps: number;
  avg_naps: number | null;
  avg_nap_minutes_per_day: number | null;
  avg_nap_length_minutes: number | null;
  avg_wake_window_minutes: number | null;
  avg_last_wake_window_minutes: number | null;
  avg_24h_minutes: number | null;
}

const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

export function summarizeDays(days: DayStats[]): DaysSummary {
  const done = days.filter(d => d.complete);
  const withNaps = done.filter(d => d.nap_count > 0);
  const allNaps = withNaps.flatMap(d => d.naps);
  const sureWindows = (d: DayStats) => d.wake_windows.filter(w => !w.uncertain);
  return {
    days_analyzed: done.length,
    days_with_crib_naps: withNaps.length,
    // Days with zero crib naps are almost always naps elsewhere (car, carrier,
    // daycare), so averages only use days where the crib caught at least one.
    avg_naps: withNaps.length ? Math.round((allNaps.length / withNaps.length) * 10) / 10 : null,
    avg_nap_minutes_per_day: avg(withNaps.map(d => d.nap_minutes)),
    avg_nap_length_minutes: avg(allNaps.map(n => n.minutes)),
    avg_wake_window_minutes: avg(withNaps.flatMap(d => sureWindows(d).map(w => w.minutes))),
    avg_last_wake_window_minutes: avg(withNaps.flatMap(d => {
      const last = d.wake_windows[d.wake_windows.length - 1];
      return last && !last.uncertain && last.end === d.bedtime ? [last.minutes] : [];
    })),
    avg_24h_minutes: avg(withNaps.map(d => d.total_24h_minutes).filter((x): x is number => x !== null)),
  };
}

/**
 * Sleep blocks, per-day stats, and parent visits for the given local dates
 * (oldest first). One calendar request covers the whole range.
 */
export async function loadDays(p: DaysParams, dates: string[], expectations?: NapExpectations | null) {
  const [fy, fm, fd] = dates[0].split('-').map(Number);
  const [ly, lm, ld] = dates[dates.length - 1].split('-').map(Number);
  // From the evening before the first day through the morning after the last
  const start = localToUnix(fy, fm - 1, fd - 1, 12, p.tzOffset);
  const end = Math.min(localToUnix(ly, lm - 1, ld + 1, 12, p.tzOffset), Math.floor(Date.now() / 1000));

  const [calendar, feed] = await Promise.all([
    nanit.getCalendarEvents(p.token, p.babyUid, start, end),
    getStateFeed(p.token, p.babyUid).catch(() => ({ oldest: null, events: [] as StateEvent[] })),
  ]);
  const raw = buildNightSummaries(calendar.calendar.filter(e => e.type === 'auto_sleep'));
  const blocks = classifyBlocks(raw, dates, p);
  const today = localDateStr(Date.now() / 1000, p.tzOffset);
  const maxWindow = expectations ? expectations.wake_window_hours[1] * 2 * 60 : Infinity;
  const days = dates.map(date => dayStats(date, blocks, feed.events, p.tzOffset, today, maxWindow));
  const visits = feed.events.filter(e => e.key === 'VISIT' && e.time >= start && e.time <= end).map(e => e.time);
  return { range: { start, end }, blocks, days, visits, events_from: feed.oldest };
}

function clock(unix: number, tzOffset: number): string {
  const h = localHour(unix, tzOffset);
  const hh = Math.floor(h);
  const mm = String(Math.round((h - hh) * 60) % 60).padStart(2, '0');
  return `${hh % 12 === 0 ? 12 : hh % 12}:${mm} ${hh >= 12 ? 'PM' : 'AM'}`;
}

const dur = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`);

/** "DAYTIME BEFORE THIS NIGHT" block for AI prompts: naps and wake windows leading into the night. */
export function dayPromptBlock(day: DayStats | undefined, exp: NapExpectations | null, tzOffset: number): string {
  if (!day) return '';
  const lines = ['DAYTIME BEFORE THIS NIGHT (crib naps only; naps elsewhere are invisible to the camera):'];
  if (day.morning_wake) lines.push(`- Woke for the day: ${clock(day.morning_wake, tzOffset)}`);
  if (day.naps.length === 0) {
    lines.push('- No crib naps recorded. The baby may have napped elsewhere, so do not conclude naps were skipped.');
  } else {
    for (const n of day.naps) {
      lines.push(`- Nap ${clock(n.start, tzOffset)}–${clock(n.end, tzOffset)} (${dur(n.minutes)})${n.removed_asleep ? ', carried out still asleep so it may have continued elsewhere' : ''}`);
    }
    lines.push(`- Crib nap total: ${dur(day.nap_minutes)} across ${day.nap_count} nap${day.nap_count === 1 ? '' : 's'}`);
  }
  if (day.wake_windows.length) {
    const shown = day.wake_windows.map(w => (w.uncertain ? `unknown (${dur(w.minutes)} between crib sleeps)` : dur(w.minutes)));
    lines.push(`- Wake windows: ${shown.join(', ')}${day.bedtime && day.wake_windows[day.wake_windows.length - 1].end === day.bedtime ? ' (last one ends at bedtime)' : ''}`);
    if (day.wake_windows.some(w => w.uncertain)) {
      lines.push('- "Unknown" windows almost certainly contain a nap outside the crib (car, carrier, stroller, daycare). Do not call them long wake windows, overtiredness, or a missed nap, and do not base the tip on them.');
    }
  }
  if (exp) {
    lines.push(`- Typical for this age: ${exp.naps[0]}-${exp.naps[1]} naps, ${exp.daytime_hours[0]}-${exp.daytime_hours[1]}h daytime sleep, wake windows ${exp.wake_window_hours[0]}-${exp.wake_window_hours[1]}h`);
  }
  return lines.join('\n');
}
