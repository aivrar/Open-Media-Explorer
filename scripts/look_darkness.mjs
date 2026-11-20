/**
 * Turns a brightness sweep's table (a TSV with at least the columns `id` and
 * `mean`: one row per scene, `scene`, and per look, `scene#number`) into
 * src/visualizer/look-darkness.js: each look's darkness, 0 (bright) to 1
 * (dark), for the shuffle's tone (shuffle.js lookToneWeight).
 *
 *   node scripts/look_darkness.mjs <results.tsv> [out.js]
 *
 * Darkness from the look's mean luma: LOOK_DARK_MEAN or less is 1,
 * LOOK_BRIGHT_MEAN or more is 0, in a straight line between (PROPOSED), two
 * decimals. A scene's own row (no look number) is kept as `d`: the scene as
 * it starts (looks.js startLook: look 0 where the looks are presets, its
 * default option where they are a setting's options).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const LOOK_DARK_MEAN = 0.05;
export const LOOK_BRIGHT_MEAN = 0.5;

/** Darkness (0..1, two decimals) of a mean luma. */
export function darknessOf(mean) {
  const u = (Number(mean) - LOOK_DARK_MEAN) / (LOOK_BRIGHT_MEAN - LOOK_DARK_MEAN);
  return Math.round((1 - Math.max(0, Math.min(1, u))) * 100) / 100;
}

/** The table read: { scene: { d?: darkness, [number]: darkness } }, and the
 *  rows that could not be read. */
export function readSweep(text) {
  const lines = String(text).split(/\r?\n/).filter((line) => line.trim());
  const head = (lines.shift() || '').split('\t');
  const idAt = head.indexOf('id');
  const meanAt = head.indexOf('mean');
  if (idAt < 0 || meanAt < 0) throw new Error('the table needs the columns id and mean');
  const table = {};
  const skipped = [];
  for (const line of lines) {
    const cells = line.split('\t');
    const id = cells[idAt];
    const mean = Number(cells[meanAt]);
    const match = /^([a-z][a-z0-9_]*)(?:#(\d+))?$/.exec(id || '');
    if (!match || cells[meanAt] === '' || !Number.isFinite(mean)) { skipped.push(line); continue; }
    const row = (table[match[1]] ||= {});
    row[match[2] === undefined ? 'd' : Number(match[2])] = darknessOf(mean);
  }
  return { table, skipped };
}

/** The data module's text (ASCII, CRLF). */
export function lookDarknessModule(table, { source = 'the brightness sweep', rows = 0 } = {}) {
  const scenes = Object.keys(table).sort();
  const body = scenes.map((scene) => {
    const row = table[scene];
    const keys = Object.keys(row).sort((a, b) => (a === 'd' ? -1 : b === 'd' ? 1 : Number(a) - Number(b)));
    return `  ${scene}: { ${keys.map((key) => `${key === 'd' ? 'd' : key}: ${row[key]}`).join(', ')} },`;
  });
  return [
    '/**',
    ' * Each look\'s darkness, 0 (bright) to 1 (dark), from its mean brightness',
    ` * in ${source} (${rows} rows, ${scenes.length} scenes). Made by`,
    ' * scripts/look_darkness.mjs; do not edit by hand, run it again on a new',
    ' * table. `d`: the scene as it starts (looks.js startLook);',
    ' * a number: that look. A scene or look not in it has no darkness (the',
    ' * shuffle then gives it no tone weight).',
    ' */',
    '',
    'export const LOOK_DARKNESS = Object.freeze({',
    ...body,
    '});',
    '',
    '/** Look `number` of scene `id`: its darkness, or undefined. `start`: the',
    ' *  look the scene starts in (looks.js startLook), measured as `d`. */',
    'export function lookDarkness(id, number, start = 0) {',
    '  const row = Object.prototype.hasOwnProperty.call(LOOK_DARKNESS, id) ? LOOK_DARKNESS[id] : null;',
    '  if (!row) return undefined;',
    '  if (row[number] !== undefined) return row[number];',
    '  return number === start ? row.d : undefined;',
    '}',
    '',
  ].join('\r\n');
}

function main([input, output = 'src/visualizer/look-darkness.js']) {
  if (!input) {
    console.error('usage: node scripts/look_darkness.mjs <results.tsv> [out.js]');
    process.exitCode = 2;
    return;
  }
  const text = readFileSync(input, 'utf8');
  const { table, skipped } = readSweep(text);
  const rows = Object.values(table).reduce((n, row) => n + Object.keys(row).length, 0);
  writeFileSync(output, lookDarknessModule(table, { rows }));
  console.log(`${output}: ${Object.keys(table).length} scenes, ${rows} rows${skipped.length ? `, ${skipped.length} skipped` : ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
