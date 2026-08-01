import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  markCatalogMutation, RENDER_WINDOW_MAX, RESIDENT_ITEM_LIMIT, view,
} from '../src/modes/library/state.js';
import {
  createSourceProgress, recordSourceFailure, RETRY_AFTER_MAX_MS,
} from '../src/modes/library/progress.js';
import { itemPassesFilters } from '../src/modes/library/filter.js';
import { filteredItemsForCurrentView } from '../src/modes/library/render.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Library production fan-out is connected to scheduler priorities, generations, and teardown aborts', async () => {
  const [chain, scheduler, index, shell, search] = await Promise.all([
    read('src/modes/library/chain.js'),
    read('src/lib/catalog-scheduler.js'),
    read('src/modes/library/index.js'),
    read('src/modes/library/shell.js'),
    read('src/lib/search.js'),
  ]);
  assert.match(chain, /catalogScheduler\.enqueue\([\s\S]*?browsePageOne/);
  assert.match(chain, /catalogScheduler\.enqueue\([\s\S]*?searchOne/);
  for (const priority of ['INITIAL', 'PREFETCH', 'SEARCH', 'USER', 'SNAPSHOT']) {
    assert.match(`${chain}\n${scheduler}`, new RegExp(`CATALOG_PRIORITY\\.${priority}`));
  }
  assert.match(chain, /view\.loadAbort\?\.abort/);
  assert.match(chain, /generation\s*!==\s*view\.searchGen/);
  assert.match(chain, /catalogScheduler\.setSourceEnabled\(sourceId, enabled\)/);
  assert.match(chain, /view\.snapshotState\.get\(sourceId\)/);
  assert.match(chain, /snapshotManager\.hasDiscovered\(sourceId\)/);
  assert.match(chain, /snapshotManager\.refresh\(sourceId\)\.catch/);
  assert.match(chain, /for \(const sourceId of sourceIds\) discoverSnapshot\(sourceId\)/,
    'a search-first session must enroll snapshot sources in timed refresh');
  assert.match(chain, /snapshotManager\.refresh\(sourceId, \{[\s\S]*?force: true/,
    'manual retry must include live snapshots, not only finite cursors');
  assert.doesNotMatch(chain, /snapshotManager\.refresh\(sourceId,\s*\{\s*signal/);
  assert.match(chain, /non-exhausted browse page did not advance its cursor/);
  assert.match(chain, /view\.lastQuery[\s\S]*?return runSearch\(\)\.catch/);
  assert.match(chain, /view\.activeSource\s*===\s*['"]favorites['"]/);
  assert.match(chain, /snapshotManager\.disableSource\(sourceId\)/);
  assert.match(index, /mode\s*!==\s*['"]library['"][\s\S]*?tearDown\(\)/);
  assert.match(index, /pauseCatalogWork\(\)/);
  assert.match(index, /const pendingQuery\s*=\s*\(view\.query/);
  assert.match(index, /view\.items\.length\s*===\s*0\s*\|\|\s*pendingQuery/);
  assert.match(shell, /view\.searchDebounced\s*=\s*debounced/);
  assert.match(search, /catalog adapter requires browsePage\(\)/);
  assert.doesNotMatch(search, /searchAllRequestId/);
  assert.doesNotMatch(search, /catalogScheduler\.enqueue\(/,
    'Library chain is the one scheduler owner for production search fan-out');
  assert.doesNotMatch(search, /exhausted:\s*items\.length\s*</);
});

test('all interactive catalog modes share the scheduler and cancel on mode changes', async () => {
  const [main, discovery, grid, tuner, search] = await Promise.all([
    read('src/main.js'),
    read('src/modes/discovery.js'),
    read('src/modes/grid.js'),
    read('src/modes/tuner.js'),
    read('src/lib/search.js'),
  ]);
  assert.match(main, /subscribe\(['"]settings-change['"],\s*syncCatalogSourceSettings\)/);
  assert.match(main, /for \(const sourceId of SOURCE_IDS\)/);
  assert.match(main, /catalogScheduler\.setSourceEnabled\(/);
  assert.doesNotMatch(main, /loadAdapter\(['"]iptv-org['"]\)/);
  for (const source of [discovery, grid, tuner]) {
    assert.match(source, /catalogScheduler\.enqueue\(/);
    assert.match(source, /CATALOG_PRIORITY\.USER/);
    assert.match(source, /signal:\s*controller\.signal/);
    assert.match(source, /subscribe\(['"]mode-change['"]/);
  }
  assert.match(discovery, /key:\s*`discovery:\$\{requestGen\}`/);
  assert.match(discovery, /DISCOVERY_ATTEMPT_DEADLINE_MS/);
  assert.match(discovery, /withDiscoveryAttemptDeadline\(signal/);
  assert.match(grid, /state\.requestAbort\?\.abort\(\)/);
  assert.match(tuner, /state\.requestAbort\?\.abort\(\)/);
  assert.doesNotMatch(grid, /if \(err\?\.name === ['"]AbortError['"]\) return/);
  assert.doesNotMatch(tuner, /if \(err\?\.name === ['"]AbortError['"]\) return/);
  assert.match(search, /if \(opts\.throwOnError\) throw err/);
});

test('continuous prefetch retains the full session catalog with bounded mounted-card windows', async () => {
  assert.equal(RESIDENT_ITEM_LIMIT, Number.POSITIVE_INFINITY);
  assert.equal(RENDER_WINDOW_MAX, 300);
  const [chain, render] = await Promise.all([
    read('src/modes/library/chain.js'), read('src/modes/library/render.js'),
  ]);
  assert.match(chain, /scheduleNextLoad\(\)/);
  assert.doesNotMatch(chain, /PREFETCH_(?:HIGH|LOW)_WATER_ITEMS/);
  assert.doesNotMatch(chain, /prefetchPaused/);
  assert.match(render, /Math\.min\(RENDER_WINDOW_MAX/);
  assert.match(render, /view\.renderStart\s*=\s*Math\.min/);
  assert.match(render, /rewindRenderWindow/);
});

test('continuous rendering filters only appended pages until a destructive mutation', () => {
  const scans = [];
  class TrackingArray extends Array {
    filter(predicate, thisArg) {
      scans.push(this.length);
      return super.filter(predicate, thisArg);
    }
  }
  const pool = new TrackingArray();
  const previous = {
    activeSource: view.activeSource,
    lastQuery: view.lastQuery,
    filters: { ...view.filters },
    catalogRevision: view.catalogRevision,
    catalogNonAppendRevision: view.catalogNonAppendRevision,
  };
  const append = (start, count) => {
    for (let index = start; index < start + count; index += 1) {
      pool.push({
        id: `nasa:incremental-${index}`,
        source: 'nasa',
        type: 'video',
        country: 'US',
        language: 'en',
        year: 2025,
        content_rating: 'general',
      });
    }
  };
  try {
    view.activeSource = 'all';
    view.lastQuery = '';
    view.filters = { type: '', country: '', language: '', yearMin: null, yearMax: null };
    append(0, 1_000);
    markCatalogMutation();
    assert.equal(filteredItemsForCurrentView(pool).length, 1_000);
    append(1_000, 30);
    markCatalogMutation({ appendOnly: true });
    assert.equal(filteredItemsForCurrentView(pool).length, 1_030);
    assert.deepEqual(scans, [1_000, 30]);

    pool[0].__snapshotOffline = true;
    markCatalogMutation();
    assert.equal(filteredItemsForCurrentView(pool).length, 1_029);
    assert.deepEqual(scans, [1_000, 30, 1_030]);
  } finally {
    view.activeSource = previous.activeSource;
    view.lastQuery = previous.lastQuery;
    view.filters = previous.filters;
    view.catalogRevision = previous.catalogRevision;
    view.catalogNonAppendRevision = previous.catalogNonAppendRevision;
  }
});

test('Retry-After progress is bounded and never becomes finite exhaustion', () => {
  const progress = createSourceProgress();
  progress.cursor = { page: 9 };
  const delay = recordSourceFailure(progress, {
    status: 429, retryAfterMs: RETRY_AFTER_MAX_MS * 2, message: 'limited',
  }, 1_000);
  assert.equal(delay, RETRY_AFTER_MAX_MS);
  assert.deepEqual(progress.cursor, { page: 9 });
  assert.equal(progress.exhausted, false);
  assert.equal(progress.rateLimited, true);
  assert.equal(progress.retryAt, 1_000 + RETRY_AFTER_MAX_MS);
});

test('offline snapshot entries are hidden from browse but remain visible in Favorites', () => {
  const previous = view.activeSource;
  const item = {
    id: 'snapshot:offline', source: 'nasa', type: 'video', year: null,
    country: '', language: '', __snapshotOffline: true,
  };
  try {
    view.activeSource = 'all';
    assert.equal(itemPassesFilters(item), false);
    view.activeSource = 'favorites';
    assert.equal(itemPassesFilters(item), true);
  } finally {
    view.activeSource = previous;
  }
});
