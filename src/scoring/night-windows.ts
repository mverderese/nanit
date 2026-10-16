/**
 * Time-window helpers shared by every route that reasons about "nights".
 *
 * Convention: `tzOffset` is the value of `Date.prototype.getTimezoneOffset()`
 * on the client — minutes *behind* UTC (240 for EDT, 420 for PDT, -60 for CET).
 *   local wall-clock  = UTC - tzOffset
 *   UTC               = local + tzOffset
 */

/** Hours after the configured wake hour that a night window stays open. */
export const WAKE_BUFFER_HOURS = 4;

/** A Date whose getUTC* parts read as the client's local wall-clock right now. */
export function localNow(tzOffset: number): Date {
  return new Date(Date.now() - tzOffset * 60 * 1000);
}

/** Local wall-clock hour (decimal) of a unix-seconds instant. */
export function localHour(unixSec: number, tzOffset: number): number {
  const d = new Date(unixSec * 1000 - tzOffset * 60 * 1000);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}

/** YYYY-MM-DD in the client's local time for a unix-seconds instant. */
export function localDateStr(unixSec: number, tzOffset: number): string {
  const d = new Date(unixSec * 1000 - tzOffset * 60 * 1000);
  return ymd(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function ymd(y: number, m0: number, d: number): string {
  return `${y}-${String(m0 + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Unix seconds for a local wall-clock date/hour. */
export function localToUnix(y: number, m0: number, d: number, hour: number, tzOffset: number): number {
  return Math.floor((Date.UTC(y, m0, d, hour, 0, 0) + tzOffset * 60 * 1000) / 1000);
}

export interface NightWindow {
  /** Local calendar date the night belongs to (the evening it started). */
  date: string;
  start: number; // unix seconds
  end: number; // unix seconds
}

/** "Night of <date>": bedtimeHour on that date -> wakeHour + buffer the next morning. */
export function nightWindowFromDateStr(dateStr: string, bedtimeHour: number, wakeHour: number, tzOffset: number): NightWindow {
  const [y, m, d] = dateStr.split('-').map(Number);
  return {
    date: dateStr,
    start: localToUnix(y, m - 1, d, bedtimeHour, tzOffset),
    end: localToUnix(y, m - 1, d + 1, wakeHour + WAKE_BUFFER_HOURS, tzOffset),
  };
}

/**
 * Local dates of the last `days` completed nights, oldest first.
 * "Tonight" (today's date) is excluded; last night is today - 1.
 * Pass `beforeDate` to anchor on a different day (nights strictly before it).
 */
export function pastNightDates(days: number, tzOffset: number, beforeDate?: string): string[] {
  let anchor: Date;
  if (beforeDate) {
    const [y, m, d] = beforeDate.split('-').map(Number);
    anchor = new Date(Date.UTC(y, m - 1, d));
  } else {
    const n = localNow(tzOffset);
    anchor = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
  }
  const out: string[] = [];
  for (let back = days; back >= 1; back--) {
    const t = new Date(anchor.getTime() - back * 86400000);
    out.push(ymd(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
  }
  return out;
}

/** Stable identifier for a baby's night, used for annotations. */
export function nightId(babyUid: string, date: string): string {
  return `${babyUid}:${date}`;
}
