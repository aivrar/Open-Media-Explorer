import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROFILE_SEQUENCE_HEADER,
  PROFILE_STORAGE_KEYS,
  PROFILE_WRITER_HEADER,
  captureProfileStorage,
  clearProfileHandoff,
  hasLegacyProfile,
  restoreProfileHandoff,
  restoreProfileStorageValues,
  saveProfileHandoff,
} from '../src/lib/profile-transfer.js';

class MemoryStorage {
  constructor(values = {}) { this.values = new Map(Object.entries(values)); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

test('oversize or unreadable profiles never replace the native backup with a partial snapshot', async () => {
  let sent = false;
  const requestImpl = async () => { sent = true; };
  await assert.rejects(saveProfileHandoff({
    storage: new MemoryStorage({ 'worldmedia.favorites.v1': 'x'.repeat(2 * 1024 * 1024 + 1) }), requestImpl,
  }), /too large/);
  let reads = 0;
  await assert.rejects(saveProfileHandoff({ storage: { getItem() {
    if (++reads > 1) throw new Error('Storage blocked');
    return '[]';
  } }, requestImpl }), /Storage blocked/);
  assert.equal(sent, false);
});

test('failed fresh-origin restore rolls back keys and can be retried', () => {
  const storage = new MemoryStorage();
  const setItem = storage.setItem.bind(storage);
  storage.setItem = (key, value) => {
    if (key.includes('settings')) throw new Error('Quota exceeded');
    setItem(key, value);
  };
  const values = { 'worldmedia.favorites.v1': '[]', 'worldmedia.settings.v1': '{}' };
  assert.equal(restoreProfileStorageValues(values, storage), false);
  assert.equal(storage.values.size, 0);
  storage.setItem = setItem;
  assert.equal(restoreProfileStorageValues(values, storage), true);
});

test('oversize backup does not prevent app initialization or overwrite existing preferences', async () => {
  const big = 'x'.repeat(2 * 1024 * 1024 + 1);
  const storage = new MemoryStorage({ 'worldmedia.favorites.v1': big });
  assert.equal(await restoreProfileHandoff({ storage, requestImpl: async () => { throw new Error('unavailable'); } }), false);
  assert.equal(storage.getItem('worldmedia.favorites.v1'), big);
});

test('profile handoff sends only the supported local browser keys before a port move', async () => {
  const storage = new MemoryStorage({
    'worldmedia.favorites.v1': '[{"id":"saved:1"}]',
    'worldmedia.settings.v1': '{"theme":"forest"}',
    unrelated: 'must not transfer',
  });
  const calls = [];
  const requestImpl = async (path, options) => {
    calls.push({ path, options });
    return { saved: true };
  };

  const result = await saveProfileHandoff({ storage, requestImpl });
  assert.equal(result.saved, true);
  assert.deepEqual(captureProfileStorage(storage), {
    'worldmedia.favorites.v1': '[{"id":"saved:1"}]',
    'worldmedia.settings.v1': '{"theme":"forest"}',
  });
  assert.equal(calls.length, 1);
  const { signal, headers, ...options } = calls[0].options;
  assert.equal(calls[0].path, '/api/v1/profile/preferences');
  assert.deepEqual(options, { method: 'POST', body: { values: result.values }, ownConnection: true });
  assert.deepEqual(Object.keys(headers).sort(), [PROFILE_SEQUENCE_HEADER, PROFILE_WRITER_HEADER].sort());
  assert.ok(signal instanceof AbortSignal, 'every profile request can be stopped by its timeout');
});

test('a fresh localhost origin restores the profile handoff without overwriting existing data', async () => {
  const values = {
    'worldmedia.favorites.v1': '[{"id":"saved:1"}]',
    'worldmedia.settings.v1': '{"theme":"forest"}',
    'worldmedia.eq.v1': '{"version":1}',
  };
  const fresh = new MemoryStorage();
  const restored = await restoreProfileHandoff({
    storage: fresh,
    requestImpl: async () => ({ values }),
  });
  assert.equal(restored, true);
  assert.deepEqual(captureProfileStorage(fresh), values);

  const existing = new MemoryStorage({ 'worldmedia.favorites.v1': '[]' });
  assert.equal(restoreProfileStorageValues(values, existing), false);
  assert.equal(existing.getItem('worldmedia.favorites.v1'), '[]');
  assert.equal(PROFILE_STORAGE_KEYS.includes('unrelated'), false);
});

test("every profile write carries this page's id and a number that only goes up, clears included", async () => {
  const storage = new MemoryStorage({ 'worldmedia.favorites.v1': '[]' });
  const sent = [];
  const requestImpl = async (path, options) => {
    sent.push(options);
    return options.body.values && Object.keys(options.body.values).length ? { saved: true } : { saved: true, keys: [] };
  };
  await saveProfileHandoff({ storage, requestImpl });
  await clearProfileHandoff({ requestImpl });
  await saveProfileHandoff({ storage, requestImpl, headers: { [PROFILE_SEQUENCE_HEADER]: '1' } });
  assert.equal(sent.length, 3);
  const writers = sent.map((options) => options.headers[PROFILE_WRITER_HEADER]);
  assert.match(writers[0], /^[0-9a-f]{32}$/);
  assert.deepEqual(new Set(writers).size, 1, 'one id for the whole page load');
  const numbers = sent.map((options) => Number(options.headers[PROFILE_SEQUENCE_HEADER]));
  assert.ok(numbers.every((number) => Number.isSafeInteger(number) && number >= 1));
  assert.ok(numbers[0] < numbers[1] && numbers[1] < numbers[2], `strictly increasing: ${numbers}`);
  // The clear is a write like any other: the same route, empty values.
  assert.deepEqual(sent[1].body, { values: {} });
  assert.equal(sent[1].method, 'POST');
});

test('a write the server answers "superseded" counts as done, not as a failure', async () => {
  const storage = new MemoryStorage({ 'worldmedia.favorites.v1': '[{"id":"saved:1"}]' });
  const requestImpl = async () => ({ saved: false, superseded: true, keys: [] });
  const result = await saveProfileHandoff({ storage, requestImpl });
  assert.equal(result.saved, true);
  assert.equal(result.superseded, true);
  assert.equal(await clearProfileHandoff({ requestImpl }), true);
  const normal = await saveProfileHandoff({ storage, requestImpl: async () => ({ saved: true, keys: [] }) });
  assert.equal(normal.superseded, false);
});

test('only the keys 0.1.8 knows say this origin already has a profile', () => {
  assert.equal(hasLegacyProfile(new MemoryStorage()), false);
  assert.equal(hasLegacyProfile(new MemoryStorage({ 'worldmedia.favgroups.v1': '{"version":1}' })), false);
  for (const key of ['worldmedia.favorites.v1', 'worldmedia.settings.v1', 'worldmedia.volume.v1', 'worldmedia.jobs.v1']) {
    assert.equal(hasLegacyProfile(new MemoryStorage({ [key]: '' })), true, key);
  }
  assert.throws(() => hasLegacyProfile({}), /unavailable/);
});

test('an origin holding only categories still gets the data folder profile, whose categories win', async () => {
  const local = '{"version":1,"groups":[{"id":"g1","name":"Local"}],"assign":{}}';
  const folder = '{"version":1,"groups":[{"id":"g2","name":"Folder"}],"assign":{"saved:1":"g2"}}';
  const values = {
    'worldmedia.favorites.v1': '[{"id":"saved:1"}]',
    'worldmedia.settings.v1': '{"theme":"forest"}',
    'worldmedia.favgroups.v1': folder,
  };
  const storage = new MemoryStorage({ 'worldmedia.favgroups.v1': local });
  let requests = 0;
  const restored = await restoreProfileHandoff({ storage, requestImpl: async () => { requests += 1; return { values }; } });
  assert.equal(restored, true);
  assert.equal(requests, 1);
  assert.deepEqual(captureProfileStorage(storage), values);

  // The data folder has no categories: the ones already here are kept.
  const keep = new MemoryStorage({ 'worldmedia.favgroups.v1': local });
  assert.equal(restoreProfileStorageValues({ 'worldmedia.favorites.v1': '[]' }, keep), true);
  assert.equal(keep.getItem('worldmedia.favgroups.v1'), local);
  assert.equal(keep.getItem('worldmedia.favorites.v1'), '[]');

  // A failed restore puts the categories that were here back.
  const failing = new MemoryStorage({ 'worldmedia.favgroups.v1': local });
  const setItem = failing.setItem.bind(failing);
  failing.setItem = (key, value) => {
    if (key === 'worldmedia.settings.v1') throw new Error('Quota exceeded');
    setItem(key, value);
  };
  assert.equal(restoreProfileStorageValues(values, failing), false);
  assert.deepEqual([...failing.values.entries()], [['worldmedia.favgroups.v1', local]]);
});
