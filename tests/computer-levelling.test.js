import test from 'node:test';
import assert from 'node:assert/strict';

import { computerLevelling, createLoudnessRequests, loudnessFields } from '../src/lib/computer-levelling.js';
import { createComputerLibrary } from '../src/lib/computer-library.js';
import { makeComputerItem } from '../src/lib/computer-play.js';
import { EXTRA_SETTINGS_STORAGE_KEY } from '../src/lib/profile-storage.js';
import { restoreProfileHandoff, saveProfileHandoff } from '../src/lib/profile-transfer.js';
import { getState, initState, normalizeSettings, saveSettings, STORAGE_KEYS } from '../src/lib/state.js';
import { detailRows } from '../src/modes/now-playing.js';

const gain = (db) => 10 ** (db / 20);

test('levelling chooses the requested gain and peak and caps clipping and boosts', () => {
  const entry = { rg_track_gain: -8.4, rg_track_peak: 0.8, rg_album_gain: -4, rg_album_peak: 0.95 };
  const track = { volumeLevelling: 'track', levellingPreamp: 2 };
  const album = { volumeLevelling: 'album', levellingPreamp: 12 };
  assert.deepEqual(computerLevelling(entry, track), {
    gain: gain(-6.4), text: '-6.4 dB',
    title: 'Volume levelling: track gain -8.4 dB, pre-amp +2 dB',
  });
  const albumLimited = computerLevelling(entry, album);
  assert.equal(albumLimited.gain, 1 / 0.95);
  assert.match(albumLimited.title, /album gain -4 dB.*limited to avoid clipping/);

  const { rg_album_gain, rg_album_peak, ...trackOnly } = entry;
  assert.deepEqual(computerLevelling({ ...trackOnly, rg_album_peak: 16 }, { ...track, volumeLevelling: 'album' }),
    computerLevelling(entry, track), 'track fallback uses the track peak');
  assert.equal(computerLevelling({ ...entry, rg_album_peak: undefined }, album).gain, 1 / 0.8);
  assert.equal(computerLevelling({ rg_track_gain: -2 }, { ...track, levellingPreamp: -12 }).gain, gain(-14));
  const boost = computerLevelling({ rg_track_gain: 51, rg_track_peak: 0.2 }, track);
  assert.equal(boost.gain, gain(12));
  assert.match(boost.title, /limited to \+12 dB/);
  assert.equal(computerLevelling({ rg_track_gain: 51, rg_track_peak: 16 }, track).gain, 1 / 16);
  assert.deepEqual(computerLevelling({ rg_track_gain: -2 }, track), { gain: 1 });
  assert.deepEqual(computerLevelling({ rg_track_peak: 1.5 }, track), { gain: 1 });
  assert.deepEqual(computerLevelling({ rg_album_gain }, { ...album, volumeLevelling: 'off' }), { gain: 1 });

  assert.deepEqual(loudnessFields({
    rg_track_gain: '-3', rg_track_peak: 0, rg_album_gain: -52, rg_album_peak: Infinity, rg_measured: true,
  }), {});
  assert.deepEqual(loudnessFields({ rg_track_gain: 0, rg_track_peak: 16, rg_measured: false }), {
    rg_track_gain: 0, rg_track_peak: 16,
  });
});

test('the Now Playing format suffix describes the applied measurement', () => {
  const file = makeComputerItem({
    id: 'format', kind: 'audio', ext: 'flac', rg_track_gain: -5, rg_track_peak: 1, rg_measured: true,
  });
  const levelling = computerLevelling(file._extra.computer, { volumeLevelling: 'album' });
  assert.deepEqual(detailRows(file, { levelling })[0], [
    'Format', 'FLAC \u00b7 -5 dB', 'Volume levelling: track gain -5 dB (measured), pre-amp 0 dB',
  ]);
  assert.deepEqual(detailRows(file)[0], ['Format', 'FLAC']);
});

test('loudness retries only one retryable 503 after five seconds and cancels pending retries', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const attempts = [];
  const results = [];
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
  const busy = { status: 503, retryable: true };
  const requests = createLoudnessRequests({
    measure: async (id, { signal }) => {
      attempts.push({ id, signal });
      if (id === 'unavailable') throw { status: 422, retryable: true };
      if (id === 'closing') throw { status: 503, retryable: false };
      if (id !== 'success' || attempts.filter((attempt) => attempt.id === id).length < 2) throw busy;
      return { id, rg_track_gain: -3, rg_track_peak: 0.9, rg_measured: false };
    },
    onResult: (entry, fields) => results.push([entry.id, fields]),
  });

  const success = { id: 'success' };
  requests.request(success);
  requests.request(success);
  await settle();
  t.mock.timers.tick(4_999);
  await settle();
  assert.deepEqual(attempts.map(({ id }) => id), ['success']);
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(results, [['success', { rg_track_gain: -3, rg_track_peak: 0.9 }]]);
  assert.deepEqual(requests.resultFor(success), results[0][1]);
  assert.equal(attempts[0].signal, attempts[1].signal);

  requests.retain();
  for (const id of ['unavailable', 'closing', 'busy', 'cancelled']) requests.request({ id });
  await settle();
  requests.retain('unavailable', 'closing', 'busy');
  assert.equal(attempts.at(-1).signal.aborted, true);
  t.mock.timers.tick(5_000);
  await settle();
  t.mock.timers.tick(5_000);
  await settle();
  assert.deepEqual(attempts.map(({ id }) => id), [
    'success', 'success', 'unavailable', 'closing', 'busy', 'cancelled', 'busy',
  ]);
  assert.equal(results.length, 1);
});

test('catalog holds a measurement through an older delta, agrees with confirmation and drops it on file replacement', async () => {
  const file = { id: 'track', kind: 'audio', size: 1, mtime: 1, revision: 1 };
  const fields = { rg_track_gain: -7, rg_track_peak: 0.9, rg_measured: true };
  const snapshot = { items: [file], generation: 1, revision: 1 };
  let reply = snapshot;
  const library = createComputerLibrary({
    loadComputerLibrary: async () => reply,
    startComputerScan: async () => ({ scanning: false }),
  });
  await library.openComputerLibrary();
  try {
    let resolve;
    reply = new Promise((r) => { resolve = r; });
    const older = library.refreshAvailability();
    library.acceptLoudness(file, fields);
    const patched = library.getComputerLibrary().items[0];
    assert.deepEqual(patched, { ...file, ...fields });

    resolve({ ...snapshot, delta: true, revision: 2 });
    await older;
    assert.equal(library.getComputerLibrary().items[0], patched);

    reply = { ...snapshot, delta: true, revision: 3, items: [{ ...file, ...fields, revision: 3 }] };
    await library.refreshAvailability();
    assert.deepEqual(library.getComputerLibrary().items[0], reply.items[0]);

    reply = { ...snapshot, delta: true, revision: 4, items: [{ ...file, mtime: 2, revision: 4 }] };
    await library.refreshAvailability();
    library.acceptLoudness(file, fields);
    assert.deepEqual(library.getComputerLibrary().items[0], reply.items[0]);
  } finally {
    library.closeComputerLibrary();
  }
});

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test('levelling defaults to Off and round-trips through extra profile settings', async () => {
  const oldStorage = globalThis.localStorage;
  const oldSettings = getState().settings;
  const storage = memoryStorage();
  try {
    globalThis.localStorage = storage;
    await initState();
    assert.equal(getState().settings.volumeLevelling, 'off');
    assert.equal(getState().settings.levellingPreamp, 0);
    assert.equal(normalizeSettings({ volumeLevelling: 'track', levellingPreamp: -20 }).levellingPreamp, -12);
    assert.equal(normalizeSettings({ volumeLevelling: ['track'], levellingPreamp: '2' }).volumeLevelling, 'off');

    storage.setItem(EXTRA_SETTINGS_STORAGE_KEY, JSON.stringify({ tunerStations: false, futureSetting: 1 }));
    saveSettings({ volumeLevelling: 'album', levellingPreamp: 2 });
    const legacy = JSON.parse(storage.getItem(STORAGE_KEYS.settings));
    assert.equal(Object.hasOwn(legacy, 'volumeLevelling'), false);
    assert.equal(Object.hasOwn(legacy, 'levellingPreamp'), false);
    assert.deepEqual(JSON.parse(storage.getItem(EXTRA_SETTINGS_STORAGE_KEY)), {
      tunerStations: false, futureSetting: 1, volumeLevelling: 'album', levellingPreamp: 2,
    });

    let values;
    await saveProfileHandoff({ storage, requestImpl: async (_path, { body }) => { ({ values } = body); } });
    const restored = memoryStorage();
    assert.equal(await restoreProfileHandoff({ storage: restored, requestImpl: async () => ({ values }) }), true);
    globalThis.localStorage = restored;
    await initState();
    assert.equal(getState().settings.volumeLevelling, 'album');
    assert.equal(getState().settings.levellingPreamp, 2);
    assert.equal(getState().settings.tunerStations, false);
  } finally {
    globalThis.localStorage = oldStorage;
    getState().settings = oldSettings;
  }
});
