import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { dialCanTurn } from '../src/modes/tuner.js';
import { stationListWindow, tunedScrollTop } from '../src/modes/tuner-station-list.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('every tuned index fits a whole-row window without padding either end', () => {
  for (let count = 0; count <= 50; count++) for (const columns of [1, 2]) {
    for (const row of [56, 68, 84]) for (let capacity = 2; capacity <= 14; capacity++) {
      const rows = Math.ceil(count / columns);
      const height = Math.max(0, Math.min(capacity, rows) * (row + 8) - 8);
      const { stride, total } = stationListWindow(count, row, height, 0, columns);
      assert.equal(total, Math.max(0, rows * stride - 8));
      for (let index = 0; index < Math.max(1, count); index++) {
        const top = tunedScrollTop(index, columns, stride, height, total);
        assert.equal(top % stride, 0);
        if (!index) assert.equal(top, 0);
        if (index === count - 1) assert.equal(top + height, total);
        if (!count) continue;
        const y = Math.floor(index / columns) * stride - top;
        assert.ok(y >= 0 && y + row <= height);
        const { start, end } = stationListWindow(count, row, height, top, columns);
        assert.ok(start <= index && index < end);
        assert.equal(start % columns, 0);
        assert.ok(end - start <= (capacity + 4) * columns);
      }
    }
  }
});

test('the dial glows on hover only when the wheel can turn it', async () => {
  assert.equal(dialCanTurn(0), false);
  assert.equal(dialCanTurn(1), false);
  assert.equal(dialCanTurn(2), true);
  const tuner = await read('src/modes/tuner.js');
  // Kept current by the one helper that changes the station list.
  assert.match(tuner, /function setStations\(stations\) \{\s+state\.stations = stations;\s+ui\.dialWrap\?\.classList\.toggle\('can-turn', dialCanTurn\(stations\.length\)\);\s+\}/);
  const assignments = tuner.match(/state\.stations = /g) || [];
  assert.equal(assignments.length, 1, 'state.stations is only assigned inside setStations');
  assert.equal((tuner.match(/setStations\(/g) || []).length, 7);
  // The wheel is bound on the same element that glows.
  assert.match(tuner, /const dialWrap = el\('div', \{ className: 'tuner-dial' \}\);[\s\S]*?ui\.dialWrap = dialWrap;/);
  assert.match(tuner, /wrap\.addEventListener\('wheel', onWheel, \{ passive: false \}\);/);
  const css = await read('src/styles/tuner.css');
  const dial = css.match(/\.tuner-dial \{[^}]*\}/)[0];
  // Round, so the glow and the wheel area follow the circle.
  assert.match(dial, /border-radius: 50%;/);
  assert.match(dial, /overflow: hidden;/);
  assert.match(dial, /transition: [^;]*\bbox-shadow 0\.15s ease(?:,|;)/);
  assert.match(dial, /transition: [^;]*\bleft 180ms ease, top 180ms ease/);
  assert.match(css, /\.tuner-tone-knob \{[^}]*transition: left 180ms ease, top 180ms ease;/);
  assert.match(css, /@media \(hover: hover\) \{\s+\.tuner-dial\.can-turn:hover \{\s+box-shadow:/);
  // No border or padding, so the dial does not change size.
  assert.doesNotMatch(css, /\.tuner-dial[^{]*:hover \{[^}]*(border|padding|width)/);
});
