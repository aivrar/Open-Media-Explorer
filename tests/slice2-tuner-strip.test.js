import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { centeredScrollLeft, dialCanTurn } from '../src/modes/tuner.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

// Lays the strip out the way tuner.css does: 16 px padding each side, 6 px gaps,
// and a spacer half the content width at both ends of the rendered window.
function stripLayout({ width, count, index, pillWidth }) {
  const pad = 16;
  const gap = 6;
  const span = 15;
  const start = Math.max(0, index - span);
  const end = Math.min(count, index + span + 1);
  const spacer = (width - pad * 2) / 2;
  const items = [{ w: spacer }];
  for (let i = start; i < end; i++) items.push({ w: pillWidth(i), i });
  items.push({ w: spacer });
  let x = pad;
  let active = null;
  for (const item of items) {
    if (item.i === index) active = { left: x, width: item.w };
    x += item.w + gap;
  }
  const scrollWidth = x - gap + pad;
  return { active, maxScroll: Math.max(0, scrollWidth - width) };
}

function centreOf({ width, count, index, pillWidth }) {
  const { active, maxScroll } = stripLayout({ width, count, index, pillWidth });
  const target = centeredScrollLeft({
    stripLeft: 0, stripWidth: width, scrollLeft: 0, pillLeft: active.left, pillWidth: active.width,
  });
  const raw = active.left - (width - active.width) / 2;
  return { target, raw, maxScroll };
}

test('every station can scroll to the middle, including the first and the last', () => {
  const widths = [
    () => 90,
    (i) => 60 + (i * 37) % 180, // mixed card widths
  ];
  const cases = [
    { count: 1, indexes: [0] },
    { count: 2, indexes: [0, 1] },
    { count: 3, indexes: [0, 1, 2] },
    { count: 64, indexes: [0, 1, 14, 15, 16, 31, 47, 48, 62, 63] },
  ];
  for (const width of [420, 900, 1600]) {
    for (const pillWidth of widths) {
      for (const { count, indexes } of cases) {
        for (const index of indexes) {
          const { target, raw, maxScroll } = centreOf({ width, count, index, pillWidth });
          const where = `width ${width}, ${count} stations, index ${index}`;
          // Never held back at the start, and never asks for more than the strip can scroll.
          assert.ok(raw >= 0, `${where}: cannot reach the centre from the start`);
          assert.ok(target <= maxScroll, `${where}: cannot reach the centre at the end`);
        }
      }
    }
  }
});

test('a short-named station just past the window edge still centres in a wide strip', () => {
  // At index 16 the window starts at station 1; the 15 short cards to its left
  // are narrower than half of a 2400 px strip, so the end room must stay.
  const { target, raw, maxScroll } = centreOf({ width: 2400, count: 64, index: 16, pillWidth: () => 48 });
  assert.ok(15 * (48 + 6) < 2400 / 2);
  assert.ok(raw >= 0);
  assert.ok(target <= maxScroll);
});

test('the strip always has room at both ends, except around the empty-list message', async () => {
  const tuner = await read('src/modes/tuner.js');
  assert.doesNotMatch(tuner, /at-start|at-end/);
  const css = await read('src/styles/tuner.css');
  assert.match(css, /\.tuner-strip:not\(:has\(> \.tuner-empty\)\)::before,\s+\.tuner-strip:not\(:has\(> \.tuner-empty\)\)::after \{\s+content: '';\s+flex: 0 0 50%;\s+\}/);
  assert.doesNotMatch(css, /at-start|at-end/);
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
  assert.match(dial, /transition: box-shadow 0\.15s ease;/);
  assert.match(css, /@media \(hover: hover\) \{\s+\.tuner-dial\.can-turn:hover \{\s+box-shadow:/);
  // No border or padding, so the dial does not change size.
  assert.doesNotMatch(css, /\.tuner-dial[^{]*:hover \{[^}]*(border|padding|width)/);
});
