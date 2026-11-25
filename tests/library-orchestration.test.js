import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  markCatalogMutation, RENDER_WINDOW_MAX, renderedIds, RESIDENT_ITEM_LIMIT, view,
} from '../src/modes/library/state.js';
import {
  createSourceProgress, isHeldProgress, recordSourceFailure, recordSourceSuccess, RETRY_AFTER_MAX_MS,
  settleEachSource, sourceNoticeFromError,
} from '../src/modes/library/progress.js';
import { itemPassesFilters } from '../src/modes/library/filter.js';
import {
  currentSourceNotices, filteredItemsForCurrentView, renderResults, renderStatus, sourceNotice,
  updateSentinelStatus, viewHasPendingSources, viewWaitsOnlyOnHolds,
} from '../src/modes/library/render.js';
import { ui } from '../src/modes/library/shell-refs.js';
import { FakeElement } from './helpers/fake-dom.js';
import { SOURCES } from '../src/lib/sources.js';
import { catalogScheduler } from '../src/lib/catalog-scheduler.js';
import { getState } from '../src/lib/state.js';
import { pauseCatalogWork, runSearch } from '../src/modes/library/chain.js';

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
  assert.match(chain, /settleEachSource\(sourceIds,[\s\S]*?\(sourceId\) => \{[\s\S]*?discoverSnapshot\(sourceId\)/,
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
    // Either the view's controller directly, or a per-source deadline chained to it.
    assert.match(source, /signal:\s*(?:controller|deadline)\.signal/);
    assert.match(source, /subscribe\(['"]mode-change['"]/);
  }
  // The Grid and the Tuner give each source its own deadline through runLiveLoad.
  for (const source of [grid, tuner]) {
    assert.match(source, /await runLiveLoad\(\{\s*candidates,\s*signal: controller\.signal,/);
  }
  const liveLoad = (await readFile(new URL('../src/lib/live-load.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  assert.match(liveLoad, /const deadline = sourceDeadline\(signal, timeoutMs, timers\);/);
  assert.match(liveLoad, /\.finally\(\(\) => deadline\.done\(\)\)/);
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

test('a plain-language source notice is kept for an hour-long block and cleared on success', () => {
  const notice = 'Example Archive is turning away requests from apps right now.';
  const progress = createSourceProgress();
  assert.equal(progress.notice, '');
  const delay = recordSourceFailure(progress, {
    status: 403, retryAfterMs: 3_600_000, message: notice, userMessage: notice,
  }, 5_000);
  assert.equal(delay, 3_600_000);
  assert.equal(progress.retryAt, 3_605_000, 'the browse cursor waits the declared hour');
  assert.equal(progress.notice, notice);
  assert.equal(progress.error, notice);

  recordSourceFailure(progress, new Error('HTTP 500 for https://example.test/raw'), 6_000);
  assert.equal(progress.notice, '', 'raw adapter errors never become a visible notice');
  assert.equal(sourceNoticeFromError({ userMessage: `  ${notice}  ` }), notice);
  assert.equal(sourceNoticeFromError({ userMessage: 42 }), '');
  assert.equal(sourceNoticeFromError(null), '');

  recordSourceFailure(progress, { retryAfterMs: 10, userMessage: notice }, 7_000);
  recordSourceSuccess(progress, { cursor: null, exhausted: false }, 0);
  assert.equal(progress.notice, '');
});

test('source notices show only while a source is waiting, once per distinct text', () => {
  const notice = 'Plain words about the wait.';
  assert.equal(sourceNotice({ state: 'rate-limited', notice }), notice);
  assert.equal(sourceNotice({ state: 'retrying', notice }), notice);
  assert.equal(sourceNotice({ state: 'loading', notice }), '', 'a stale notice is hidden while loading');
  assert.equal(sourceNotice({ state: 'ready', notice }), '');
  assert.equal(sourceNotice({ state: 'retrying', error: 'HTTP 403 raw' }), '');
  assert.equal(sourceNotice(undefined), '');

  const previous = new Map(view.sourceStatus);
  try {
    view.sourceStatus.clear();
    view.sourceStatus.set('held-source', { state: 'rate-limited', notice });
    view.sourceStatus.set('nasa', { state: 'retrying', error: 'HTTP 500 raw' });
    view.sourceStatus.set('wikimedia', { state: 'more', notice: 'old' });
    assert.deepEqual(currentSourceNotices(['held-source', 'nasa', 'wikimedia']), [notice]);
    view.sourceStatus.set('nasa', { state: 'retrying', notice });
    assert.deepEqual(currentSourceNotices(['held-source', 'nasa']), [notice]);
    assert.deepEqual(currentSourceNotices(['wikimedia']), []);
  } finally {
    view.sourceStatus.clear();
    for (const [key, value] of previous) view.sourceStatus.set(key, value);
  }
});

test('a search failure with a declared cooldown also holds the browse cursor', async () => {
  const chain = await read('src/modes/library/chain.js');
  assert.match(
    chain,
    /function recordSearchFailure\(id, error, count\) \{[\s\S]*?Number\.isFinite\(declared\) && declared > 0[\s\S]*?recordSourceFailure\(progress, error\)[\s\S]*?notice: sourceNoticeFromError\(error\)/,
  );
  assert.match(chain, /error: progress\.error,\s*notice: progress\.notice,/);
});

test('a declared wait of several hours is not shortened by the library', () => {
  assert.equal(RETRY_AFTER_MAX_MS, 6 * 60 * 60 * 1000);
  const progress = createSourceProgress();
  assert.equal(recordSourceFailure(progress, { status: 403, retryAfterMs: 2 * 3_600_000, message: 'held' }, 0),
    2 * 3_600_000);
  assert.equal(progress.retryAt, 2 * 3_600_000);
});

test('a held source is recognised only while its declared wait lasts', () => {
  const progress = createSourceProgress();
  assert.equal(isHeldProgress(progress, 0), false);
  recordSourceFailure(progress, { status: 403, retryAfterMs: 60_000, message: 'held', userMessage: 'Plain.' }, 1_000);
  assert.equal(isHeldProgress(progress, 1_000), true);
  assert.equal(isHeldProgress(progress, 60_999), true);
  assert.equal(isHeldProgress(progress, 61_000), false);
  const ordinary = createSourceProgress();
  recordSourceFailure(ordinary, new Error('temporary'), 1_000);
  assert.equal(isHeldProgress(ordinary, 1_001), false, 'ordinary backoff is not a hold');
  assert.equal(isHeldProgress(undefined), false);
});

test('a source still waiting never delays the follow-up work of the others', async () => {
  let releaseHeld;
  const held = new Promise((resolve) => { releaseHeld = resolve; });
  const settled = [];
  const searches = settleEachSource(['held-source', 'nasa', 'owncast'], (sourceId) => {
    if (sourceId === 'held-source') return held;
    if (sourceId === 'owncast') return Promise.reject(new Error('owncast failed'));
    return Promise.resolve(['item']);
  }, (sourceId) => settled.push(sourceId));
  // The others settle (and their follow-up runs) while the held source still waits.
  const others = await searches.only(['nasa', 'owncast']);
  assert.deepEqual(others.map((result) => result.status), ['fulfilled', 'rejected']);
  assert.deepEqual(settled.sort(), ['nasa', 'owncast'], 'follow-up ran while the held source still waits');
  releaseHeld(['late']);
  const results = await searches.all;
  assert.deepEqual(settled.sort(), ['held-source', 'nasa', 'owncast']);
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'fulfilled', 'rejected']);
});

test('early search follow-up touches only the settled source; browse waits for the other searches', async () => {
  const chain = await read('src/modes/library/chain.js');
  const runSearch = chain.slice(chain.indexOf('export async function runSearch()'), chain.indexOf('function searchCatalogSources('));
  const scheduleSearch = chain.slice(chain.indexOf('function searchCatalogSources('), chain.indexOf('function freshProgressKeepingHold('));
  const followUp = scheduleSearch.slice(scheduleSearch.indexOf('}), (sourceId) => {'));
  assert.match(followUp, /discoverSnapshot\(sourceId\);\s*queueChainRender\(\);\s*\}\);/);
  assert.doesNotMatch(followUp, /scheduleNextLoad|loadMore/, 'no browse work starts while other searches run');
  // Browse resumes after every search except those whose source is in a
  // declared hold at the time; the check is not a one-time snapshot.
  assert.doesNotMatch(runSearch, /heldAtStart/);
  assert.match(runSearch, /searchWaitGeneration = generation;\s*await searches\.untilSettledExcept\(\(id\) => !searchCurrent\(\) \|\| sourceInDeclaredHold\(id\), \{ signal \}\);\s*if \(searchWaitGeneration === generation\) searchWaitGeneration = 0;\s*if \(!searchCurrent\(\)\) return;\s*renderChainState\(\);\s*scheduleNextLoad\(\);\s*\}/);
  // A declared scheduler cooldown counts for as long as it lasts, not only
  // while more than an ordinary backoff remains.
  assert.match(chain, /function sourceInDeclaredHold\(sourceId, now = Date\.now\(\)\) \{\s*if \(isHeldProgress\(view\.sourceProgress\.get\(sourceId\), now\)\) return true;\s*return catalogScheduler\.declaredCooldownRemainingMs\(sourceId\) > 0;/);
  assert.doesNotMatch(chain, /DEFAULT_COOLDOWN_MAX_MS/);
  assert.doesNotMatch(chain, /catalogScheduler\._state/, 'no private scheduler state is read');
});

test('a source that goes on hold mid-search stops being waited for promptly', async () => {
  const timers = new Map();
  let nextTimer = 1;
  const setTimer = (callback, delay) => { const id = nextTimer++; timers.set(id, { callback, delay }); return id; };
  const clearTimer = (id) => timers.delete(id);
  const fireTimers = () => {
    for (const [id, timer] of [...timers]) { timers.delete(id); timer.callback(); }
  };
  const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };

  let releaseHeld;
  const heldSearch = new Promise((resolve) => { releaseHeld = resolve; });
  const held = new Set();
  const searches = settleEachSource(['held-source', 'nasa', 'wikimedia'], (sourceId) => (
    sourceId === 'held-source' ? heldSearch : Promise.resolve([])
  ), () => {});
  let resumed = false;
  searches.untilSettledExcept((id) => held.has(id), { pollMs: 500, setTimer, clearTimer })
    .then(() => { resumed = true; });
  await flush();
  assert.equal(resumed, false, 'the source is not on hold yet, so its search is still waited for');
  fireTimers();
  await flush();
  assert.equal(resumed, false);
  // The source goes on hold after the search began (another job tripped it).
  held.add('held-source');
  fireTimers();
  await flush();
  assert.equal(resumed, true, 'the others resume at the next check, not when the hold ends');
  assert.equal(timers.size, 0, 'no timer is left behind');
  releaseHeld([]);

  // Without any hold, the wait ends as soon as the last search settles.
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const plain = settleEachSource(['a', 'b'], (id) => (id === 'a' ? slow : Promise.resolve()), () => {});
  let done = false;
  plain.untilSettledExcept(() => false, { setTimer, clearTimer }).then(() => { done = true; });
  await flush();
  assert.equal(done, false);
  release();
  await flush();
  assert.equal(done, true);
  assert.equal(timers.size, 0);

  // A replaced search generation stops waiting at once.
  let stale = false;
  const never = settleEachSource(['a'], () => new Promise(() => {}), () => {});
  let ended = false;
  never.untilSettledExcept(() => stale, { setTimer, clearTimer }).then(() => { ended = true; });
  stale = true;
  fireTimers();
  await flush();
  assert.equal(ended, true);

  // Aborting the search ends the wait at once; no timer or listener stays.
  const abortListeners = new Set();
  const signal = {
    aborted: false,
    addEventListener: (_type, listener) => abortListeners.add(listener),
    removeEventListener: (_type, listener) => abortListeners.delete(listener),
  };
  const pending = settleEachSource(['a'], () => new Promise(() => {}), () => {});
  let abortedEnded = false;
  pending.untilSettledExcept(() => false, { setTimer, clearTimer, signal }).then(() => { abortedEnded = true; });
  assert.equal(timers.size, 1);
  assert.equal(abortListeners.size, 1);
  signal.aborted = true;
  for (const listener of [...abortListeners]) listener();
  await flush();
  assert.equal(abortedEnded, true, 'the wait ends without waiting for the next poll');
  assert.equal(timers.size, 0, 'the poll timer is cleared at once');
  assert.equal(abortListeners.size, 0, 'the abort listener is removed');

  // A wait that ends normally also removes its abort listener, and an
  // already aborted signal never starts a wait.
  const quick = settleEachSource(['a'], () => Promise.resolve(), () => {});
  signal.aborted = false;
  await quick.untilSettledExcept(() => false, { setTimer, clearTimer, signal });
  assert.equal(abortListeners.size, 0);
  signal.aborted = true;
  await pending.untilSettledExcept(() => false, { setTimer, clearTimer, signal });
  assert.equal(timers.size, 0);
  assert.equal(abortListeners.size, 0);
});

test('partial search results from a source with a held lane still show its notice', async () => {
  const chain = await read('src/modes/library/chain.js');
  assert.match(chain, /onLaneError: \(_lane, error\) => \{\s*if \(Number\(error\?\.retryAfterMs\) > 0\) heldLaneError = error;/);
  assert.match(chain, /addItems\(items, query, \{ kind: 'search' \}\);\s*if \(heldLaneError\) recordSearchFailure\(id, heldLaneError, items\.length\);\s*else mergeFiniteStatus\(id, \{ state: 'ready', count: items\.length \}\);/);
  assert.match(chain, /onError: \(id, error\) => \{\s*if \(stale\(\)\) return;\s*recordSearchFailure\(id, error, 0\);/);
  assert.match(chain, /function recordSearchFailure\(id, error, count\) \{[\s\S]*?recordSourceFailure\(progress, error\)[\s\S]*?notice: sourceNoticeFromError\(error\)/);
});

test('search, Retry now and switching a source back on keep a held source notice', async () => {
  const chain = await read('src/modes/library/chain.js');
  // A new search shows a held source's own status instead of "loading".
  assert.match(chain, /function searchStartStatus\(sourceId, now = Date\.now\(\)\) \{\s*const progress = ensureProgress\(sourceId\);\s*if \(isHeldProgress\(progress, now\)\) return \{ \.\.\.statusFromProgress\(progress\), count: 0 \};/);
  // Switching the source back on keeps the declared wait and its reason.
  assert.match(chain, /function freshProgressKeepingHold\(before, now = Date\.now\(\)\) \{[\s\S]*?if \(isHeldProgress\(before, now\)\) \{[\s\S]*?retryAt: before\.retryAt, error: before\.error, notice: before\.notice/);
  assert.match(chain, /const fresh = freshProgressKeepingHold\(view\.sourceProgress\.get\(sourceId\)\);/);
  assert.match(chain, /if \(isHeldProgress\(fresh\)\) mergeFiniteStatus\(sourceId, statusFromProgress\(fresh\)\)/);
  // Retry now leaves a held source alone and resets only the others (see
  // tests/library-retry-holds.test.js for the behaviour).
  assert.match(chain, /const retryIds = fetchSourcesAllEnabled\(\)\.filter\(\(sourceId\) => !sourceInDeclaredHold\(sourceId, now\)\);/);
  assert.match(chain, /for \(const sourceId of retryIds\) \{\s*catalogScheduler\.resetSource\(sourceId\);[\s\S]*?progress\.notice = '';/);

  const notice = 'Example Archive is turning away requests from apps right now. Try in about 40 minutes.';
  const progress = createSourceProgress();
  recordSourceFailure(progress, { status: 403, retryAfterMs: 3_600_000, message: 'old', userMessage: 'old' }, 0);
  // What retrySources does, then the fail-fast answer from the adapter.
  Object.assign(progress, { failures: 0, retryAt: 0, error: '', notice: '', rateLimited: false });
  recordSourceFailure(progress, { status: 403, retryAfterMs: 40 * 60_000, message: notice, userMessage: notice }, 20 * 60_000);
  assert.equal(progress.notice, notice);
  assert.equal(progress.retryAt, 60 * 60_000);
  assert.equal(isHeldProgress(progress, 20 * 60_000 + 1), true);
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

class FakeNode extends FakeElement {
  get childNodes() { return this.children; }
  replaceChildren(...children) { this.children = children; }
  // Markup is kept as text so a test can see what the line says.
  get innerHTML() { return this.textContent; }
  set innerHTML(value) { this.textContent = String(value); this.children = []; }
  append(...children) { children.forEach((child) => this.appendChild(child)); }
}

class FakeResults extends FakeNode {
  set innerHTML(_value) { this.children = []; }
  querySelector(selector) {
    return selector === '.empty-state'
      ? this.children.find((node) => node.className === 'empty-state' && !node.removed) ?? null
      : null;
  }
}

/** Runs `body` against a fake results pane and sentinel, restoring the
 *  shared view and shell state afterwards. */
function withLibraryDom(body) {
  const oldDocument = globalThis.document;
  const oldUi = { ...ui };
  const keys = ['activeSource', 'query', 'lastQuery', 'items', 'loading', 'loadingMore', 'exhausted', 'renderSignature'];
  const before = Object.fromEntries(keys.map((key) => [key, view[key]]));
  const statuses = new Map(view.sourceStatus);
  const progress = new Map(view.sourceProgress);
  const rendered = new Set(renderedIds);
  try {
    globalThis.document = {
      createElement: (tag) => new FakeNode('', tag),
      createDocumentFragment: () => new FakeNode('', 'fragment'),
      createTextNode: (text) => Object.assign(new FakeNode('', '#text'), { textContent: text }),
    };
    ui.resultsHost = new FakeResults('', 'div');
    ui.sentinelStatus = new FakeNode('', 'span');
    ui.sentinelButton = new FakeNode('', 'button');
    ui.statusHost = new FakeNode('', 'div');
    ui.windowBack = null;
    view.sourceStatus.clear();
    view.sourceProgress.clear();
    view.exhausted = new Set();
    view.query = '';
    view.lastQuery = '';
    view.items = [];
    renderedIds.clear();
    const emptyMessage = () => ui.resultsHost.querySelector('.empty-state')?.children[1].textContent ?? null;
    const sentinel = () => ({
      text: ui.sentinelStatus.textContent,
      button: ui.sentinelButton.style.display,
    });
    const render = () => { renderResults(); renderStatus(); updateSentinelStatus(); };
    const summary = () => ui.statusHost.dataset.summary;
    body({ emptyMessage, sentinel, render, summary });
  } finally {
    Object.assign(ui, oldUi);
    globalThis.document = oldDocument;
    for (const key of keys) view[key] = before[key];
    view.sourceStatus.clear();
    for (const [key, value] of statuses) view.sourceStatus.set(key, value);
    view.sourceProgress.clear();
    for (const [key, value] of progress) view.sourceProgress.set(key, value);
    renderedIds.clear();
    for (const id of rendered) renderedIds.add(id);
  }
}

// Any real source works for the view tests; the notice is what a source on
// hold writes for the user.
const HELD_ID = 'wikimedia';
const HELD_NOTICE = 'This source is turning away requests from apps right now (it asks for a browser check). Nothing is wrong on your side. The app will try again in about an hour.';
const heldSource = (now = Date.now()) => ({
  state: 'rate-limited', count: 0, notice: HELD_NOTICE, retryAt: now + 60 * 60_000,
});

test('a source alone and on hold shows the plain message, not an endless spinner', () => {
  withLibraryDom(({ emptyMessage, sentinel, render }) => {
    view.activeSource = HELD_ID;
    // Other sources keep prefetching in the background, so the global
    // loading flags stay on while the held source waits.
    view.loading = false;
    view.loadingMore = true;
    view.sourceStatus.set(HELD_ID, heldSource());
    view.sourceStatus.set('nasa', { state: 'loading' });
    assert.equal(viewWaitsOnlyOnHolds(), true);
    render();
    assert.equal(emptyMessage(), HELD_NOTICE);
    assert.doesNotMatch(sentinel().text, /spinner|Loading more/);
    assert.equal(sentinel().button, 'none', 'Retry now cannot help during a hold');

    // A search with the held source as the only one behaves the same way.
    view.lastQuery = 'jazz';
    view.query = 'jazz';
    render();
    assert.equal(emptyMessage(), HELD_NOTICE);
    assert.doesNotMatch(sentinel().text, /spinner|Loading more|Searching/);
    assert.equal(sentinel().button, 'none');
  });
});

test('the All view keeps loading the other sources while one is held', () => {
  withLibraryDom(({ emptyMessage, sentinel, render }) => {
    view.activeSource = 'all';
    view.loadingMore = true;
    view.sourceStatus.set(HELD_ID, heldSource());
    view.sourceStatus.set('nasa', { state: 'loading', count: 0 });
    assert.equal(viewWaitsOnlyOnHolds(), false);
    render();
    assert.equal(emptyMessage(), null, 'no empty page while other sources are still loading');
    assert.match(sentinel().text, /Loading more/);
    assert.equal(sentinel().button, 'none');
    // The held notice still reaches the summary line of the All view.
    assert.ok(currentSourceNotices().includes(HELD_NOTICE));

    // Search across several sources: one still searching keeps "Searching...".
    view.lastQuery = 'moon';
    view.query = 'moon';
    view.loadingMore = false;
    view.sourceStatus.set('nasa', { state: 'loading' });
    assert.equal(viewWaitsOnlyOnHolds(), false);
    render();
    assert.equal(sentinel().text, 'Searching...');
  });
});

test('a held view recovers on its own when the hold ends and the source answers', () => {
  withLibraryDom(({ emptyMessage, sentinel, render }) => {
    view.activeSource = HELD_ID;
    view.loadingMore = true;
    const now = Date.now();
    view.sourceStatus.set(HELD_ID, heldSource(now));
    render();
    assert.equal(emptyMessage(), HELD_NOTICE);

    // The wait is over (retryAt has passed) and the chain asks again: the
    // view is no longer settled, so the spinner returns.
    view.sourceStatus.set(HELD_ID, { ...heldSource(now), retryAt: now - 1 });
    assert.equal(viewWaitsOnlyOnHolds(), false);
    view.sourceStatus.set(HELD_ID, { state: 'loading', count: 0 });
    render();
    assert.match(sentinel().text, /Loading more/);
    assert.equal(emptyMessage(), null, 'the expired notice goes as soon as loading resumes');

    // The source answers: items appear and the message goes.
    view.sourceStatus.set(HELD_ID, { state: 'more', count: 1 });
    view.items = [{
      id: 'held-recovered', source: HELD_ID, type: 'audio',
      title: 'Recovered recording', url: 'https://example.test/a.mp3',
    }];
    view.loadingMore = false;
    render();
    assert.equal(emptyMessage(), null);
    assert.ok(renderedIds.has('held-recovered'));
    assert.match(sentinel().text, /1 matching items loaded/);
  });
});

test('Retry now is offered only when a retrying source is not inside a hold', () => {
  withLibraryDom(({ sentinel, render }) => {
    view.activeSource = 'all';
    view.loadingMore = false;
    view.sourceStatus.set(HELD_ID, heldSource());
    view.sourceStatus.set('nasa', { state: 'more', count: 0 });
    render();
    assert.match(sentinel().text, /1 source retrying/);
    assert.equal(sentinel().button, 'none');
    view.sourceStatus.set('nasa', { state: 'retrying', count: 0, error: 'HTTP 500' });
    render();
    assert.match(sentinel().text, /2 sources retrying/);
    assert.equal(sentinel().button, 'inline-flex');
  });
});

test('a bare rate limit with no plain notice keeps Retry now and no empty page', () => {
  withLibraryDom(({ emptyMessage, sentinel, render }) => {
    view.activeSource = 'nasa';
    view.loadingMore = true; // other sources are fetching
    view.sourceStatus.set('nasa', { state: 'rate-limited', count: 0, error: 'HTTP 429', retryAt: Date.now() + 30_000 });
    assert.equal(viewWaitsOnlyOnHolds(), false);
    render();
    assert.equal(emptyMessage(), null, 'the chain retries by itself, so nothing is final yet');
    assert.match(sentinel().text, /1 source retrying/);
    assert.equal(sentinel().button, 'inline-flex');
  });
});

test('the spinner follows the view own sources, not background prefetch', () => {
  withLibraryDom(({ emptyMessage, sentinel, render }) => {
    // NASA alone has finished with no matches while others still prefetch.
    view.activeSource = 'nasa';
    view.loading = true;
    view.loadingMore = true;
    view.exhausted.add('nasa');
    view.sourceStatus.set('nasa', { state: 'complete', count: 0 });
    view.sourceStatus.set('wikimedia', { state: 'loading', count: 0 });
    view.sourceProgress.set('wikimedia', createSourceProgress());
    render();
    assert.equal(emptyMessage(), 'Type a search above, or browse a single source on the left.');
    assert.doesNotMatch(sentinel().text, /Loading more/);
    assert.equal(sentinel().text, 'All 0 matching items loaded');

    // All Sources still spins while any of its sources loads.
    view.activeSource = 'all';
    render();
    assert.match(sentinel().text, /Loading more/);
    // ...or still owes its first page.
    view.sourceStatus.set('wikimedia', { state: 'more', count: 0 });
    render();
    assert.match(sentinel().text, /Loading more/);
  });
});

test('an All view search uses the hold notice only once the other sources have answered', () => {
  withLibraryDom(({ emptyMessage, render }) => {
    view.activeSource = 'all';
    view.lastQuery = 'moon';
    view.query = 'moon';
    // The global flags can be off while a search is still out.
    view.loading = false;
    view.loadingMore = false;
    view.sourceStatus.set(HELD_ID, heldSource());
    for (const source of SOURCES) {
      if (source.id !== HELD_ID) view.sourceStatus.set(source.id, { state: 'ready', count: 0 });
    }
    view.sourceStatus.set('nasa', { state: 'loading' });
    render();
    assert.notEqual(emptyMessage(), HELD_NOTICE);
    assert.equal(emptyMessage(), null, 'no empty page while a search is still out');

    view.sourceStatus.set('nasa', { state: 'ready', count: 0 });
    assert.equal(viewWaitsOnlyOnHolds(), true);
    render();
    assert.equal(emptyMessage(), HELD_NOTICE);
  });
});

test('an ordinary empty page is left alone while loading carries on', () => {
  withLibraryDom(({ emptyMessage, render }) => {
    view.activeSource = 'all';
    view.loadingMore = false;
    render();
    assert.equal(emptyMessage(), 'Type a search above, or browse a single source on the left.');
    view.loadingMore = true;
    render();
    assert.equal(emptyMessage(), 'Type a search above, or browse a single source on the left.');
  });
});

// Issue A: a single-source search that finds nothing must settle while the
// background browse of every source keeps going.
test('a single-source search with no results shows the empty page while browse prefetch runs', () => {
  withLibraryDom(({ emptyMessage, sentinel, render, summary }) => {
    view.activeSource = 'nasa';
    view.lastQuery = 'zzqxjvkwpyy';
    view.query = 'zzqxjvkwpyy';
    view.loading = false;
    view.loadingMore = true; // other sources' browse pages are in flight
    view.sourceStatus.set('nasa', { state: 'ready', count: 0 });
    render();
    assert.equal(emptyMessage(), 'Try a different search term, or pick a different source.');
    assert.equal(sentinel().text, '0 search results loaded');
    assert.equal(summary(), 'Collecting 0 · Waiting 0 · Done 1', 'a finished search counts as done');
  });
});

test('background browse during a search does not overwrite the search status', async () => {
  const chain = await read('src/modes/library/chain.js');
  assert.match(chain, /function mergeBrowseStatus\(sourceId, finite\) \{\s*if \(\(view\.lastQuery \|\| ''\)\.trim\(\)\) return;\s*mergeFiniteStatus\(sourceId, finite\);/);
  const fetchBrowse = chain.slice(chain.indexOf('async function fetchBrowsePage('), chain.indexOf('export async function runSearch()'));
  // Only the "source switched off" status is still written directly.
  assert.deepEqual(fetchBrowse.match(/mergeFiniteStatus\(sourceId, [^)]*\)/g), [
    "mergeFiniteStatus(sourceId, { state: 'disabled', count: progress.loaded })",
  ]);
  assert.equal(fetchBrowse.match(/mergeBrowseStatus\(/g).length, 5);
});

// Issue B: no "No matching items" while the selected source's first page is
// still on its way, even when the global loading flags are off.
test('a selected source whose first page is pending shows no empty page', () => {
  withLibraryDom(({ emptyMessage, render, summary }) => {
    view.activeSource = 'all';
    view.loading = false;
    view.loadingMore = false;
    render();
    assert.equal(emptyMessage(), 'Type a search above, or browse a single source on the left.');

    // NASA is selected; its first page has not answered.
    view.activeSource = 'nasa';
    view.sourceProgress.set('nasa', createSourceProgress());
    view.sourceStatus.set('nasa', { state: 'more', count: 0 });
    assert.equal(viewHasPendingSources(), true);
    render();
    assert.equal(emptyMessage(), null, 'the page left over from All Sources is removed');
    assert.equal(summary(), 'Collecting 1 · Waiting 0 · Done 0');

    view.sourceStatus.set('nasa', { state: 'loading', count: 0 });
    render();
    assert.equal(emptyMessage(), null);

    // The first page answered with nothing and no more pages: settled.
    Object.assign(view.sourceProgress.get('nasa'), { exhausted: true });
    view.exhausted.add('nasa');
    view.sourceStatus.set('nasa', { state: 'complete', count: 0 });
    render();
    assert.equal(emptyMessage(), 'Type a search above, or browse a single source on the left.');
  });
});

test('selecting a source while the first pages load does not start the Library over', async () => {
  const sidebar = await read('src/modes/library/sidebar.js');
  assert.match(sidebar, /const chainIdle = !view\.catalogActive \|\| view\.sourceProgress\.size === 0;/);
  assert.match(sidebar, /if \(headingNonFav && \(\(poolIsEmpty && chainIdle\) \|\| pendingQuery\)\) \{\s*runSearch\(\);/);
  assert.match(sidebar, /if \(headingNonFav && sourceId !== 'all'\) focusViewSources\(effectiveStatusSources\(\)\);\s*\/\/[^\n]*\n\s*syncSnapshotVisibility\(\);\s*renderResults\(\);/);
  const chain = await read('src/modes/library/chain.js');
  const focus = chain.slice(chain.indexOf('export function focusViewSources('));
  assert.match(focus, /catalogScheduler\.promote\(sourceId, CATALOG_PRIORITY\.USER\)/);
  assert.match(focus, /fetchBrowsePage\(sourceId, generation, \{\s*priority: CATALOG_PRIORITY\.USER,/);
});


test('Radio Browser collects the whole directory in the background, including during search', async (t) => {
  const radio = 'radio-browser';
  const state = getState();
  const oldSettings = state.settings;
  const oldDocument = globalThis.document;
  const oldUi = { ...ui };
  const oldView = { ...view };
  t.after(() => {
    pauseCatalogWork();
    catalogScheduler.resetSource(radio);
    state.settings = oldSettings;
    globalThis.document = oldDocument;
    Object.assign(ui, oldUi);
    Object.assign(view, oldView);
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(catalogScheduler, 'enqueue', ({ task, signal }) => task({ signal }));

  const drain = () => new Promise((resolve) => setImmediate(resolve));
  const station = (number, countrycode = 'US') => ({
    stationuuid: String(number), name: 'Station ' + number, countrycode,
    url: 'https://radio.example/live',
  });
  const pages = [];
  const searches = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname === '/json/servers') return Response.json([]);
    assert.equal(pathname, '/json/stations/search');
    const name = searchParams.get('name');
    if (name) {
      searches.push(name);
      return Response.json([station(3300, 'GB')]);
    }
    const offset = Number(searchParams.get('offset'));
    const limit = Number(searchParams.get('limit'));
    pages.push(offset);
    assert.equal(limit, 300);
    const size = offset < 3300 ? limit : 1;
    return Response.json(Array.from({ length: size }, (_, index) => station(offset + index)));
  });
  state.settings = {
    ...oldSettings,
    enabledSources: Object.fromEntries(SOURCES.map(({ id }) => [id, id === radio])),
  };
  globalThis.document = { createElement: (tag) => new FakeNode('', tag) };
  const counts = Object.fromEntries([radio, 'all', 'type:radio', 'type:tv'].map((id) => [id, {}]));
  Object.assign(ui, {
    sidebar: {
      querySelectorAll: () => Object.entries(counts).map(([source, count]) => ({
        dataset: { source }, querySelector: (selector) => selector === '[data-role="count"]' ? count : null,
      })),
    },
    resultsHost: new FakeResults(),
    statusHost: null,
    windowBack: null,
    sentinelStatus: new FakeNode(),
    sentinelButton: new FakeNode(),
  });
  Object.assign(view, {
    activeSource: radio, query: '', filters: { ...view.filters, country: 'GB' },
    items: [], itemIndex: new Map(), finiteItemIds: new Set(),
    sourceCounts: new Map(), sourceProgress: new Map(), sourceStatus: new Map(),
    sessionCounts: new Map(), cumulativeCounts: new Map(), cumulativeSourceTypeCounts: new Map(),
    cumulativeTypeCounts: new Map(), exhausted: new Set(),
  });
  await runSearch();
  for (let page = 1; page < 10; page += 1) {
    t.mock.timers.tick(100);
    await drain();
  }
  assert.deepEqual(pages, Array.from({ length: 10 }, (_, index) => index * 300));
  assert.equal(counts[radio].textContent, '3000');
  assert.equal(counts.all.textContent, '3000');
  assert.equal(counts['type:radio'].textContent, '3000');
  assert.equal(counts['type:tv'].textContent, '0');

  view.filters.country = 'NZ';
  view.query = 'Station 3300';
  await runSearch();
  assert.deepEqual(searches, ['Station 3300']);
  view.filters.country = 'GB';
  assert.deepEqual(filteredItemsForCurrentView().map((item) => item.title), ['Station 3300']);
  view.filters.country = 'NZ';

  for (let page = 10; page < 12; page += 1) {
    t.mock.timers.tick(100);
    await drain();
  }
  assert.deepEqual(pages, Array.from({ length: 12 }, (_, index) => index * 300));
  assert.equal(view.exhausted.has(radio), true);
  assert.equal(view.chainTimer, null);
  assert.equal(counts[radio].textContent, '3301');
  assert.equal(counts.all.textContent, '3301');
  assert.equal(counts['type:radio'].textContent, '3301');
});
