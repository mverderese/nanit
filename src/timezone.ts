/**
 * The scoring modules use the browser's `getTimezoneOffset()` convention: minutes
 * *behind* UTC (240 for EDT, -60 for CET). This derives it from an IANA zone name.
 */
export function tzOffsetMinutes(timeZone: string, at: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find(p => p.type === t)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((Math.floor(at.getTime() / 1000) * 1000 - asUtc) / 60000);
}
