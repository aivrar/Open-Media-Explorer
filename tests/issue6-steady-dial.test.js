import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/* Issue #6: tuning through "All live sources" made the dial grow and shrink
   by 2 px around a few stations. A name in another script (seen with
   "CNR-1 \u4e2d\u56fd\u4e4b\u58f0") is drawn with a fallback font whose
   "normal" line is taller, so its strip card grew from 39 to 41 px, every card
   stretched with it, the strip grew 2 px and the stage (and the dial, sized
   from the stage's height) lost 2 px while that station was in the strip. */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const block = (css, selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\n|\\})\\s*${escaped} \\{([^}]*)\\}`));
  assert.ok(match, `no rule for ${selector}`);
  return match[1];
};
const px = (body, property) => {
  const match = body.match(new RegExp(`(?:^|[;\\s])${property}: (\\d+)px;`));
  assert.ok(match, `${property} is not a fixed px value`);
  return Number(match[1]);
};

test('every strip card has the same height whatever script its name is in', async () => {
  const css = await read('src/styles/tuner.css');
  const pill = block(css, '.station-pill');
  const small = block(css, '.station-pill > small');
  // No "normal" line height left for a fallback font to stretch.
  assert.doesNotMatch(css, /line-height: normal/);
  const nameLine = px(pill, 'line-height');
  const sourceLine = px(small, 'line-height');
  assert.match(pill, /box-sizing: border-box;/);
  // The fixed height is exactly what the two lines need, so nothing is cut
  // and a usual card keeps the 39 px it had.
  const [vertical] = pill.match(/padding: (\d+)px \d+px;/).slice(1).map(Number);
  const border = Number(pill.match(/border: (\d+)px solid/)[1]);
  const rowGap = Number(pill.match(/gap: (\d+)px \d+px;/)[1]);
  assert.equal(px(pill, 'height'), 39);
  assert.equal(vertical * 2 + border * 2 + nameLine + rowGap + sourceLine, 39);
  // The content-rating badge spans both lines and fits inside them.
  assert.match(css, /\.station-pill > \.content-rating-badge \{ grid-column: 2; grid-row: 1 \/ span 2; \}/);
  const library = await read('src/styles/library.css');
  const badge = block(library, '.content-rating-badge');
  const badgeHeight = 10 * 1.2 + 3 * 2 + 1 * 2;
  assert.match(badge, /font-size: 10px;[\s\S]*line-height: 1\.2;/);
  assert.match(badge, /padding: 3px 7px;\s+border: 1px solid/);
  assert.ok(badgeHeight <= nameLine + rowGap + sourceLine);
});

test('a card holds only its name, its source and an optional badge', async () => {
  const tuner = await read('src/modes/tuner.js');
  const strip = tuner.match(/function renderStrip\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(strip, /const sourceLine = el\('small', \{ text: getSourceLabel\(s\.source\) \}\);/);
  assert.match(strip, /el\('span', \{ text: saved \? `\u2605 \$\{s\.title\}` : s\.title \}\),\s+sourceLine,\s+rating \? el\('span', \{ className: 'content-rating-badge', text: rating \}\) : null\);/);
  // The stream's format and bitrate go inside the source line, not in a row of their own.
  const stream = tuner.match(/function setPillStream\(pill\) \{[\s\S]*?\n\}/)[0];
  assert.match(stream, /pill\.__sourceLine\.appendChild\(node\);/);
  // And, laid over its corner, the "Did not play last time" mark: added last
  // (also when it comes later), so it takes no place in the card's grid.
  assert.match(strip, /setPillTrouble\(pill\);\s+ui\.strip\.appendChild\(pill\);/);
  const mark = tuner.match(/function setPillTrouble\(pill\) \{[\s\S]*?\n\}/)[0];
  assert.match(mark, /mark = el\('span', \{ className: 'pill-trouble', text: '!', attrs: \{ role: 'img' \} \}\);\s*pill\.appendChild\(mark\);/);
  assert.match(mark, /mark\.setAttribute\('aria-label', trouble\);/);
  // Names stay on one line.
  assert.match(block(await read('src/styles/tuner.css'), '.station-pill'), /white-space: nowrap;/);
});

test('the status line under the strip stays one line', async () => {
  const css = await read('src/styles/tuner.css');
  const status = block(css, '.tuner-source-status');
  assert.match(status, /white-space: nowrap;/);
  assert.match(status, /overflow: hidden;/);
  assert.match(status, /text-overflow: ellipsis;/);
  assert.match(status, /min-height: 26px;/);
});

test('the dial is still sized from its stage, which the other rows no longer change', async () => {
  const css = await read('src/styles/tuner.css');
  assert.match(css, /\.tuner-root \{\s+display: grid;\s+grid-template-rows: auto minmax\(0, 1fr\) auto auto;/);
  assert.match(css, /\.tuner-dial \{\s+width: min\(540px, 78cqw, 100cqh\);/);
  // The knob text is laid over the dial and cannot change its size.
  assert.match(block(css, '.tuner-frequency'), /position: absolute;/);
  assert.match(block(css, '.tuner-frequency .station-name'), /white-space: nowrap;\s+overflow: hidden;\s+text-overflow: ellipsis;/);
  // The player bar's row is a fixed height, so a song title cannot move it.
  const base = await read('src/styles/base.css');
  assert.match(base, /#app\.has-player \{\s+grid-template-rows: auto minmax\(0, 1fr\) var\(--player-h\);/);
});

test('the dial keeps its size when the player bar appears on the first play', async () => {
  const css = await read('src/styles/tuner.css');
  // Without a player bar the Tuner leaves the bar's room free, so the stage
  // (and the dial sized from it) is as tall before the first play as after.
  const idle = block(css, '#app:not(.has-player) .tuner-root');
  assert.match(idle, /box-sizing: border-box;/);
  assert.match(idle, /padding-bottom: var\(--player-h\);/);
});

test('the strip is as tall with a message as with cards', async () => {
  const css = await read('src/styles/tuner.css');
  const strip = block(css, '.tuner-strip');
  // border-top 1 + padding 12 + 12 + card 39 + scrollbar 6
  assert.match(strip, /box-sizing: border-box;/);
  assert.match(strip, /padding: 12px 16px;/);
  assert.match(strip, /border-top: 1px solid/);
  assert.equal(px(strip, 'min-height'), 1 + 12 + 12 + 39 + 6);
  assert.match(css, /\.tuner-strip::-webkit-scrollbar \{ height: 6px; \}/);
  // Narrow layout: padding 10 + 10.
  assert.match(css, /\.tuner-strip \{\s+padding: 10px 12px;\s+min-height: 66px;\s+\}/);
});
