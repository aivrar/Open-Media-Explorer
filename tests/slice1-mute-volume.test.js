import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { isSilent, volumeText } from '../src/lib/player.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('the player is silent when muted or when the volume is at zero', () => {
  assert.equal(isSilent(false, 80), false);
  assert.equal(isSilent(false, 1), false);
  assert.equal(isSilent(true, 80), true);
  assert.equal(isSilent(false, 0), true);
  assert.equal(isSilent(true, 0), true);
  // A sliver of volume that the slider shows as 0 counts as silent.
  assert.equal(isSilent(false, 0.3), true);
});

test('the volume reads as a rounded percentage', () => {
  assert.equal(volumeText(80), '80%');
  assert.equal(volumeText(0), '0%');
  assert.equal(volumeText(100), '100%');
  assert.equal(volumeText(54.6), '55%');
  assert.equal(volumeText(80.00000000000001), '80%');
  assert.equal(volumeText(-5), '0%');
  assert.equal(volumeText(140), '100%');
});

test('the mute button carries a speaker and a crossed speaker swapped by the silent state', async () => {
  const html = await read('src/index.html');
  assert.match(html, /id="player-mute"[^>]*aria-pressed="false" data-silent="false"/);
  const button = html.match(/<button id="player-mute"[\s\S]*?<\/button>/)[0];
  assert.match(button, /<svg class="icon-sound" viewBox="0 0 24 24"[^>]*aria-hidden="true">/);
  assert.match(button, /<svg class="icon-silent" viewBox="0 0 24 24"[^>]*aria-hidden="true">/);
  // The default of 80 is unchanged.
  // The hidden input still holds the level the stepper shows.
  assert.match(html, /<input id="player-volume" type="range" min="0" max="100" value="80" aria-label="Volume" hidden \/>/);
  const css = await read('src/styles/base.css');
  assert.match(css, /#player-mute \.icon-silent,\s+#player-mute\[data-silent="true"\] \.icon-sound \{ display: none; \}/);
  assert.match(css, /#player-mute\[data-silent="true"\] \.icon-silent \{ display: block; \}/);
});

test('volume, mute and startup all keep the icon and the volume text up to date', async () => {
  const player = await read('src/lib/player.js');
  const sync = player.match(/function syncVolumeUi\(\) \{[\s\S]*?\n\}/)[0];
  // Read from the slider, not the media element, which a sleep-timer fade lowers.
  assert.match(sync, /const pct = Number\(elements\.vol\.value\);/);
  assert.doesNotMatch(sync, /elements\.(audio|video)\.volume/);
  assert.match(sync, /elements\.vol\.title = `Volume \$\{text\}`;/);
  assert.match(sync, /elements\.vol\.setAttribute\('aria-valuetext', text\);/);
  assert.match(sync, /elements\.mute\.dataset\.silent = isSilent\(elements\.audio\.muted, pct\)/);
  // aria-pressed still means "muted" only.
  assert.doesNotMatch(sync, /aria-pressed/);
  const setVolume = player.match(/export function setVolume\(pct\) \{[\s\S]*?\n\}/)[0];
  assert.match(setVolume, /syncVolumeUi\(\);/);
  const setMuted = player.match(/export function setMuted\(m\) \{[\s\S]*?\n\}/)[0];
  assert.match(setMuted, /elements\.mute\.setAttribute\('aria-pressed', muted \? 'true' : 'false'\);\s+syncVolumeUi\(\);/);
  // At startup the restored volume is applied before setMuted syncs the UI.
  assert.match(player, /elements\.vol\.value = String\(startVol\);\s+setMuted\(false\);/);
});
