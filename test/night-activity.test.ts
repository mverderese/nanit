import test from 'node:test';
import assert from 'node:assert/strict';
import { getWindowActivity } from '../src/scoring/night-activity.js';
import * as cache from '../src/cache.js';

test('completed activity is cached in memory and remains available when Nanit is offline', async () => {
  const originalFetch = globalThis.fetch;
  const end = Math.floor(Date.now() / 1000) - 7200;
  const start = end - 3600;
  let requests = 0;
  try {
    globalThis.fetch = async () => {
      requests++;
      return Response.json({ events: [
        { key: 'FELL_ASLEEP', time: start - 10 },
        { key: 'VISIT', time: start + 100 },
      ] });
    };
    const expected = { covered: true, events: [{ key: 'VISIT', time: start + 100 }] };
    assert.deepEqual(await getWindowActivity('token', 'activity-baby', start, end), expected);
    assert.deepEqual(await cache.getCachedActivity('activity-baby', start, end), expected);
    globalThis.fetch = async () => { throw new Error('Nanit offline'); };
    assert.deepEqual(await getWindowActivity('token', 'activity-baby', start, end), expected);
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
