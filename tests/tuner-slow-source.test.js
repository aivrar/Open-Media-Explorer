import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { SLOW_MIRROR_MS, mirrorTooSlow } from '../src/adapters/radio-browser.js';
import { emptyLiveText } from '../src/modes/tuner.js';
import { LIVE_SOURCE_TIMEOUT_MS } from '../src/lib/live-load.js';
import { CHECK_LOOKUP_MS } from '../src/lib/best-stream-auto.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('a directory mirror that stayed silent until the caller gave up is dropped; one cut short early is kept', async () => {
  assert.equal(mirrorTooSlow(1_000, 1_000), false);
  assert.equal(mirrorTooSlow(1_000, 1_000 + SLOW_MIRROR_MS - 1), false);
  assert.equal(mirrorTooSlow(1_000, 1_000 + SLOW_MIRROR_MS), true);
  // The Tuner's and the Grid's time limit for a source, and the background
  // check's, are long enough to tell a slow mirror; a quick cancel is not.
  assert.ok(SLOW_MIRROR_MS < LIVE_SOURCE_TIMEOUT_MS);
  assert.ok(SLOW_MIRROR_MS < CHECK_LOOKUP_MS);
  assert.equal(mirrorTooSlow(0, 4_000), false, 'a station changed after four seconds keeps the mirror');
  assert.equal(mirrorTooSlow(0, LIVE_SOURCE_TIMEOUT_MS), true, 'a source that ran out its time limit');
  // The time is counted from the request itself, after a mirror was found.
  const source = (await read('src/adapters/radio-browser.js')).replace(/\r\n/g, '\n');
  assert.match(source, /const base = await awaitWithSignal\(resolveBase\(failedBase\), opts\.signal\);\n\s*\/\/[^\n]*\n\s*if \(base === failedBase\) break;\n\s*const askedAt = Date\.now\(\);\n\s*try \{/);
});

test('an empty Tuner says the stations could not be loaded when a source did not answer', () => {
  const states = (...values) => new Map(values.map((state, index) => [`source-${index}`, { state, count: 0 }]));
  assert.equal(emptyLiveText(true, states('loading')), 'Loading stations\u2026');
  assert.equal(emptyLiveText(true, states('error')), 'Loading stations\u2026');
  assert.equal(emptyLiveText(false, states('ready', 'ready')), 'No stations found for this country.');
  assert.equal(emptyLiveText(false, new Map()), 'No stations found for this country.');
  assert.equal(emptyLiveText(false, null), 'No stations found for this country.');
  const failed = emptyLiveText(false, states('ready', 'ready', 'error'));
  assert.match(failed, /could not be loaded/);
  assert.match(failed, /Press Radio or TV above to try again\./);
  assert.doesNotMatch(failed, /country/);
});

test('the band buttons reload the dial, also the band already chosen', async () => {
  const tuner = (await read('src/modes/tuner.js')).replace(/\r\n/g, '\n');
  const setBand = tuner.slice(tuner.indexOf('function setBand(b) {'), tuner.indexOf('function renderStrip() {'));
  assert.match(setBand, /\n {2}loadStations\(\);\n\}/);
  assert.doesNotMatch(setBand, /if \(state\.band === b\) return/);
  assert.match(tuner, /\{ id: 'radio', label: 'Radio' \}, \{ id: 'tv', label: 'TV' \}/);
  assert.match(tuner, /let text = emptyLiveText\(state\.loading, state\.sourceStates,\n\s+\{ waiting: autoRetry\.waiting\(\), tries: autoRetry\.tries\(\) \}\);/);
});
