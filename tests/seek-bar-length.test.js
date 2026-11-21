import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = async (path) => (await readFile(new URL(`../${path}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

test('a hidden seek bar keeps its space, so the player bar does not move (live media on a wide bar aside)', async () => {
  const css = await read('src/styles/base.css');
  assert.match(css, /\.player-seek\.is-no-length, \.player-time\.is-no-length \{ visibility: hidden; \}/);
  assert.doesNotMatch(css, /\.is-no-length[^{]*\{[^}]*display: none/);
  const player = await read('src/lib/player.js');
  // Shown with a length, and for an item listed as on demand from the press of Play on.
  assert.match(player, /const showSeek = withLength\s+\|\| \(currentItem\?\.delivery === 'on-demand' && el\.duration !== Infinity\);/);
  assert.match(player, /elements\.seek\.classList\.toggle\('is-no-length', !showSeek\);/);
  assert.match(player, /elements\.dur\.classList\.toggle\('is-no-length', !showSeek\);/);
  // Live media is marked separately: on a wide bar its layout gives the
  // seek bar's room to the name column (player-bar-start.test.js).
  assert.match(player, /elements\.seek\.classList\.toggle\('is-live', timeline\.live\);/);
  assert.doesNotMatch(player, /elements\.time\.classList/, 'the time played stays shown');
});
