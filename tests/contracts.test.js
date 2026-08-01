import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadAdapter } from '../src/lib/sources.js';
import { catalogScheduler } from '../src/lib/catalog-scheduler.js';
import { makeItem, validateItem } from '../src/lib/item-model.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const contract = JSON.parse(await read('tests/fixtures/baseline-ui-contract.json'));

test('frozen player and settings DOM contract matches source markup', async () => {
  const html = await read('src/index.html');
  const settings = await read('src/lib/settings.js');
  const css = await read('src/styles/base.css');

  for (const id of [
    contract.player.root,
    ...contract.player.mediaElements,
    ...contract.player.metadata,
    ...contract.player.controls,
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  for (const field of contract.settings.fields) {
    assert.match(settings, new RegExp(`data-field=["']${field}["']`));
  }
  for (const section of contract.settings.sections) {
    assert.match(settings, new RegExp(`<h3>${section}</h3>`));
  }
  assert.match(css, new RegExp(`@media\\s*\\(max-width:\\s*${contract.player.layouts.compact.maxWidthPx}px\\)`));
  assert.match(css, new RegExp(`@media\\s*\\(max-width:\\s*${contract.player.layouts.narrow.maxWidthPx}px\\)`));
  for (const area of contract.player.layouts.compact.areas) {
    assert.ok(css.includes(`"${area}"`), `missing compact player area ${area}`);
  }
  assert.match(html, /id="player-capture-announcement"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="player-capture-progress"[^>]*role="progressbar"/);
  assert.match(html, /id="player-eq"[^>]*aria-pressed="false"/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /@media \(max-width:\s*1000px\)[\s\S]*?"meta controls"[\s\S]*?"actions actions"/);
  assert.match(settings, /role="dialog"[^>]*aria-modal="true"/);
  assert.match(settings, /data-runtime-downloads/);
  assert.match(settings, /data-runtime-tools/);
  assert.match(settings, /data-runtime-writable/);
});

test('capture status is isolated from player title and source metadata', async () => {
  const capture = await read('src/lib/capture-ui.js');
  assert.equal(capture.includes('player-title'), false);
  assert.equal(capture.includes('player-source'), false);
  assert.match(capture, /player-capture-status-text/);
  assert.match(capture, /visibilitychange/);
  assert.match(capture, /mode-change/);
  assert.match(capture, /current-item/);
});

test('EQ overlay contract exposes automatic, scoped, keyboard-accessible controls', async () => {
  const overlay = await read('src/lib/eq-overlay.js');
  const presets = await read('src/lib/eq-presets.js');
  const css = await read('src/styles/base.css');
  assert.match(overlay, /role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="eq-title"/);
  assert.match(overlay, /Changes apply immediately and save automatically/);
  assert.match(overlay, /data-eq-scope/);
  assert.match(overlay, /data-eq-favorite[^>]*aria-pressed="false"/);
  assert.match(overlay, /data-eq-bypass/);
  assert.match(overlay, /data-eq-response/);
  assert.match(overlay, /step="0\.5"/);
  assert.match(overlay, /PERSIST_DEBOUNCE_MS\s*=\s*150/);
  assert.match(overlay, /event\.key === 'Escape'/);
  assert.match(overlay, /app\.inert = true/);
  assert.match(overlay, /eq-before-scope-change/);
  for (const name of ['Flat', 'Bass Boost', 'Treble Boost', 'Vocal', 'Spoken Word', 'Rock', 'Classical', 'Jazz', 'Electronic', 'Night']) {
    assert.ok(presets.includes(`'${name}'`), `missing built-in ${name}`);
  }
  assert.match(css, /\.eq-bands[\s\S]*overflow-x:\s*auto/);
  assert.match(css, /\.eq-band-slider:focus-visible/);
});

test('Library mode tears down detached work and preserves detail identity across navigation', async () => {
  const library = await read('src/modes/library/index.js');
  const detail = await read('src/modes/library/detail.js');
  assert.match(library, /subscribe\(['"]mode-change['"][\s\S]*?mode\s*!==\s*['"]library['"][\s\S]*?tearDown\(\)/);
  assert.match(library, /closeDetail\(\{\s*preserveSelection:\s*true\s*\}\)/);
  assert.match(library, /getRestorableDetailItem\([\s\S]*?state\.currentItem/);
  assert.match(detail, /view\.detailItemId\s*=\s*item\.id/);
});

test('frozen adapter modules and normalized output contract are loadable without network access', async () => {
  for (const id of contract.adapters.ids) {
    const adapter = await loadAdapter(id);
    for (const name of contract.adapters.requiredExports) {
      assert.ok(name in adapter, `${id} missing export ${name}`);
    }
    assert.equal(adapter.id, id);
    assert.equal(typeof adapter.displayName, 'string');
    assert.ok(adapter.displayName.length > 0);
    assert.ok(Array.isArray(adapter.itemTypes) && adapter.itemTypes.length > 0);

    const type = adapter.itemTypes[0];
    const item = makeItem({
      id: `${id}:fixture`,
      title: `${adapter.displayName} fixture`,
      description: '',
      source: id,
      type,
      stream_url: 'https://media.example/fixture.mp3',
      stream_kind: type === 'video' || type === 'tv' ? 'video' : 'audio',
      thumbnail: '',
      country: '',
      language: '',
      license: 'Unknown',
      source_url: 'https://catalog.example/fixture',
      tags: [],
    });
    assert.deepEqual(validateItem(item), [], `${id} normalized output must validate`);
  }
});

test('new-source caller policies are installed in the shared scheduler', async () => {
  const expected = {
    'media-ccc': { maxConcurrent: 2, minIntervalMs: 500 },
    'library-of-congress': { maxConcurrent: 1, minIntervalMs: 6_000 },
    gpodder: { maxConcurrent: 4, minIntervalMs: 0 },
    peertube: { maxConcurrent: 2, minIntervalMs: 500 },
    owncast: { maxConcurrent: 1, minIntervalMs: 0 },
  };
  for (const [sourceId, policy] of Object.entries(expected)) {
    await loadAdapter(sourceId);
    assert.deepEqual(catalogScheduler.policies.get(sourceId), policy);
  }
});

test('frozen item model fields, API routes, and runtime folders match source', async () => {
  const model = await read('src/lib/item-model.js');
  const server = await read('worldmedia_server.py');
  const native = await read('worldmedia_native.py');

  for (const field of contract.itemModel.requiredStringFields) {
    assert.match(model, new RegExp(`['"]${field}['"]|\\b${field}\\b`), `missing item field ${field}`);
  }
  for (const route of contract.apiRoutes) assert.ok(server.includes(route), `missing route ${route}`);
  for (const folder of contract.runtime.stateFolders) {
    assert.match(native, new RegExp(`['"]${folder}['"]`), `missing runtime folder ${folder}`);
  }
  assert.match(native, /icon=str\(_root \/ "assets" \/ "worldmedia\.ico"\)/,
    'native window must retain the World Media icon with the signed launcher');
});
