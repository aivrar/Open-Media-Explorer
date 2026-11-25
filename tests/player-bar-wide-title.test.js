import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = async (path) => (await readFile(new URL(`../${path}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

// Star, Play and Stop take 120 px. Volume takes 70 px.
const FIXED = 120 + 70;
const PADDING = 2 * 14;
const GAPS = 4 * 8;

function actionWidth(css, width) {
  const match = css.match(/\.player-bar:not\(\.is-capture-only\) \.player-actions \{\s*width: clamp\((\d+)px, (\d+)vw - (\d+)px, (\d+)px\);/);
  assert.ok(match, 'the action row reserves a width');
  const [, min, vw, offset, max] = match.map(Number);
  return Math.min(max, Math.max(min, vw / 100 * width - offset));
}

/** The name column and the seek bar column at `width` px, worked out as
 *  the grid does it from the bar's column list. */
function columns(template, width, actions) {
  const match = template.match(
    /^minmax\(clamp\((\d+)px, (\d+)vw - (\d+)px, (\d+)px\), ([\d.]+)fr\) auto auto minmax\((\d+)px, ([\d.]+)fr\) auto$/,
  );
  assert.ok(match, template);
  const [, low, vw, minus, high, metaFr, progressMin, progressFr] = match.map(Number);
  const free = width - PADDING - GAPS - FIXED - actions;
  const floor = Math.min(high, Math.max(low, (vw / 100) * width - minus));
  const share = (free * metaFr) / (metaFr + progressFr);
  const meta = Math.max(floor, share);
  const progress = Math.max(progressMin, free - meta);
  return { meta: Math.round(meta), progress: Math.round(progress), share: Math.round(share), actions };
}

test('the song in the player bar uses the room a wide window has; at 1024 and 1280 px it has its share', async () => {
  const css = await read('src/styles/base.css');
  const rule = css.match(/\n\.player-bar \{[^}]*grid-template-columns: ([^;]+);/);
  assert.ok(rule, 'the player bar lists its columns');
  const atWidth = (width) => columns(rule[1], width, actionWidth(css, width));
  // 1024 and 1280 px: the column's share of the room (the room the smaller
  // volume control gave back is shared out with the seek bar).
  for (const width of [1024, 1280]) {
    const { meta, share } = atWidth(width);
    assert.equal(meta, Math.max(190, share), `${width} px`);
  }
  assert.equal(atWidth(1024).meta, 190);
  assert.equal(atWidth(1280).meta, 250);
  // Wide windows: a column that grows with the window.
  const at1920 = atWidth(1920);
  const at2560 = atWidth(2560);
  assert.equal(at1920.meta, 680);
  assert.equal(at2560.meta, 1160);
  assert.ok(at1920.meta > at1920.share + 90, 'more than its share');
  // The seek bar and the times keep room beside it, and nothing leaves the bar.
  for (const width of [1920, 2195, 2560, 3840]) {
    const { meta, progress, actions } = atWidth(width);
    assert.ok(progress >= 400, `${width} px: ${progress} px for the seek bar and the times`);
    assert.ok(PADDING + GAPS + FIXED + actions + meta + progress <= width, `${width} px fits`);
  }
  // The narrow layout (up to 1000 px) uses a separate grid.
  assert.match(css, /@media \(max-width: 1000px\) \{[\s\S]*?\.player-bar \{\n\s+grid-template-columns: minmax\(0, 1fr\) auto;/);
});

test('the wide player bar reserves space for capture before its status appears', async () => {
  const css = await read('src/styles/base.css');
  assert.match(css, /@media \(min-width: 1001px\) \{\s*\.player-bar:not\(\.is-capture-only\) \.player-actions \{/);
  for (const width of [1001, 1024, 1080]) assert.equal(actionWidth(css, width), 330);
  const record = Number(css.match(/\.player-action \{ flex: none; width: (\d+)px; \}/)[1]);
  const eq = Number(css.match(/\n\.player-eq \{\s*width: (\d+)px;/)[1]);
  const gap = Number(css.match(/\.player-actions \{[^}]*gap: (\d+)px;/)[1]);
  // Picture needs about 62 px, including its padding and border. The same
  // slot takes up space when inert, so this budget applies to both item types.
  assert.match(css, /\.player-picture-slot\[inert\] \{ visibility: hidden; \}/);
  assert.ok(actionWidth(css, 1280) - record - eq - 62 - 3 * gap >= 160);
  // Outside the saved state, Record and EQ precede the variable-width
  // notice and Cancel button, including during Preparing and Recording.
  assert.match(css, /\.player-actions:not\(:has\(> \.player-action\[data-state="completed"\]\)\) > :is\(\.player-action, \.player-eq\) \{\s*order: -1;\s*flex-shrink: 0;/);
  assert.match(css, /\.player-capture-status \{\s*flex: 0 1 auto;\s*min-width: 0;/);
  assert.match(css, /#player-capture-status-text \{\s*overflow: hidden;\s*text-overflow: ellipsis;\s*white-space: nowrap;/);
  assert.match(css, /--player-h: 74px;/);
});

test('the Saved row yields space to volume with both part buttons visible', async () => {
  const css = await read('src/styles/base.css');
  assert.match(css, /\.player-actions \{[^}]*min-width: 0;/);
  assert.match(css, /\.player-bar:not\(\.is-capture-only\) \.player-actions:has\(> \.player-action\[data-state="completed"\]\) \{\s*width: auto;\s*\}/);
  assert.match(css, /@media \(max-width: 1000px\) \{[\s\S]*?"actions actions"\s*"progress progress"\s*"volume volume"/);
  const template = css.match(/\n\.player-bar \{[^}]*grid-template-columns: ([^;]+);/)[1];
  const controls = 2 * 38 + 2 * 32 + 3 * 8;
  const volume = 70;
  const { meta, progress } = columns(template, 1001, 330);
  const fixed = PADDING + GAPS + controls + volume + meta + progress;
  const savedIntrinsicWidth = 490;
  for (let width = 1001; width <= 1300; width++) {
    const actions = Math.min(savedIntrinsicWidth, width - fixed);
    assert.ok(actions > 0 && fixed + actions <= width, `${width} px fits`);
  }
  assert.ok(1090 - fixed < savedIntrinsicWidth, 'the Saved text needs to shrink at 1090 px');
});

test('resume choices occupy the title slot in either player grid', async () => {
  const html = await read('src/index.html');
  const css = await read('src/styles/base.css');
  assert.match(html, /class="player-text">\s*<div id="player-title"[^>]*><\/div>\s*<div id="player-resume-actions"[^>]*hidden>[\s\S]*?id="player-resume-part"[\s\S]*?id="player-start-over"[\s\S]*?class="player-source-row"/);
  assert.match(css, /\.player-text:has\([^{}]*\[hidden\][^{}]*\) > \.player-title \{ display: none; \}/);
  assert.doesNotMatch(css, /\.player-resume-actions\s*\{[^}]*grid-column:/);
});

test('ordinary items leave no empty part slots and crowded controls can stack', async () => {
  const html = await read('src/index.html');
  const css = await read('src/styles/base.css');
  assert.equal((html.match(/class="player-part-slot" hidden>/g) || []).length, 2);
  assert.match(css, /#app\.has-player:has\([^{}]*\.player-part-slot:not\(\[hidden\]\)[^{}]*\)\s*\{[^}]*--player-h:/);
  assert.match(css, /grid-template-areas:\s*"meta controls controls"\s*"actions progress volume"/);
});

test('Clear cache keeps its full label in Settings', async () => {
  const base = await read('src/styles/base.css');
  assert.match(base, /\.modal\[aria-labelledby="settings-title"\] \.btn \{[^}]*white-space: nowrap;/);
  assert.match(base, /\.modal\[aria-labelledby="settings-title"\] \[data-act="clear-cache"\] \{ min-inline-size: max-content; \}/);
});
