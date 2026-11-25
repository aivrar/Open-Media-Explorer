import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROFILE_COPY_KEYS, restoreCopiedProfileValues, restoreProfileHandoff, restoreProfileHandoffOutcome,
} from '../src/lib/profile-transfer.js';

class MemoryStorage {
  constructor(values = {}) { this.values = new Map(Object.entries(values)); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

const FAVORITES = 'worldmedia.favorites.v1';
const NAMES = 'worldmedia.favnames.v1';
const OWN_STREAM = 'worldmedia.ownstream.v1';
const folder = {
  [FAVORITES]: '[{"id":"rb:one"}]',
  [NAMES]: '{"version":1,"names":{"rb:one":"Morning radio"}}',
  [OWN_STREAM]: '{"version":1,"ids":["rb:one"]}',
};

test('the copied keys are the names and the own-stream choices', () => {
  assert.deepEqual([...PROFILE_COPY_KEYS], [NAMES, OWN_STREAM]);
});

test('an origin with a profile and no names gets the copied ones, and nothing else', async () => {
  const storage = new MemoryStorage({ [FAVORITES]: '[{"id":"rb:one"},{"id":"rb:two"}]' });
  let requests = 0;
  const restored = await restoreProfileHandoff({
    storage,
    requestImpl: async () => { requests += 1; return { values: folder, copied: [NAMES, OWN_STREAM] }; },
  });
  assert.equal(restored, true);
  assert.equal(requests, 1);
  assert.equal(storage.getItem(NAMES), folder[NAMES]);
  assert.equal(storage.getItem(OWN_STREAM), folder[OWN_STREAM]);
  assert.equal(storage.getItem(FAVORITES), '[{"id":"rb:one"},{"id":"rb:two"}]', 'its own favorites stay');
});

test('an origin that has a names key keeps its own', async () => {
  const own = '{"version":1,"names":{"rb:one":"Mine"}}';
  const storage = new MemoryStorage({ [FAVORITES]: '[]', [NAMES]: own });
  const restored = await restoreProfileHandoff({
    storage, requestImpl: async () => ({ values: folder, copied: [NAMES, OWN_STREAM] }),
  });
  assert.equal(restored, true, 'the own-stream choices it lacked were set');
  assert.equal(storage.getItem(NAMES), own);
  assert.equal(storage.getItem(OWN_STREAM), folder[OWN_STREAM]);
  // With both keys already here, the data folder is not even asked.
  assert.equal(await restoreProfileHandoff({
    storage, requestImpl: async () => { throw new Error('must not request'); },
  }), false);
});

test('without copied keys nothing is set in an origin that has a profile', async () => {
  for (const copied of [[], undefined, null, 'worldmedia.favnames.v1', [FAVORITES]]) {
    const storage = new MemoryStorage({ [FAVORITES]: '[]' });
    const restored = await restoreProfileHandoff({ storage, requestImpl: async () => ({ values: folder, copied }) });
    assert.equal(restored, false, JSON.stringify(copied));
    assert.deepEqual([...storage.values.keys()], [FAVORITES]);
  }
  // A key named as copied but missing from the values is not set either.
  const storage = new MemoryStorage({ [FAVORITES]: '[]' });
  assert.equal(restoreCopiedProfileValues({ [FAVORITES]: '[]' }, [NAMES], storage), false);
  assert.equal(storage.getItem(NAMES), null);
});

test('a copied key that cannot be stored leaves the origin as it was', async () => {
  const storage = new MemoryStorage({ [FAVORITES]: '[]' });
  const setItem = storage.setItem.bind(storage);
  storage.setItem = (key, value) => {
    if (key === OWN_STREAM) throw new Error('Quota exceeded');
    setItem(key, value);
  };
  assert.equal(restoreCopiedProfileValues(folder, [NAMES, OWN_STREAM], storage), false);
  assert.equal(await restoreProfileHandoffOutcome({
    storage, requestImpl: async () => ({ values: folder, copied: [NAMES, OWN_STREAM] }),
  }), 'failed');
  assert.deepEqual([...storage.values.keys()], [FAVORITES]);
});

test('a fresh origin still takes the whole data folder profile', async () => {
  const storage = new MemoryStorage();
  assert.equal(await restoreProfileHandoff({ storage, requestImpl: async () => ({ values: folder, copied: [NAMES] }) }), true);
  for (const [key, value] of Object.entries(folder)) assert.equal(storage.getItem(key), value, key);
});
