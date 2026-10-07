import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROFILE_STORAGE_KEYS,
  captureProfileStorage,
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
  const storage = new MemoryStorage({ 'worldmedia.favorites.v1': 'x'.repeat(2 * 1024 * 1024 + 1) });
  assert.equal(await restoreProfileHandoff({ storage, requestImpl: async () => { throw new Error('must not request'); } }), false);
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
  assert.deepEqual(calls, [{
    path: '/api/v1/profile/preferences',
    options: {
      method: 'POST',
      body: { values: result.values },
    },
  }]);
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
