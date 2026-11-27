import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = async (path) => (await readFile(new URL(`../${path}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

/** The declarations of the last rule whose selector list names `selector`. */
function lastRule(css, selector) {
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, selectors]) => selectors.split(',').map((part) => part.trim()).includes(selector));
  return rules.at(-1)?.[2] || '';
}

test('"New effects now" and "New overlays now" have the size of the panel\'s other choices, not of the arrow buttons', async () => {
  const css = await read('src/visualizer/visualizer.css');
  assert.match(lastRule(css, '.viz-panel'), /font-size: 12px;/);
  assert.match(lastRule(css, '.viz-btn'), /font-size: 14px;/, 'the arrow buttons keep their larger glyphs');
  for (const selector of ['.viz-fx-now', '.viz-ov-now']) {
    const rule = lastRule(css, selector);
    assert.match(rule, /font-size: inherit;/, selector);
    assert.match(rule, /padding: 3px 6px;/, `${selector}: the lists' padding`);
    // The rule comes after .viz-btn, so it wins over it (same weight).
    assert.ok(css.lastIndexOf(`${selector}`) > css.indexOf('.viz-btn {'), selector);
  }
  assert.match(lastRule(css, '.viz-select'), /padding: 3px 6px;/);
  const hover = lastRule(css, '.viz-btn:enabled:hover');
  assert.equal(hover.trim(), lastRule(css, '.viz-section-head:hover').trim().replace('background:', 'background-color:'));
  assert.equal(lastRule(css, '.viz-seg:enabled:hover:not([aria-pressed="true"])'), hover);
  assert.match(lastRule(css, '.viz-notice-btn'), /appearance: none;/);
  const index = await read('src/visualizer/index.js');
  assert.match(index, /el\('button', 'viz-btn viz-fx-now', \{ type: 'button' \}, 'New effects now'\)/);
  assert.match(index, /el\('button', 'viz-btn viz-ov-now', \{ type: 'button' \}, 'New overlays now'\)/);
});
