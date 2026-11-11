import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { alreadyPlaying, dialCanTurn, restingRotation } from '../src/modes/tuner.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('a dial with one station has nowhere to turn', () => {
  assert.equal(dialCanTurn(0), false);
  assert.equal(dialCanTurn(1), false);
  assert.equal(dialCanTurn(2), true);
  assert.equal(dialCanTurn(80), true);
});

test('the station that is playing is recognised so it is not restarted', () => {
  const station = { id: 'radio:1' };
  assert.equal(alreadyPlaying(station, { isPlaying: true, currentItem: { id: 'radio:1' } }), true);
  // Not playing (stopped, failed, still loading): tuning to it should start it.
  assert.equal(alreadyPlaying(station, { isPlaying: false, currentItem: { id: 'radio:1' } }), false);
  assert.equal(alreadyPlaying(station, { isPlaying: true, currentItem: { id: 'radio:2' } }), false);
  assert.equal(alreadyPlaying(station, { isPlaying: true, currentItem: null }), false);
  assert.equal(alreadyPlaying(null, { isPlaying: true, currentItem: { id: 'radio:1' } }), false);
});

test('drag, wheel and arrow keys leave a one-station dial fixed', async () => {
  const tuner = await read('src/modes/tuner.js');
  // Drag and wheel do not rotate the dial.
  assert.match(tuner, /if \(!dragging \|\| !dialCanTurn\(state\.stations\.length\)\) return;/);
  assert.match(tuner, /e\.preventDefault\(\);\s+if \(!dialCanTurn\(state\.stations\.length\)\) return;\s+const steps = wheelSteps/);
  // Arrow keys and "skip" do not rotate it either, and only start the station
  // when it is not already playing.
  const step = tuner.match(/function step\(dir\) \{[\s\S]*?\n\}/)[0];
  assert.match(step, /if \(!dialCanTurn\(state\.stations\.length\)\) \{\s+tuneCurrent\(\{ restart: false \}\);\s+return;\s+\}\s+state\.rotationDeg \+= dir \* 12;/);
  // Releasing the dial on the station it started on does not restart it.
  assert.match(tuner, /tuneCurrent\(\{ restart: state\.index !== downIndex \}\);/);
  assert.match(tuner, /if \(!restart && alreadyPlaying\(s, getState\(\)\)\) return;/);
});

test('playlist wording names both accepted file types', async () => {
  const drop = await read('src/lib/playlist-drop.js');
  assert.match(drop, /Drop a playlist file \(\.m3u or \.m3u8\) to import it into My Playlists/);
  const controls = await read('src/modes/library/personal-controls.js');
  assert.match(controls, /text: 'Import playlist'/);
  assert.match(controls, /Import a local \.m3u or \.m3u8 channel list\./);
  assert.match(controls, /accept: '\.m3u,\.m3u8'/);
});

test('the dial fits a short window and its station name stays inside the knob', async () => {
  const css = await read('src/styles/tuner.css');
  // Sized from the stage's height as well as its width, so it is never cut off.
  assert.match(css, /\.tuner-stage \{[^}]*container-type: size;/);
  assert.match(css, /\.tuner-dial \{\s+width: min\(540px, 78cqw, 100cqh\);/);
  assert.match(css, /width: min\(420px, 92vw, 100cqh\);/);
  // The knob is half the dial wide; the name is held just inside that.
  assert.match(css, /\.tuner-dial \{[^}]*container-type: inline-size;/);
  assert.match(css, /max-width: min\(220px, 46cqw\);/);
  assert.match(css, /max-width: min\(170px, 46cqw\);/);
});

test('the knob rests at the same angle for the same station', async () => {
  assert.equal(restingRotation(0), 0);
  assert.equal(restingRotation(4), 48);
  assert.equal(restingRotation(24), 288);
  const tuner = await read('src/modes/tuner.js');
  // Settled after a wheel notch, an arrow-key step, and letting go of a drag.
  assert.match(tuner, /state\.rotationDeg = \(state\.index \+ steps\) \* 12;\s+applyRotation\(\);\s+settleDial\(\);/);
  assert.match(tuner, /state\.rotationDeg \+= dir \* 12;\s+applyRotation\(\);\s+settleDial\(\);\s+tuneCurrent\(\);/);
  assert.match(tuner, /wrap\.classList\.remove\('dragging'\);\s+settleDial\(\);/);
  assert.match(tuner, /state\.rotationDeg = restingRotation\(state\.index\);/);
  // The centre dot that sat behind the station number is gone.
  assert.doesNotMatch(tuner, /<circle cx="200" cy="200" r="6"/);
});

test('the player bar shows initials behind the artwork', async () => {
  const html = await read('src/index.html');
  assert.match(html, /<div class="player-art-box">\s+<span id="player-art-initials" class="player-art-initials" aria-hidden="true" hidden><\/span>\s+<img id="player-art" alt="" \/>/);
  const player = await read('src/lib/player.js');
  assert.match(player, /setMetaText\(item\);\s+setArtInitials\(item\);/);
  assert.match(player, /node\.hidden = !initials;/);
  const css = await read('src/styles/base.css');
  assert.match(css, /\.player-art-initials\[hidden\] \{ display: none; \}/);
  assert.match(css, /\.modal input\[type="number"\] \{/);
});
