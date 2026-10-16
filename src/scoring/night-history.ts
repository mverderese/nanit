import * as nanit from '../nanit/client.js';
import { NanitAuthError } from '../nanit/client.js';
import * as store from '../cache.js';
import { applyAnnotation, buildNightSummaries, pickMainNight, scoreNight, type NightSummary } from './sleep-scorer.js';
import { nightWindowFromDateStr, pastNightDates, nightId, type NightWindow } from './night-windows.js';
import { getWindowActivity } from './night-activity.js';
import type { SleepAnnotation, SleepScoreBreakdown } from './app-types.js';

/**
 * One scored night, ready for trend/milestone/regression/AI consumers.
 * `night` has the parent's annotation applied; `raw` is what Nanit reported.
 */
export interface ScoredNight {
  date: string;
  window: NightWindow;
  raw: NightSummary;
  night: NightSummary;
  score: SleepScoreBreakdown;
  annotation: SleepAnnotation | null;
}

export interface RangeParams {
  token: string;
  babyUid: string;
  days: number;
  birthdate: string;
  prematureWeeks: number;
  bedtimeHour: number;
  wakeHour: number;
  tzOffset: number;
  /** Anchor: nights strictly before this local date (default: today, i.e. last night is the newest). */
  beforeDate?: string;
}

const NANIT_CONCURRENCY = 4;

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Raw nights (Nanit auto_sleep segments, grouped into nights) for a window.
 * Completed windows are cached in Firestore so multi-night views don't hammer
 * Nanit; in-progress windows always go to the source.
 */
export async function getNightsForWindow(token: string, babyUid: string, start: number, end: number): Promise<NightSummary[]> {
  const complete = end + 3600 < Date.now() / 1000;
  if (complete) {
    const cached = await store.getCachedNights(babyUid, start, end).catch(() => null);
    if (cached) return cached;
  }
  const result = await nanit.getCalendarEvents(token, babyUid, start, end);
  const nights = buildNightSummaries(result.calendar.filter(e => e.type === 'auto_sleep'));
  if (complete) {
    await store.cacheNights(babyUid, start, end, nights).catch(err => console.log(`[night-cache] write failed: ${err.message}`));
  }
  return nights;
}

/** Score the main night of one window, applying any saved annotation. */
export async function scoreWindow(
  p: Omit<RangeParams, 'days' | 'beforeDate'>,
  window: NightWindow,
): Promise<ScoredNight | null> {
  const nights = await getNightsForWindow(p.token, p.babyUid, window.start, window.end);
  if (nights.length === 0) return null;
  const raw = pickMainNight(nights);
  const [annotation, activity] = await Promise.all([
    store.getAnnotation(p.babyUid, nightId(p.babyUid, window.date)).catch(() => null),
    getWindowActivity(p.token, p.babyUid, window.start, window.end),
  ]);
  const score = scoreNight(raw, {
    birthdate: p.birthdate,
    prematureWeeks: p.prematureWeeks,
    annotation,
    tzOffset: p.tzOffset,
    bedtimeHour: p.bedtimeHour,
    activity,
  });
  return { date: window.date, window, raw, night: applyAnnotation(raw, annotation), score, annotation };
}

/**
 * The last `days` completed nights, oldest first, with annotations applied.
 * Nights with no sleep data are omitted. Individual failures are logged and skipped.
 */
export async function loadScoredNights(p: RangeParams): Promise<ScoredNight[]> {
  const dates = pastNightDates(p.days, p.tzOffset, p.beforeDate);
  const results = await mapWithConcurrency(dates, NANIT_CONCURRENCY, async date => {
    const window = nightWindowFromDateStr(date, p.bedtimeHour, p.wakeHour, p.tzOffset);
    try {
      return await scoreWindow(p, window);
    } catch (err: any) {
      // Auth failures must propagate so the client re-logs in; anything else is a skipped night
      if (err instanceof NanitAuthError || /401|Unauthorized/.test(String(err?.message))) throw err;
      console.log(`[nights] ${date} failed: ${err?.message}`);
      return null;
    }
  });
  return results.filter((r): r is ScoredNight => r !== null);
}

/** Flat shape used by the trend, milestone, regression, and optimizer services. */
export interface HistoryPoint {
  date: string;
  score: number;
  total_sleep_minutes: number;
  wake_count: number;
  self_settled_wakes: number;
  parent_visit_wakes: number;
  longest_stretch_minutes: number;
  bedtime: string;
  wake_time: string;
  adjusted: boolean;
}

export function toHistoryPoint(n: ScoredNight): HistoryPoint {
  return {
    date: n.date,
    score: n.score.total_score,
    total_sleep_minutes: n.score.details.total_sleep_minutes,
    wake_count: n.score.details.wake_count,
    self_settled_wakes: n.score.expectations.self_settled_wakes,
    parent_visit_wakes: n.score.expectations.parent_visit_wakes,
    longest_stretch_minutes: n.score.details.longest_stretch_minutes,
    bedtime: n.score.details.bedtime,
    wake_time: n.score.details.wake_time,
    adjusted: n.score.details.adjusted,
  };
}
