/**
 * In-memory stand-in for the fork's storage layer; the copied scoring modules call
 * these for caching only. Nothing survives a cold start, nothing is per-user state:
 * entries are keyed by baby_uid, which tools only use after confirming it belongs to
 * the caller's own account.
 */
import type { NightSummary } from './scoring/sleep-scorer.js';
import type { WindowActivity } from './scoring/night-activity.js';
import type { SleepAnnotation } from './scoring/app-types.js';

const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 500;

class Lru<V> {
  private m = new Map<string, { at: number; v: V }>();
  get(k: string): V | null {
    const e = this.m.get(k);
    if (!e) return null;
    if (Date.now() - e.at > TTL_MS) { this.m.delete(k); return null; }
    return e.v;
  }
  set(k: string, v: V) {
    if (this.m.size >= MAX_ENTRIES) this.m.delete(this.m.keys().next().value!);
    this.m.set(k, { at: Date.now(), v });
  }
}

const nights = new Lru<NightSummary[]>();
const activity = new Lru<WindowActivity>();
const key = (babyUid: string, start: number, end: number) => `${babyUid}:${start}:${end}`;

export async function getCachedNights(babyUid: string, start: number, end: number) {
  return nights.get(key(babyUid, start, end));
}
export async function cacheNights(babyUid: string, start: number, end: number, v: NightSummary[]) {
  nights.set(key(babyUid, start, end), v);
}
export async function getCachedActivity(babyUid: string, start: number, end: number) {
  return activity.get(key(babyUid, start, end));
}
export async function cacheActivity(babyUid: string, start: number, end: number, v: WindowActivity) {
  activity.set(key(babyUid, start, end), v);
}
/** Manual night corrections are deliberately not supported (no server-side state). */
export async function getAnnotation(_babyUid: string, _nightId: string): Promise<SleepAnnotation | null> {
  return null;
}
