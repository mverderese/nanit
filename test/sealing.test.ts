import test from 'node:test';
import assert from 'node:assert/strict';
import { Sealer } from '../src/sealing.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

test('seal/open round trip', () => {
  const s = new Sealer([A]);
  const t = s.seal('access', { x: 1 }, 60);
  assert.ok(t.startsWith('nma_'));
  assert.equal(s.open('access', t)?.x, 1);
});

test('rejects tampering, garbage and wrong type', () => {
  const s = new Sealer([A]);
  const t = s.seal('access', { x: 1 }, 60);
  assert.equal(s.open('access', t.slice(0, -2) + (t.endsWith('AA') ? 'BB' : 'AA')), null);
  assert.equal(s.open('access', 'nma_garbage'), null);
  assert.equal(s.open('access', undefined), null);
  assert.equal(s.open('refresh', t), null);
  // Swapping the prefix must not turn a code into an access token (AAD binds the prefix)
  const code = s.seal('code', { x: 1 }, 60);
  assert.equal(s.open('access', 'nma_' + code.slice(4)), null);
});

test('expiry', () => {
  const s = new Sealer([A]);
  assert.equal(s.open('code', s.seal('code', {}, -1)), null);
  assert.ok(s.open('client', s.seal('client', {}, null)));
});

test('rotation: new key encrypts, old key still decrypts, removed key does not', () => {
  const old = new Sealer([A]).seal('access', { x: 1 }, 60);
  assert.equal(new Sealer([B, A]).open('access', old)?.x, 1);
  assert.equal(new Sealer([B]).open('access', old), null);
  assert.equal(new Sealer([A]).open('access', new Sealer([B, A]).seal('access', {}, 60)), null);
});

test('short secrets are rejected', () => {
  assert.throws(() => new Sealer(['short']));
});
