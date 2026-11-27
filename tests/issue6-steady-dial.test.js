import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const block = (css, selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = [...css.matchAll(new RegExp(`(?:^|\\n|\\})${escaped} \\{([^}]*)\\}`, 'g'))].at(-1);
  assert.ok(match, `no rule for ${selector}`);
  return match[1];
};
test('station names cannot stretch the fixed-size list rows', async () => {
  const css = await read('src/styles/tuner.css');
  const pill = block(css, '.station-pill');
  assert.match(pill, /width: 100%;\s*height: var\(--station-row-height\);/);
  assert.match(pill, /line-height: var\(--card-name-line, 15px\);/);
  assert.match(block(css, '.tuner-station-name'), /-webkit-line-clamp: 2;/);
  assert.match(block(css, '.station-pill small'), /white-space: nowrap;/);
});

test('the caption sits below the list without sizing the dial row', async () => {
  const css = await read('src/styles/tuner.css');
  const caption = block(css, '.tuner-list-caption');
  assert.match(caption, /position: absolute;/);
  assert.match(caption, /line-height: 16px;/);
  assert.match(caption, /-webkit-line-clamp: 2;/);
  assert.doesNotMatch(caption, /white-space: nowrap;/);
});

test('the dial is still sized from its stage, which the other rows no longer change', async () => {
  const css = await read('src/styles/tuner.css');
  assert.match(css, /\.tuner-root \{\s+display: grid;\s+grid-template-rows: auto minmax\(0, 1fr\);/);
  assert.match(block(css, '.tuner-dial'), /position: absolute;/);
  // The knob text is laid over the dial and cannot change its size.
  assert.match(block(css, '.tuner-frequency'), /position: absolute;/);
  assert.match(block(css, '.tuner-frequency .station-name'), /-webkit-line-clamp: 2;[\s\S]*overflow: hidden;/);
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

test('loading and empty states have the same measured viewport as station rows', async () => {
  const css = await read('src/styles/tuner.css');
  const list = block(css, '.tuner-station-list');
  assert.match(list, /position: absolute;/);
  assert.match(list, /overflow: hidden auto;/);
  assert.match(list, /scrollbar-gutter: stable;/);
  assert.match(list, /--station-scrollbar: 8px;/);
  assert.match(list, /box-sizing: content-box;/);
  assert.match(list, /padding-right: calc\(var\(--station-scrollbar\) \+ 2px\);/);
  assert.match(css, /\.tuner-station-list::-webkit-scrollbar \{\s*width: var\(--station-scrollbar\);/);
  assert.match(block(css, '.tuner-list-content'), /width: inherit;/);
  assert.match(block(css, '.tuner-empty'), /position: absolute;/);
});
