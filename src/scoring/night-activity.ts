import * as nanit from '../nanit/client.js';
import * as store from '../cache.js';

/**
 * Nanit's camera logs "state" events alongside the auto_sleep calendar:
 * PUT_IN_BED, PUT_TO_SLEEP, FELL_ASLEEP, WOKE_UP, VISIT ("Parent approaching"),
 * REMOVED and REMOVED_ASLEEP ("Parent took baby out"). The VISIT/REMOVED ones
 * are what let us tell a wake the baby settled on their own from one a parent
 * responded to.
 */
export const STATE_KEYS = ['PUT_IN_BED', 'PUT_TO_SLEEP', 'FELL_ASLEEP', 'WOKE_UP', 'VISIT', 'REMOVED', 'REMOVED_ASLEEP'] as const;
export type StateKey = typeof STATE_KEYS[number];

/** Keys that mean a parent was physically at the crib. */
const PARENT_KEYS = new Set<string>(['VISIT', 'REMOVED', 'REMOVED_ASLEEP', 'PUT_IN_BED']);
const REMOVED_KEYS = new Set<string>(['REMOVED', 'REMOVED_ASLEEP']);

export interface StateEvent {
  key: StateKey;
  time: number; // unix seconds
}

/**
 * State events for one time window. `covered` is false when Nanit's event feed
 * doesn't reach back that far (or the camera logged nothing), in which case
 * "no visit" means "don't know", not "self-settled".
 */
export interface WindowActivity {
  covered: boolean;
  events: StateEvent[];
}

export type WakeResponse = 'self_settled' | 'parent_visit' | 'taken_out' | 'unknown';

export interface WakeDetail {
  start: number;
  end: number;
  duration_minutes: number;
  response: WakeResponse;
  /** 'nanit' = inferred from camera events; 'parent' = set by the parent in the app. */
  source: 'nanit' | 'parent';
  /** Times of parent events during the wake. */
  visit_times: number[];
}

/** A parent check while the baby was asleep (e.g. a peek before the parents' own bedtime). */
export interface CheckIn {
  time: number;
  /** Minutes until the next wake, if one started within 15 minutes. */
  wake_within_minutes?: number;
}

/** Parent events this close before a wake starts or after it ends still count as responding to it. */
const RESPONSE_SLACK_SEC = 120;

/**
 * Label each wake as self-settled / parent visit / taken out / unknown.
 * `overrides` (keyed by the wake's start, unix seconds as a string) come from
 * the parent and win over the camera's inference.
 */
export function classifyWakes(
  gaps: { start: number; end: number; duration_minutes: number }[],
  activity: WindowActivity | null | undefined,
  overrides?: Record<string, WakeResponse> | null,
): WakeDetail[] {
  return gaps.map(g => {
    const visits = (activity?.events ?? [])
      .filter(e => PARENT_KEYS.has(e.key) && e.time >= g.start - RESPONSE_SLACK_SEC && e.time <= g.end + RESPONSE_SLACK_SEC);
    const override = overrides?.[String(Math.round(g.start))];
    if (override) {
      return { ...g, response: override, source: 'parent' as const, visit_times: visits.map(v => v.time) };
    }
    let response: WakeResponse;
    if (!activity?.covered) response = 'unknown';
    else if (visits.some(v => REMOVED_KEYS.has(v.key))) response = 'taken_out';
    else if (visits.length > 0) response = 'parent_visit';
    else response = 'self_settled';
    return { ...g, response, source: 'nanit' as const, visit_times: visits.map(v => v.time) };
  });
}

/** VISIT events inside the night that weren't part of responding to a wake. */
export function findCheckIns(
  night: { night_start: number; night_end: number },
  wakes: WakeDetail[],
  activity: WindowActivity | null | undefined,
): CheckIn[] {
  if (!activity?.covered) return [];
  const inWake = new Set(wakes.flatMap(w => w.visit_times));
  return activity.events
    .filter(e => e.key === 'VISIT' && e.time > night.night_start && e.time < night.night_end && !inWake.has(e.time))
    .map(e => {
      const next = wakes.find(w => w.start >= e.time && w.start - e.time <= 15 * 60);
      return { time: e.time, ...(next && { wake_within_minutes: Math.round((next.start - e.time) / 60) }) };
    });
}

export function wakeCounts(wakes: WakeDetail[]) {
  return {
    self_settled: wakes.filter(w => w.response === 'self_settled').length,
    parent_visit: wakes.filter(w => w.response === 'parent_visit').length,
    taken_out: wakes.filter(w => w.response === 'taken_out').length,
    unknown: wakes.filter(w => w.response === 'unknown').length,
  };
}

// ===== FETCHING =====

/** Nanit's /events returns the newest N events; 500 reaches back roughly two weeks. */
const FEED_LIMIT = 500;
const FEED_TTL_MS = 5 * 60 * 1000;
const feedCache = new Map<string, { at: number; feed: Promise<{ oldest: number | null; events: StateEvent[] }> }>();

/** The newest ~500 Nanit events for a baby, reduced to state events. Cached for 5 minutes. */
export function getStateFeed(token: string, babyUid: string): Promise<{ oldest: number | null; events: StateEvent[] }> {
  const hit = feedCache.get(babyUid);
  if (hit && Date.now() - hit.at < FEED_TTL_MS) return hit.feed;
  const feed = nanit.getEvents(token, babyUid, FEED_LIMIT).then((data: any) => {
    const raw = ((data?.events ?? []) as any[]).filter(e => typeof e.time === 'number');
    const oldest = raw.length ? Math.min(...raw.map(e => e.time)) : null;
    const events = raw
      .filter(e => (STATE_KEYS as readonly string[]).includes(e.key))
      .map(e => ({ key: e.key as StateKey, time: Math.round(e.time) }))
      .sort((a, b) => a.time - b.time);
    return { oldest, events };
  });
  feed.catch(() => feedCache.delete(babyUid));
  feedCache.set(babyUid, { at: Date.now(), feed });
  return feed;
}

// Completed windows are persisted so a night keeps its visit data after it
// scrolls out of Nanit's event feed.

/**
 * State events for [start, end]. A window counts as covered only if the feed
 * reaches back before it AND the camera logged at least one state event in it
 * (a night with zero events usually means the camera was off or offline).
 */
export async function getWindowActivity(token: string, babyUid: string, start: number, end: number): Promise<WindowActivity> {
  const complete = end + 3600 < Date.now() / 1000;
  if (complete) {
    const cached = await store.getCachedActivity(babyUid, start, end).catch(() => null);
    if (cached) return cached;
  }

  let feed: { oldest: number | null; events: StateEvent[] };
  try {
    feed = await getStateFeed(token, babyUid);
  } catch (err: any) {
    console.log(`[activity] event feed failed: ${err.message}`);
    return { covered: false, events: [] };
  }

  const events = feed.events.filter(e => e.time >= start && e.time <= end);
  const covered = feed.oldest !== null && feed.oldest <= start && events.length > 0;
  const activity: WindowActivity = { covered, events };

  if (complete && covered) {
    await store.cacheActivity(babyUid, start, end, activity)
      .catch(err => console.log(`[activity] cache write failed: ${err.message}`));
  }
  return activity;
}
