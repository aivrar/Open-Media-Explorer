import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = async (path) => (await readFile(new URL(`../${path}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`));
  assert.ok(match, selector);
  return match[1];
}

test('a loaded picture with clear parts never shows the initials through it, in the player bar, Now Playing and the cards', async () => {
  const base = await read('src/styles/base.css');
  const nowPlaying = await read('src/styles/now-playing.css');
  const library = await read('src/styles/library.css');
  const tuner = await read('src/styles/tuner.css');
  const player = await read('src/lib/player.js');

  // Player bar: a plain surface under the picture, which is invisible until
  // it has loaded (so the initials show while there is none).
  assert.match(rule(base, '#player-art'), /background: var\(--bg-elev-3\);/);
  assert.match(player, /const clearArt = \(\) => \{[\s\S]*?elements\.art\.style\.opacity = '0';/);
  assert.match(player, /elements\.art\.onload = \(\) => \{[\s\S]*?elements\.art\.style\.opacity = '1';/);
  // The user's own station picture keeps showing the bar around it.
  assert.match(rule(base, '#player-art.is-station-image'), /background: transparent;/);
  assert.ok(base.indexOf('#player-art.is-station-image {') > base.indexOf('#player-art {'));

  // Now Playing: the same, and a logo keeps its own surface.
  const npImg = rule(nowPlaying, '.np-art-img');
  assert.match(npImg, /opacity: 0;/);
  assert.match(npImg, /background: var\(--bg-elev-3\);/);
  assert.match(rule(nowPlaying, '.np-art-img.is-station-image'), /background: transparent;/);
  assert.match(nowPlaying, /\.np-art\.is-logo \.np-art-img\.loaded:not\(\.is-station-image\) \{[^}]*background:/);

  // The Library and Tuner cards already draw every logo on a plain surface.
  assert.match(rule(library, '.card-thumb img.logo-art'), /background:\s*\n?\s*radial-gradient/);
  assert.match(rule(tuner, '.pill-art-img'), /background: var\(--bg-elev-3\);/);
});
