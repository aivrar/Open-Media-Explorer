import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computerTrackFileKey, loadComputerTrackPrefs, preferredComputerAudio,
  preferredComputerSubtitle, rememberComputerTracks,
} from '../src/lib/computer-track-prefs.js';
import { EXTRA_SETTINGS_STORAGE_KEY } from '../src/lib/profile-storage.js';
import { captureProfileStorage, restoreProfileStorageValues } from '../src/lib/profile-transfer.js';

function makeStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}
const file = (id, mtime = 400) => computerTrackFileKey(id, { size: 100, mtime });

test('track preferences use file choices, subtitle language, then forced tracks of the actual audio language', () => {
  const storage = makeStorage();
  const original = file('film');
  const audio = [
    { index: 0, language: 'en', selected: true },
    { index: 1, language: 'de' },
    { index: 2, language: 'fr' },
  ];
  const subs = [
    { key: 'enForced', language: 'en', forced: true },
    { key: 'deForced', language: 'de', forced: true },
    { key: 'spanish', language: 'es' },
    { key: 'french', language: 'fr' },
    { key: 'unknown', language: '', forced: true },
  ];
  const pick = (key, subtitles = subs, tracks = audio) => preferredComputerSubtitle(
    loadComputerTrackPrefs(storage), key, subtitles, tracks,
  );
  rememberComputerTracks(original, { audio: 2, subtitle: 'french' }, {}, storage);
  rememberComputerTracks(file('other'), { audio: 1, subtitle: 'spanish' }, { audio: 'DE', subtitle: 'ES' }, storage);
  assert.equal(preferredComputerAudio(loadComputerTrackPrefs(storage), original, audio), 2);
  assert.equal(preferredComputerAudio(loadComputerTrackPrefs(storage), file('film', 401), audio), 1);
  assert.equal(preferredComputerAudio(loadComputerTrackPrefs(storage), file('film', 401), audio.slice(0, 1)), undefined);
  assert.equal(pick(original), 'french');
  assert.equal(pick(file('film', 401)), 'spanish');
  assert.equal(pick(file('new'), subs.slice(0, 2), [{ index: 1, language: 'DE', selected: true }]), 'deForced');
  assert.equal(pick(file('new'), subs.slice(1, 2)), '');
  assert.equal(pick(file('new'), [subs.at(-1)], [{ index: 0, language: '', selected: true }]), '');
  assert.equal(pick(original, subs.slice(0, 3)), 'spanish', 'a vanished key falls back to language');
  rememberComputerTracks(original, { subtitle: '' }, { subtitle: '' }, storage);
  assert.equal(pick(original), '', 'remembered Off beats a matching forced track');
  assert.equal(pick(file('new')), 'enForced', 'Off also clears the general subtitle language');
  assert.equal(loadComputerTrackPrefs(storage).audioLanguage, 'de');
});

test('track choices are bounded by recency and survive portable profile export and import', () => {
  const storage = makeStorage();
  const legacy = 'worldmedia.settings.v1';
  storage.setItem(legacy, '{"theme":"dark"}');
  storage.setItem(EXTRA_SETTINGS_STORAGE_KEY, '{"tunerToneKnobs":true}');
  for (let i = 0; i < 500; i++) rememberComputerTracks(file(String(i)), { audio: i }, {}, storage);
  rememberComputerTracks(file('0'), { subtitle: 'captions' }, { subtitle: 'en' }, storage);
  rememberComputerTracks(file('new'), { audio: 0, subtitle: '' }, {}, storage);
  const prefs = loadComputerTrackPrefs(storage);
  assert.equal(prefs.files.size, 500);
  assert.equal(prefs.files.has(file('1')), false);
  assert.deepEqual(prefs.files.get(file('0')), { audio: 0, subtitle: 'captions' });
  assert.deepEqual(prefs.files.get(file('new')), { audio: 0, subtitle: '' });
  const exported = captureProfileStorage(storage);
  assert.equal(exported[legacy], '{"theme":"dark"}');
  assert.equal(JSON.parse(exported[EXTRA_SETTINGS_STORAGE_KEY]).tunerToneKnobs, true);
  const restored = makeStorage();
  restoreProfileStorageValues(exported, restored);
  assert.deepEqual(loadComputerTrackPrefs(restored), prefs);
});
