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
