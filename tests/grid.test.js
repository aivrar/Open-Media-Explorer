import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Grid mounts channel tiles before observing their artwork', async () => {
  const source = await readFile(new URL('../src/modes/grid.js', import.meta.url), 'utf8');
  const start = source.indexOf('function renderTiles()');
  const end = source.indexOf('function activateTile(', start);
  const renderTiles = source.slice(start, end);
  const mount = renderTiles.indexOf('ui.tilesHost.appendChild(tile)');
  const observe = renderTiles.indexOf('artworkObserver.observe(tile)');

  assert.ok(mount >= 0, 'Grid must mount each channel tile');
  assert.ok(observe >= 0, 'Grid must observe each channel tile for lazy artwork');
  assert.ok(mount < observe, 'detached WebView2 targets can miss their first observer event');
});
