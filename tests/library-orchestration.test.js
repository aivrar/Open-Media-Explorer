import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  addItems, markCatalogMutation, RENDER_WINDOW_MAX, renderedIds, RESIDENT_ITEM_LIMIT, thumbHydration, view,
} from '../src/modes/library/state.js';
import {
  createSourceProgress, isHeldProgress, recordSourceFailure, recordSourceSuccess, RETRY_AFTER_MAX_MS,
  settleEachSource, sourceNoticeFromError,
} from '../src/modes/library/progress.js';
import { itemPassesFilters } from '../src/modes/library/filter.js';
import { rankedComputerEntries } from '../src/lib/computer-catalog.js';
import { createComputerSearch, updateComputerHits } from '../src/modes/library/computer.js';
import {
  bindLibraryVideoClearance, captureCardAnchor, currentSourceNotices, filteredItemsForCurrentView,
  renderResults, renderStatus, restoreCardAnchor, sourceNotice, syncFilterAnchor,
  updateSentinelStatus, viewHasPendingSources, viewWaitsOnlyOnHolds,
} from '../src/modes/library/render.js';
import { ui } from '../src/modes/library/shell-refs.js';
import { cancelThumbnailHydration } from '../src/modes/library/thumbnails.js';
import { FakeElement } from './helpers/fake-dom.js';
import { SOURCES } from '../src/lib/sources.js';
import { catalogScheduler } from '../src/lib/catalog-scheduler.js';
import { getState, STORAGE_KEYS } from '../src/lib/state.js';
import { closeDetail, openDetail } from '../src/modes/library/detail.js';
import { buildShell } from '../src/modes/library/shell.js';
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
  const [main, surprise, nowPlaying, tuner, search] = await Promise.all([
    read('src/main.js'),
    read('src/modes/now-playing-surprise.js'),
    read('src/modes/now-playing.js'),
    read('src/modes/tuner.js'),
    read('src/lib/search.js'),
  ]);
  assert.match(main, /subscribe\(['"]settings-change['"],\s*syncCatalogSourceSettings\)/);
  assert.match(main, /for \(const sourceId of SOURCE_IDS\)/);
  assert.match(main, /catalogScheduler\.setSourceEnabled\(/);
  assert.doesNotMatch(main, /loadAdapter\(['"]iptv-org['"]\)/);
  for (const source of [surprise, tuner]) {
    assert.match(source, /catalogScheduler\.enqueue\(/);
    assert.match(source, /CATALOG_PRIORITY\.USER/);
  }
  assert.match(tuner, /signal:\s*controller\.signal/);
  assert.match(surprise, /signal:\s*AbortSignal\.any\(\[controller\.signal, attempt\.signal\]\)/);
  assert.match(surprise, /const opts = \{ limit: 20, signal, throwOnError: true \}/);
  assert.match(tuner, /subscribe\(['"]mode-change['"]/);
  assert.match(nowPlaying, /on\('mode-change',[\s\S]+if \(mode !== NOW_PLAYING_MODE\) tearDown\(\)/);
  assert.match(tuner, /await runLiveLoad\(\{\s*candidates,\s*signal: controller\.signal,/);
  const liveLoad = (await readFile(new URL('../src/lib/live-load.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  assert.match(liveLoad, /const deadline = sourceDeadline\(signal, timeoutMs, timers\);/);
  assert.match(liveLoad, /\.finally\(\(\) => deadline\.done\(\)\)/);
  assert.match(surprise, /key:\s*`surprise:\$\{requestGen\}`/);
  assert.match(surprise, /SOURCE_DEADLINE_MS/);
  assert.match(surprise, /setTimeout\(\(\) => attempt\.abort\(\), SOURCE_DEADLINE_MS\)/);
  assert.match(surprise, /cancelRequest\?\.\(\)/);
  assert.match(tuner, /state\.requestAbort\?\.abort\(\)/);
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

test('Computer hits are available before debounce and provider arrivals do no local matching', (t) => {
  const previous = { ...view };
  const state = getState();
  const settings = state.settings;
  t.after(() => { Object.assign(view, previous); state.settings = settings; });
  state.settings = { ...settings, tabsShown: { ...settings.tabsShown, computer: false } };
  Object.assign(view, {
    query: 'needle', lastQuery: 'previous', activeSource: 'all', items: [], computerHits: [],
    filters: { type: '', country: '', language: '', yearMin: null, yearMax: null },
    itemIndex: new Map(), catalogStore: null, sourceCounts: new Map(), sessionCounts: new Map(),
    cumulativeCounts: new Map(), cumulativeTypeCounts: new Map(), cumulativeSourceTypeCounts: new Map(),
    finiteItemIds: new Set(), snapshotIdsBySource: new Map(),
  });
  const snapshot = { loaded: false, items: [], folders: [], missingFiles: new Set() };
  const find = t.mock.fn(rankedComputerEntries);
  const search = createComputerSearch(find);
  updateComputerHits(snapshot, search);
  const provider = (id) => ({ id, source: 'iptv-org', title: 'Needle station', type: 'radio' });
  const ids = () => filteredItemsForCurrentView().map((item) => item.id);

  addItems([provider('earlier')], 'previous');
  assert.deepEqual(ids(), ['earlier'], 'internet results work before the local catalog arrives');
  assert.equal(find.mock.callCount(), 0);

  const loaded = { ...snapshot, loaded: true, folders: [{ id: 'drive' }], items: [
    { id: 'movie', kind: 'video', title: 'Needle', folder: 'drive' },
    { id: 'book', kind: 'audio', title: 'Needle book', folder: 'drive', ext: 'm4b' },
    { id: 'track', kind: 'audio', title: 'Album track', artist: 'Needle', folder: 'drive' },
  ] };
  assert.equal(updateComputerHits(loaded, search), true);
  assert.deepEqual(ids(), ['computer:movie', 'computer:book', 'computer:track', 'earlier']);
  view.lastQuery = view.query;
  assert.equal(updateComputerHits(loaded, search), false, 'the debounced provider search uses the memo');
  for (const id of ['station-1', 'station-2', 'station-3']) {
    addItems([provider(id)], 'needle');
    assert.ok(ids().includes(id));
  }
  assert.equal(find.mock.callCount(), 1);
  for (const [type, expected] of [
    ['audio', ['computer:book', 'computer:track']], ['video', ['computer:movie']],
    ['radio', ['station-1', 'station-2', 'station-3']], ['tv', []],
  ]) {
    view.activeSource = 'type:' + type;
    view.filters.type = type;
    assert.deepEqual(ids(), expected);
  }
  view.activeSource = 'computer';
  view.filters.type = '';
  assert.deepEqual(ids(), ['computer:movie', 'computer:book', 'computer:track']);
  view.query = '';
  updateComputerHits(loaded, search);
  assert.deepEqual(ids(), []);
  assert.equal(find.mock.callCount(), 1);
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
  // Markup is kept as text so a test can see what the line says.
  get innerHTML() { return this.textContent; }
  set innerHTML(value) { this.textContent = String(value); this.replaceChildren(); }
  setAttribute(name, value) {
    super.setAttribute(name, value);
    if (name === 'data-id') this.dataset.id = value;
    if (name === 'data-revision') this.dataset.revision = value;
  }
  appendChild(child) {
    if (child.tagName === 'FRAGMENT') this.append(...child.children);
    else this.insertBefore(child, null);
    return child;
  }
  insertBefore(child, before) {
    child.remove();
    child.parentNode = this;
    const index = before ? this.children.indexOf(before) : this.children.length;
    this.children.splice(index, 0, child);
  }
  replaceChildren(...children) {
    for (const child of [...this.children]) child.remove();
    this.append(...children);
  }
  remove() {
    if (!this.parentNode) return;
    if (this.contains(document.activeElement)) document.activeElement = null;
    this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }
  contains(child) {
    for (let node = child; node; node = node.parentNode) {
      if (this === node) return true;
    }
    return false;
  }
  get isConnected() { return Boolean(this.isRoot || this.parentNode?.isConnected); }
  focus(options) { this.focusOptions = options; document.activeElement = this; }
  append(...children) { children.forEach((child) => this.appendChild(child)); }
  querySelector(selector) {
    if (selector === 'img') return this.children.find((node) => node.tagName === 'IMG') ?? null;
    if (selector === '.empty-state') return this.children.find((node) => node.className === 'empty-state') ?? null;
    return null;
  }
}

class FakeResults extends FakeNode {
  set innerHTML(_value) { this.replaceChildren(); }
}

/** Runs `body` against a fake results pane and sentinel, restoring the
 *  shared view and shell state afterwards. */
function withLibraryDom(body) {
  const globals = { document: globalThis.document, window: globalThis.window,
    IntersectionObserver: globalThis.IntersectionObserver };
  const oldUi = { ...ui };
  const oldHydration = { ...thumbHydration };
  const keys = ['activeSource', 'query', 'lastQuery', 'items', 'loading', 'loadingMore', 'exhausted',
    'renderSignature', 'renderLimit', 'renderStart', 'computerHits', 'filters', 'personalFilters', 'detailItemId',
    'catalogRevision', 'catalogNonAppendRevision', 'infiniteObserver', 'searchDebounced'];
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
    globalThis.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    globalThis.window = { IntersectionObserver };
    Object.assign(thumbHydration, { observer: null, observerRoot: null, abortController: null });
    ui.root = Object.assign(new FakeNode(), { isRoot: true });
    const scroller = Object.assign(new FakeNode(), {
      scrollTop: 0, scrollHeight: 100_000, clientHeight: 400,
      getBoundingClientRect: () => ({ top: 100, bottom: 500 }),
    });
    ui.root.appendChild(scroller);
    ui.resultsHost = new FakeResults('', 'div');
    scroller.appendChild(ui.resultsHost);
    ui.detailPanel = null;
    ui.filterCount = new FakeNode('', 'span');
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
    view.computerHits = [];
    view.filters = { type: '', country: '', language: '', yearMin: null, yearMax: null };
    view.renderStart = 0;
    view.renderLimit = RENDER_WINDOW_MAX;
    renderedIds.clear();
    const emptyMessage = () => ui.resultsHost.querySelector('.empty-state')?.children[1].textContent ?? null;
    const sentinel = () => ({
      text: ui.sentinelStatus.textContent,
      button: ui.sentinelButton.style.display,
    });
    const render = () => { renderResults(); renderStatus(); updateSentinelStatus(); };
    const summary = () => ui.statusHost.dataset.summary;
    body({ emptyMessage, sentinel, render, summary, scroller, host: ui.resultsHost });
  } finally {
    thumbHydration.observer?.disconnect();
    cancelThumbnailHydration();
    Object.assign(thumbHydration, oldHydration);
    Object.assign(ui, oldUi);
    Object.assign(globalThis, globals);
    for (const key of keys) view[key] = before[key];
    view.sourceStatus.clear();
    for (const [key, value] of statuses) view.sourceStatus.set(key, value);
    view.sourceProgress.clear();
    for (const [key, value] of progress) view.sourceProgress.set(key, value);
    renderedIds.clear();
    for (const id of rendered) renderedIds.add(id);
  }
}

const libraryItem = (index, fields = {}) => ({
  id: 'card:' + index, title: 'Card ' + index, source: 'wikimedia', type: 'audio',
  country: 'US', language: 'en', ...fields,
});

function layoutCards(host, scroller, columns = () => 1, listTop = () => 100, rowHeight = () => 100) {
  const mount = host.insertBefore.bind(host);
  host.insertBefore = (card, before) => {
    mount(card, before);
    card.getBoundingClientRect = () => {
      const top = listTop() + 30 + Math.floor(host.children.indexOf(card) / columns()) * rowHeight() - scroller.scrollTop;
      return { top, bottom: top + 90 };
    };
  };
}

test('Country keeps the base card through key-by-key typing and clearing across empty results', () => {
  withLibraryDom(({ scroller, host, render }) => {
    layoutCards(host, scroller);
    view.activeSource = 'all';
    view.renderLimit = 8;
    view.items = Array.from({ length: 24 }, (_, index) => libraryItem(index, {
      country: index < 12 ? 'MM' : 'US',
    }));
    render();
    view.renderStart = 12;
    render();
    scroller.scrollTop = 248;
    const before = captureCardAnchor();
    assert.equal(before.id, 'card:14');
    for (const country of ['M', 'MM', 'M']) {
      view.filters.country = country;
      render();
      assert.equal(scroller.scrollTop, 0);
      assert.equal(view.renderStart, 0);
      assert.equal(filteredItemsForCurrentView().length, country === 'M' ? 0 : 12);
    }
    view.filters.country = '';
    render();
    assert.ok(view.renderStart > 0);
    assert.deepEqual(captureCardAnchor(), before);
  });
});

test('clearing Language in one step returns to the original card even after scrolling while filtered', () => {
  withLibraryDom(({ scroller, host, render }) => {
    layoutCards(host, scroller);
    view.activeSource = 'all';
    view.items = Array.from({ length: 24 }, (_, index) => libraryItem(index, {
      language: index % 2 ? 'English' : 'eng',
    }));
    render();
    scroller.scrollTop = 248;
    const before = captureCardAnchor();
    view.filters.language = 'EN';
    render();
    assert.deepEqual(captureCardAnchor(), before);
    scroller.scrollTop = 648;
    scroller.dispatchEvent(new Event('scroll'));
    assert.notEqual(captureCardAnchor().id, before.id);
    view.filters.language = '';
    render();
    assert.deepEqual(captureCardAnchor(), before);
  });
});

test('Language matches common two-letter codes, three-letter codes and English names', () => {
  withLibraryDom(() => {
    view.activeSource = 'all';
    for (const language of ['en', 'Eng', 'ENGLISH']) {
      view.filters.language = language;
      for (const value of ['EN', 'eng', 'English']) {
        assert.equal(itemPassesFilters(libraryItem(0, { language: value })), true);
      }
      assert.equal(itemPassesFilters(libraryItem(0, { language: 'fra' })), false);
      assert.equal(itemPassesFilters(libraryItem(0, { language: '' })), false);
    }
    view.filters.language = 'fr';
    assert.equal(itemPassesFilters(libraryItem(0, { language: 'fre' })), true);
  });
});

test('one search anchor survives the debounce and the arrival of partial provider results', () => {
  withLibraryDom(({ scroller, host, render }) => {
    layoutCards(host, scroller);
    view.activeSource = 'all';
    view.items = Array.from({ length: 24 }, (_, index) => libraryItem(index));
    render();
    scroller.scrollTop = 248;
    const before = captureCardAnchor();
    view.query = 'new';
    syncFilterAnchor();
    view.lastQuery = view.query;
    view.sourceStatus.set('wikimedia', { state: 'loading' });
    render();
    assert.equal(scroller.scrollTop, 0);
    view.items = view.items.map((it) => ({ ...it, __query: 'new' }));
    view.sourceStatus.set('wikimedia', { state: 'ready' });
    render();
    assert.deepEqual(captureCardAnchor(), before);
    view.query = '';
    syncFilterAnchor();
    view.lastQuery = view.query;
    render();
    assert.deepEqual(captureCardAnchor(), before);
  });
});

test('clearing a search whose results exclude the base card restores it', () => {
  withLibraryDom(({ scroller, host, render }) => {
    layoutCards(host, scroller);
    view.activeSource = 'all';
    view.items = Array.from({ length: 24 }, (_, index) => libraryItem(index, {
      __query: index >= 12 ? 'news' : '',
    }));
    render();
    scroller.scrollTop = 248;
    const before = captureCardAnchor();
    view.query = 'news';
    syncFilterAnchor();
    view.lastQuery = view.query;
    render();
    assert.equal(scroller.scrollTop, 0);
    assert.equal(host.children[0].dataset.id, 'card:12');
    view.query = '';
    syncFilterAnchor();
    view.lastQuery = view.query;
    render();
    assert.deepEqual(captureCardAnchor(), before);
  });
});

test('search and box filters share the original card until both are cleared', () => {
  withLibraryDom(({ scroller, host, render }) => {
    layoutCards(host, scroller);
    view.activeSource = 'all';
    view.items = Array.from({ length: 24 }, (_, index) => libraryItem(index, {
      country: index < 12 ? 'US' : 'MM',
      __query: index >= 12 ? 'news' : '',
    }));
    render();
    scroller.scrollTop = 248;
    const before = captureCardAnchor();
    view.query = 'news';
    syncFilterAnchor();
    view.lastQuery = view.query;
    render();
    assert.equal(scroller.scrollTop, 0);
    view.filters.country = 'MM';
    render();
    view.query = '';
    syncFilterAnchor();
    view.lastQuery = view.query;
    render();
    assert.equal(scroller.scrollTop, 0);
    assert.notEqual(captureCardAnchor().id, before.id);
    view.filters.country = '';
    render();
    assert.deepEqual(captureCardAnchor(), before);
  });
});

test('a redraw with a missing anchor starts the filtered list at the top', () => {
  withLibraryDom(({ scroller, host, render }) => {
    layoutCards(host, scroller);
    view.activeSource = 'all';
    const items = Array.from({ length: 24 }, (_, index) => libraryItem(index));
    view.items = items;
    render();
    scroller.scrollTop = 248;
    const before = captureCardAnchor();
    view.filters.language = 'en';
    render();
    assert.deepEqual(captureCardAnchor(), before);
    view.items = items.filter(({ id }) => id !== before.id);
    render();
    assert.equal(scroller.scrollTop, 0);
    view.items = items;
    render();
    assert.deepEqual(captureCardAnchor(), before);
  });
});

test('changing source while filtered drops the original card', () => {
  withLibraryDom(({ scroller, host, render }) => {
    layoutCards(host, scroller);
    view.activeSource = 'all';
    view.items = Array.from({ length: 24 }, (_, index) => libraryItem(index));
    render();
    scroller.scrollTop = 248;
    view.filters.country = 'GB';
    render();
    for (const source of ['wikimedia', 'all']) {
      view.activeSource = source;
      render();
    }
    view.filters.country = '';
    render();
    assert.equal(scroller.scrollTop, 0);
    assert.equal(captureCardAnchor().id, 'card:0');
  });
});

test('clearing a filter uses the nearest surviving old card and retries the original once', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 10_000 });
  for (const late of ['arrives', 'scrolled', 'expired']) {
    withLibraryDom(({ scroller, host, render }) => {
      layoutCards(host, scroller);
      view.activeSource = 'radio-browser';
      const items = Array.from({ length: 24 }, (_, index) => libraryItem(index, {
        source: 'radio-browser', type: 'radio',
      }));
      view.items = items;
      render();
      scroller.scrollTop = 548;
      const before = captureCardAnchor();
      assert.equal(before.id, 'card:5');
      view.filters.language = 'es';
      render();
      view.items = [libraryItem('new', { source: 'radio-browser' }), ...items.filter((item) => (
        !['card:4', 'card:5'].includes(item.id)
      ))];
      view.filters.language = '';
      render();
      assert.deepEqual(captureCardAnchor(), { ...before, id: 'card:6' });
      if (late === 'scrolled') {
        scroller.dispatchEvent(new Event('wheel'));
      }
      t.mock.timers.tick(late === 'expired' ? 2001 : 1999);
      view.items = items;
      render();
      assert.equal(captureCardAnchor().id, late === 'arrives' ? before.id : 'card:6');
      if (late === 'arrives') {
        assert.deepEqual(captureCardAnchor(), before);
        scroller.scrollTop += 100;
        render();
        assert.equal(captureCardAnchor().id, 'card:6');
      }
    });
  }
});

test('a Favorites category and its clearing preserve the anchor and update the count', () => {
  const state = getState();
  const { favorites, settings } = state;
  const previousStorage = globalThis.localStorage;
  try {
    state.favorites = Array.from({ length: 10 }, (_, index) => libraryItem(index, { type: 'tv' }));
    state.settings = { ...settings, favoritesSort: 'manual' };
    globalThis.localStorage = { getItem: (key) => key === STORAGE_KEYS.favoriteGroups ? JSON.stringify({
      version: 1, groups: [{ id: 'shows', name: 'Shows' }],
      assign: Object.fromEntries(state.favorites.slice(1).map(({ id }) => [id, 'shows'])),
    }) : null };
    withLibraryDom(({ scroller, host, render }) => {
      layoutCards(host, scroller);
      view.activeSource = 'favorites';
      view.personalFilters = { ...view.personalFilters, favorites: { query: '', category: '', type: [] } };
      render();
      assert.equal(ui.filterCount.textContent, '10 channels');
      scroller.scrollTop = 248;
      const before = captureCardAnchor();
      view.personalFilters.favorites.category = 'shows';
      render();
      assert.deepEqual(captureCardAnchor(), before);
      assert.equal(ui.filterCount.textContent, '9 channels');
      view.personalFilters.favorites.category = '';
      render();
      assert.deepEqual(captureCardAnchor(), before);
    });
  } finally {
    Object.assign(state, { favorites, settings });
    globalThis.localStorage = previousStorage;
  }
});

test('the filter count uses the full filtered pool and the view loading state', () => {
  withLibraryDom(({ render, host }) => {
    view.activeSource = 'type:radio';
    view.filters.type = 'radio';
    view.items = Array.from({ length: 1_234 }, (_, index) => libraryItem(index, {
      source: 'radio-browser', type: 'radio',
    }));
    view.sourceStatus.set('radio-browser', { state: 'loading' });
    render();
    assert.equal(ui.filterCount.textContent, '1,234 so far');
    assert.ok(host.children.length < view.items.length);
    view.sourceStatus.set('radio-browser', { state: 'complete' });
    render();
    assert.equal(ui.filterCount.textContent, '1,234 stations');
    view.items = [libraryItem(0, { type: 'tv' })];
    view.filters.type = '';
    view.activeSource = 'all';
    render();
    assert.equal(ui.filterCount.textContent, '1 channel');
    view.items = [...view.items, libraryItem(1)];
    render();
    assert.equal(ui.filterCount.textContent, '2 items');
  });
});

test('mixed search reorders around a surviving Computer card and replaces only the revised card', () => {
  withLibraryDom(({ scroller, host, render }) => {
    layoutCards(host, scroller);
    view.activeSource = 'all';
    view.query = view.lastQuery = 'news';
    const local = libraryItem('local', {
      id: 'computer:cover', source: 'computer', __query: 'news', _extra: { computer: { id: 'cover', hasCover: true } },
    });
    const another = libraryItem('other', { id: 'computer:other', source: 'computer', __query: 'news' });
    const provider = libraryItem('provider', { __query: 'news' });
    const stale = libraryItem('stale', { __query: 'news' });
    view.computerHits = [local, another];
    view.items = [provider, stale];
    render();
    scroller.scrollTop = 42;
    const before = captureCardAnchor();
    assert.equal(before.id, local.id);
    const [localCard, otherCard, providerCard, staleCard] = host.children;
    const cover = localCard.__thumb.querySelector('img');
    assert.ok(cover);
    cover.dataset.artworkStarted = 'true';
    cover.classList.add('loaded');
    localCard.__open.focus();
    const freshItem = { ...local, stream_url: 'computer:fresh' };
    view.computerHits = [another, freshItem];
    view.items = [{ ...provider, title: 'Updated', __revision: 1 }];
    render();
    assert.equal(host.children[0], otherCard);
    assert.equal(host.children[1], localCard);
    assert.equal(host.children[1].__item, freshItem);
    assert.equal(localCard.__thumb.querySelector('img'), cover);
    assert.equal(localCard.__artworkAbort.signal.aborted, false);
    assert.equal(providerCard.__artworkAbort.signal.aborted, true);
    assert.equal(staleCard.__artworkAbort.signal.aborted, true);
    assert.equal(host.children[2].__titleNode.textContent, 'Updated');
    assert.equal(document.activeElement, localCard.__open);
    assert.deepEqual(captureCardAnchor(), before);
  });
});

function mockAnchorLayout(t) {
  const globals = {
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    ResizeObserver: globalThis.ResizeObserver,
  };
  const frames = new Map();
  const observations = new Map();
  let nextFrame = 0;
  t.after(() => Object.assign(globalThis, globals));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.requestAnimationFrame = (callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; }
    observe(node) { this.node = node; observations.set(node, this.callback); }
    disconnect() { observations.delete(this.node); }
  };
  return {
    runFrame() {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback();
    },
    resize: (node) => observations.get(node)?.(),
    watching: (node) => observations.has(node),
  };
}

test('a cleared filter holds the same pixel offset while Radio Browser rows settle', (t) => {
  const layout = mockAnchorLayout(t);
  withLibraryDom(({ scroller, host, render }) => {
    let height = 100;
    layoutCards(host, scroller, () => 1, () => 100, () => height);
    view.activeSource = 'radio-browser';
    view.items = Array.from({ length: 30 }, (_, index) => libraryItem(index, {
      source: 'radio-browser', type: 'radio',
    }));
    view.loading = true;
    render();
    scroller.scrollTop = 548;
    const before = captureCardAnchor();
    view.filters.country = 'MM';
    render();
    height = 122;
    view.filters.country = '';
    render();
    assert.deepEqual(captureCardAnchor(), before);

    const check = (newHeight, notify) => {
      height = newHeight;
      assert.notDeepEqual(captureCardAnchor(), before);
      notify();
      assert.deepEqual(captureCardAnchor(), before);
      scroller.dispatchEvent(new Event('scroll'));
    };
    check(118, layout.runFrame);
    check(115, layout.runFrame);
    check(110, () => t.mock.timers.tick(250));
    check(105, () => t.mock.timers.tick(350));
    check(100, () => layout.resize(host));
    t.mock.timers.tick(400);
    assert.equal(layout.watching(host), false);
    height = 99;
    layout.resize(host);
    assert.notDeepEqual(captureCardAnchor(), before);
  });
});

test('card offset correction stops for scroll input and a new search before debounce', (t) => {
  const layout = mockAnchorLayout(t);
  for (const event of [
    new Event('wheel'),
    Object.assign(new Event('keydown'), { key: 'PageDown' }),
    new Event('pointerdown'),
    new Event('touchmove'),
    new Event('scroll'),
    null,
  ]) {
    withLibraryDom(({ scroller, host, render }) => {
      let height = 100;
      layoutCards(host, scroller, () => 1, () => 100, () => height);
      view.activeSource = 'all';
      view.items = Array.from({ length: 20 }, (_, index) => libraryItem(index));
      render();
      scroller.scrollTop = 548;
      assert.equal(restoreCardAnchor(captureCardAnchor()), true);
      assert.equal(layout.watching(host), true);

      if (event?.type === 'scroll') scroller.scrollTop += 20;
      if (event) scroller.dispatchEvent(event);
      else {
        view.query = 'news';
        syncFilterAnchor();
      }
      assert.equal(layout.watching(host), false, event?.type ?? 'new search');
      const scrollTop = scroller.scrollTop;
      height = 110;
      layout.runFrame();
      t.mock.timers.tick(1000);
      assert.equal(scroller.scrollTop, scrollTop);
    });
  }
});

test('detail open and close keep the card at its viewport y when the list top moves', (t) => {
  const layout = mockAnchorLayout(t);
  const microtasks = [];
  t.mock.method(globalThis, 'queueMicrotask', (callback) => microtasks.push(callback));
  withLibraryDom(({ scroller, host, render }) => {
    const detailOpen = () => ui.root.classList.contains('has-detail');
    let extraHeight = 0;
    const listTop = () => (detailOpen() ? 133 : 100) + extraHeight;
    scroller.getBoundingClientRect = () => ({ top: listTop(), bottom: 500 });
    layoutCards(host, scroller, () => detailOpen() ? 2 : 3, listTop);
    view.activeSource = 'all';
    view.items = Array.from({ length: 30 }, (_, index) => libraryItem(index));
    render();
    scroller.scrollTop = 148;
    const card = host.children[8];
    card.__open.focus();
    const before = card.getBoundingClientRect().top;
    try {
      openDetail(card.__item, { focus: true, anchorCard: true });
      assert.equal(card.getBoundingClientRect().top, before);
      microtasks.at(-1)();
      assert.deepEqual(ui.detailPanel.children[0].focusOptions, { preventScroll: true });
      extraHeight = 5;
      layout.runFrame();
      assert.equal(card.getBoundingClientRect().top, before);
      closeDetail();
      assert.equal(card.getBoundingClientRect().top, before);
      extraHeight = 0;
      layout.runFrame();
      assert.equal(card.getBoundingClientRect().top, before);
      extraHeight = 44;
      t.mock.timers.tick(250);
      assert.equal(card.getBoundingClientRect().top, before);
      extraHeight = 88;
      t.mock.timers.tick(350);
      assert.equal(card.getBoundingClientRect().top, before);
      t.mock.timers.tick(400);
      assert.equal(document.activeElement, card.__open);
      assert.deepEqual(card.__open.focusOptions, { preventScroll: true });
    } finally {
      if (ui.detailPanel) closeDetail();
    }
  });
});

test('Library uses shorter filter placeholders while the filter inputs are squeezed', (t) => {
  const previous = globalThis.ResizeObserver;
  t.after(() => { globalThis.ResizeObserver = previous; });
  const observed = [];
  let notify;
  globalThis.ResizeObserver = class {
    constructor(callback) { notify = callback; }
    observe(input) { observed.push(input); }
    disconnect() {}
  };
  withLibraryDom(() => {
    view.activeSource = 'all';
    view.infiniteObserver = null;
    buildShell();
    assert.deepEqual(observed, [ui.countryInput, ui.languageInput, ui.yearMinInput, ui.yearMaxInput]);
    const placeholders = () => observed.map((input) => input.getAttribute('placeholder'));
    const long = placeholders();
    for (const input of observed) input.offsetWidth = parseFloat(input.style.width);
    notify();
    assert.deepEqual(placeholders(), long);
    ui.countryInput.offsetWidth -= 35;
    notify();
    assert.deepEqual(placeholders(), ['Country', 'Language', 'From', 'To']);
    ui.countryInput.offsetWidth += 35;
    notify();
    assert.deepEqual(placeholders(), long);
  });
});

test('Library styles share card dimensions with the estimate and end the side pane above the dock', async () => {
  const css = await read('src/styles/library.css');
  assert.match(css, /\.card \{[^}]*container-type: inline-size;/);
  assert.match(css, /\.card \{[^}]*--card-body-height-estimate: var\(--card-body-min-height\);/);
  assert.match(css, /contain-intrinsic-block-size: auto calc\(100cqi \/ var\(--card-thumb-ratio\) \+ var\(--card-body-height-estimate\)\);/);
  assert.match(css, /\.card-meta \{[^}]*min-height: var\(--card-meta-height\);/);
  const withDetails = css.match(/:root\[data-tech-details="on"\] \.card:has\(\.card-quality\) \{([^}]*)\}/)?.[1] ?? '';
  assert.match(withDetails.replace(/\s+/g, ' '),
    /--card-body-height-estimate: max\(var\(--card-body-min-height\), calc\( var\(--card-title-height\) \+ var\(--card-meta-height\) \+ var\(--card-quality-line-height\) \+ var\(--card-body-gap\) \+ 2 \* var\(--card-body-padding\) \)\);/);
  assert.match(css, /aspect-ratio: var\(--card-thumb-ratio\)/);
  assert.match(css, /contain-intrinsic-block-size: auto calc\(var\(--card-thumb-size\) \+ 2 \* var\(--card-thumb-margin\)\)/);
  assert.match(css, /--detail-dock-height: calc\(var\(--video-height, 0px\) \+ var\(--video-gap\)\)/);
  assert.match(css, /\.detail-panel \{\s*margin-bottom: max\(var\(--video-clearance\), var\(--detail-dock-height, 0px\)\)/);
});

test('a smaller or missing video cannot clamp the Library scroll at the bottom', () => {
  const previousObserver = globalThis.MutationObserver;
  const previousStyle = globalThis.getComputedStyle;
  const app = new FakeNode();
  let sync, disconnected, held = 0, actual = 220;
  const scroller = Object.assign(new FakeNode(), {
    closest: () => app, clientHeight: 400, scrollTop: 520,
    style: { setProperty: (_name, value) => { held = parseInt(value, 10); } },
  });
  Object.defineProperty(scroller, 'scrollHeight', { get: () => 700 + Math.max(actual, held) });
  globalThis.MutationObserver = class {
    constructor(callback) { sync = callback; }
    observe() {}
    disconnect() { disconnected = true; }
  };
  globalThis.getComputedStyle = () => ({ scrollPaddingBottom: actual + 'px' });
  const dispose = bindLibraryVideoClearance(scroller);
  try {
    assert.equal(held, 220);
    actual = 120;
    sync();
    assert.equal(held, 220);
    actual = 0;
    sync();
    assert.equal(held, 220);
    scroller.scrollTop = 200;
    scroller.dispatchEvent(new Event('scroll'));
    assert.equal(held, 0);
  } finally {
    dispose();
    globalThis.MutationObserver = previousObserver;
    globalThis.getComputedStyle = previousStyle;
  }
  assert.equal(disconnected, true);
});

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
