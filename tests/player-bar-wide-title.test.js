import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = async (path) => (await readFile(new URL(`../${path}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

// The bar's fixed parts as drawn at 1920 px wide: Play, Stop and the star
// (116 px), Record, EQ and the sound meter (276 px), the volume (138 px).
const FIXED = 116 + 276 + 138;
const PADDING = 2 * 14;
const GAPS = 4 * 10;

/** The name column and the seek bar column at `width` px, worked out as
 *  the grid does it from the bar's column list. */
function columns(template, width) {
  const match = template.match(
    /^minmax\(clamp\((\d+)px, (\d+)vw - (\d+)px, (\d+)px\), ([\d.]+)fr\) auto auto minmax\((\d+)px, ([\d.]+)fr\) auto$/,
  );
  assert.ok(match, template);
  const [, low, vw, minus, high, metaFr, progressMin, progressFr] = match.map(Number);
  const free = width - PADDING - GAPS - FIXED;
  const floor = Math.min(high, Math.max(low, (vw / 100) * width - minus));
  const share = (free * metaFr) / (metaFr + progressFr);
  const meta = Math.max(floor, share);
  const progress = Math.max(progressMin, free - meta);
  return { meta: Math.round(meta), progress: Math.round(progress), share: Math.round(share) };
}

test('the song in the player bar uses the room a wide window has; 1024 and 1280 px are unchanged', async () => {
  const css = await read('src/styles/base.css');
  const rule = css.match(/\n\.player-bar \{[^}]*grid-template-columns: ([^;]+);/);
  assert.ok(rule, 'the player bar lists its columns');
  const template = rule[1];
  // 1024 and 1280 px: the column's share of the room, as before.
  for (const width of [1024, 1280]) {
    const { meta, share } = columns(template, width);
    assert.equal(meta, Math.max(190, share), `${width} px`);
  }
  assert.equal(columns(template, 1280).meta, 289);
  // Wide windows: a column that grows with the window.
  const at1920 = columns(template, 1920);
  const at2560 = columns(template, 2560);
  assert.equal(at1920.meta, 680);
  assert.equal(at2560.meta, 1160);
  assert.ok(at1920.meta > at1920.share + 100, 'more than the share it had (559 px)');
  // The seek bar and the times keep room beside it, and nothing leaves the bar.
  for (const width of [1920, 2195, 2560, 3840]) {
    const { meta, progress } = columns(template, width);
    assert.ok(progress >= 400, `${width} px: ${progress} px for the seek bar and the times`);
    assert.ok(PADDING + GAPS + FIXED + meta + progress <= width, `${width} px fits`);
  }
  // The narrow layout (up to 1000 px) is its own and untouched.
  assert.match(css, /@media \(max-width: 1000px\) \{[\s\S]*?\.player-bar \{\n\s+grid-template-columns: minmax\(0, 1fr\) auto;/);
});
