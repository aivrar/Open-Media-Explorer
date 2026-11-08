import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { artworkInitials, initialsHue } from '../src/lib/initials.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('initials read like the station name', () => {
  const cases = {
    'France Info': 'FI',
    'BBC Radio 1': 'BBC',
    'SWR3': 'SWR3',
    'NHK World': 'NHK',
    'Radio Paradise - Main Mix': 'RP',
    'The Jazz Groove': 'JG',
    'jazz': 'JA',
    '1LIVE': '1L',
    'Ö1': 'Ö1',
    'Радио Рекорд': 'РР',
    '★ ~~ ': '',
    '': '',
  };
  for (const [title, expected] of Object.entries(cases)) {
    assert.equal(artworkInitials(title), expected, title);
  }
  assert.equal(artworkInitials(undefined), '');
});

test('each title keeps the same colour', () => {
  assert.equal(initialsHue('France Info'), initialsHue('France Info'));
  assert.notEqual(initialsHue('France Info'), initialsHue('BBC Radio 1'));
  for (const title of ['', 'a', 'BBC', 'Радио']) {
    const hue = initialsHue(title);
    assert.ok(Number.isInteger(hue) && hue >= 0 && hue < 360, title);
  }
});

test('cards without artwork show initials, and fall back to the type icon', async () => {
  const render = await read('src/modes/library/render.js');
  assert.match(render, /const initials = artworkInitials\(item\.title\)/);
  assert.match(render, /placeholder\.innerHTML = sourceGlyph\(item\.type\)/);
});

test('the Tuner shows list position instead of a made-up frequency', async () => {
  const tuner = await read('src/modes/tuner.js');
  assert.doesNotMatch(tuner, /87\.5\s*\+/);
  assert.doesNotMatch(tuner, /'MHz'/);
  assert.match(tuner, /ui\.freqUnit\.textContent = `of \$\{state\.stations\.length\}`/);
});

test('dial text stays light on the always-dark dial, and Shutdown is a quiet outline', async () => {
  const [tunerCss, baseCss] = await Promise.all([read('src/styles/tuner.css'), read('src/styles/base.css')]);
  const stationName = tunerCss.match(/\.tuner-frequency \.station-name \{[^}]*\}/)[0];
  assert.match(stationName, /color: var\(--dial-text\)/);
  const shutdown = baseCss.match(/\.shutdown-btn \{[^}]*\}/)[0];
  assert.match(shutdown, /background: transparent/);
  assert.doesNotMatch(shutdown, /background: var\(--danger\)/);
  assert.match(baseCss, /\.shutdown-btn:hover,[\s\S]*?color: var\(--danger\)/);
});
