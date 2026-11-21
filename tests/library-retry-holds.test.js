import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getState } from '../src/lib/state.js';
import { CatalogScheduler, catalogScheduler, MAX_RETRY_AFTER_MS } from '../src/lib/catalog-scheduler.js';
import { view } from '../src/modes/library/state.js';
import {
  createSourceProgress, isHeldProgress, recordSourceFailure, RETRY_AFTER_MAX_MS,
} from '../src/modes/library/progress.js';
import {
  loadMore, pauseCatalogWork, reconcileContentPreference, retrySources, runSearch,
} from '../src/modes/library/chain.js';
import { ui } from '../src/modes/library/shell-refs.js';
import { FakeElement } from './helpers/fake-dom.js';

const HOUR = 60 * 60 * 1000;
const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };

class FakeNode extends FakeElement {
  get childNodes() { return this.children; }
  get innerHTML() { return this.textContent; }
  set innerHTML(value) { this.textContent = String(value); this.children = []; }
  replaceChildren(...children) { this.children = children; }
  querySelector() { return null; }
}

/**
 * Runs `body` with only `enabled` sources switched on, fake shell nodes, and
 * the shared scheduler's enqueue replaced by a recorder whose jobs stay open
 * until their signal aborts. Everything shared is put back afterwards.
 */
async function withChain(enabled, body) {
  const state = getState();
  const previousSettings = state.settings;
  const previousDocument = globalThis.document;
  const previousUi = { ...ui };
  const previousEnqueue = catalogScheduler.enqueue;
  const keys = ['activeSource', 'query', 'lastQuery', 'items', 'loading', 'loadingMore', 'exhausted', 'catalogActive', 'loadAbort'];
  const before = Object.fromEntries(keys.map((key) => [key, view[key]]));
  const jobs = [];
  try {
    state.settings = {
      ...previousSettings,
      enabledSources: Object.fromEntries(Object.keys(previousSettings.enabledSources)
        .map((id) => [id, enabled.includes(id)])),
    };
    globalThis.document = {
      createElement: (tag) => new FakeNode('', tag),
      createDocumentFragment: () => new FakeNode('', 'fragment'),
    };
    Object.assign(ui, {
      resultsHost: new FakeNode('', 'div'), statusHost: null, windowBack: null,
      sentinelStatus: new FakeNode('', 'span'), sentinelButton: new FakeNode('', 'button'),
      sidebar: Object.assign(new FakeNode('', 'nav'), { querySelectorAll: () => [] }),
    });
    catalogScheduler.enqueue = (job) => {
      jobs.push(job);
      return new Promise((_resolve, reject) => {
        const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (job.signal?.aborted) abort();
        else job.signal?.addEventListener('abort', abort, { once: true });
      });
    };
    view.activeSource = 'all';
    view.items = [];
    view.exhausted = new Set();
    view.sourceProgress.clear();
    view.sourceCounts.clear();
    view.sourceStatus.clear();
    await body({ jobs });
  } finally {
    pauseCatalogWork();
    catalogScheduler.enqueue = previousEnqueue;
    for (const id of enabled) catalogScheduler.resetSource(id);
    state.settings = previousSettings;
    globalThis.document = previousDocument;
    Object.assign(ui, previousUi);
    for (const key of keys) view[key] = before[key];
    view.sourceProgress.clear();
    view.sourceCounts.clear();
    view.sourceStatus.clear();
  }
}

/** A source inside a two-hour wait it declared, in both the scheduler and its browse progress. */
function holdSource(id, now = Date.now()) {
  const declared = { status: 429, retryAfterMs: 2 * HOUR, message: 'HTTP 429', userMessage: 'Please wait.' };
  const progress = createSourceProgress();
  progress.cursor = 'page-2';
  recordSourceFailure(progress, declared, now);
  view.sourceProgress.set(id, progress);
  catalogScheduler.recordFailure(id, declared);
  return progress;
}

/** A source in an ordinary failure backoff (nothing declared). */
function backOffSource(id, now = Date.now()) {
  const failure = { status: 502, message: 'HTTP 502' };
  const progress = createSourceProgress();
  recordSourceFailure(progress, failure, now);
  view.sourceProgress.set(id, progress);
  catalogScheduler.recordFailure(id, failure);
  return progress;
}

test('Retry now leaves a source inside a declared wait alone and retries the rest', async () => {
  await withChain(['nasa', 'wikimedia'], async () => {
    view.catalogActive = false; // no follow-up fetches; only the reset is checked
    const held = holdSource('wikimedia');
    const retried = backOffSource('nasa');
    assert.ok(catalogScheduler.cooldownRemainingMs('nasa') > 0);

    retrySources({ restartExhausted: false });

    assert.ok(catalogScheduler.declaredCooldownRemainingMs('wikimedia') > HOUR, 'the declared cooldown is untouched');
    assert.equal(view.sourceProgress.get('wikimedia'), held);
    assert.equal(isHeldProgress(held), true);
    assert.equal(held.notice, 'Please wait.');
    assert.equal(catalogScheduler.cooldownRemainingMs('nasa'), 0, 'the other source retries now');
    assert.equal(retried.retryAt, 0);
    assert.equal(retried.error, '');
  });
});

test('Retry now during a search does not reset a declared cooldown', async () => {
  await withChain(['nasa', 'wikimedia'], async ({ jobs }) => {
    holdSource('wikimedia');
    backOffSource('nasa');
    view.query = 'moon';
    view.lastQuery = 'moon';
    retrySources();
    await flush();
    assert.ok(catalogScheduler.declaredCooldownRemainingMs('wikimedia') > HOUR);
    assert.equal(catalogScheduler.cooldownRemainingMs('nasa'), 0);
    assert.equal(view.sourceStatus.get('wikimedia').state, 'rate-limited', 'it still says it is waiting');
    assert.ok(jobs.some((job) => job.sourceId === 'nasa' && job.key.startsWith('search:')));
  });
});

test('changing the content preference keeps a declared wait but restarts the list', async () => {
  await withChain(['gpodder', 'peertube'], async () => {
    view.catalogActive = false;
    holdSource('peertube');
    backOffSource('gpodder');

    reconcileContentPreference(false, false);

    const held = view.sourceProgress.get('peertube');
    assert.equal(held.cursor, null, 'the list starts again for the new preference');
    assert.equal(isHeldProgress(held), true, 'but the wait is kept');
    assert.equal(held.notice, 'Please wait.');
    assert.ok(catalogScheduler.declaredCooldownRemainingMs('peertube') > HOUR);
    assert.equal(view.sourceStatus.get('peertube').state, 'rate-limited');
    assert.equal(catalogScheduler.cooldownRemainingMs('gpodder'), 0, 'the other source is reset as before');
    assert.equal(view.sourceProgress.get('gpodder').retryAt, 0);
  });
});

test('the scheduler and browse progress share one six-hour cap on a declared wait', () => {
  assert.equal(MAX_RETRY_AFTER_MS, 6 * HOUR);
  assert.equal(RETRY_AFTER_MAX_MS, MAX_RETRY_AFTER_MS);
  let time = 0;
  const scheduler = new CatalogScheduler({ now: () => time });
  scheduler.recordFailure('slow', { status: 429, retryAfterMs: 5 * HOUR });
  assert.equal(scheduler.declaredCooldownRemainingMs('slow'), 5 * HOUR, 'not cut to one hour');
  scheduler.recordFailure('slow', { status: 429, retryAfterMs: 9 * HOUR });
  assert.equal(scheduler.declaredCooldownRemainingMs('slow'), 6 * HOUR);
  time += 5.5 * HOUR;
  assert.equal(scheduler.declaredCooldownRemainingMs('slow'), 0.5 * HOUR);
  scheduler.destroy();
});

test('clearing a search reschedules a browse page whose old request unwinds after the statuses were restored', async () => {
  await withChain(['nasa'], async ({ jobs }) => {
    // A search is shown and NASA's background browse page is in flight.
    view.catalogActive = true;
    view.query = 'moon';
    view.lastQuery = 'moon';
    view.loadAbort = new AbortController();
    const progress = createSourceProgress();
    Object.assign(progress, { cursor: 'page-2', loaded: 5 });
    view.sourceProgress.set('nasa', progress);
    view.sourceCounts.set('nasa', 5);
    void loadMore();
    await flush();
    assert.equal(jobs.length, 1);
    assert.equal(progress.inFlight, true);

    // The search is cleared. The old page is aborted, but its `finally` only
    // runs after the new generation has restored the statuses.
    view.query = '';
    void runSearch();
    assert.equal(view.sourceStatus.get('nasa').state, 'loading', 'restored while the old request unwinds');
    assert.equal(view.chainTimer, null, 'nothing was scheduled for it yet');

    await flush();
    assert.equal(progress.inFlight, false);
    assert.equal(view.sourceStatus.get('nasa').state, 'more', 'no longer stuck as loading');
    assert.notEqual(view.chainTimer, null, 'scheduled again');

    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(jobs.length, 2, 'the next browse page was requested');
    assert.match(jobs[1].key, /^browse:/);
  });
});

/** A source held only in its browse progress: a 403 with a declared wait,
 *  which the scheduler does not treat as a cooldown. */
function holdInProgressOnly(id, now = Date.now()) {
  const blocked = { status: 403, retryAfterMs: 2 * HOUR, message: 'HTTP 403', userMessage: 'Blocked for now.' };
  const progress = createSourceProgress();
  recordSourceFailure(progress, blocked, now);
  view.sourceProgress.set(id, progress);
  catalogScheduler.recordFailure(id, blocked);
  return progress;
}

test('a search, and Retry now during one, never contacts a held source', async () => {
  await withChain(['nasa', 'wikimedia', 'librivox'], async ({ jobs }) => {
    holdInProgressOnly('wikimedia');
    assert.equal(catalogScheduler.cooldownRemainingMs('wikimedia'), 0, 'the scheduler alone would let it through');
    // Held only by a cooldown the provider declared to the scheduler.
    catalogScheduler.recordFailure('librivox', { status: 429, retryAfterMs: 2 * HOUR });
    backOffSource('nasa');
    view.query = 'moon';
    view.lastQuery = 'moon';

    void runSearch();
    await flush();
    const searched = () => jobs.filter((job) => job.key.startsWith('search:')).map((job) => job.sourceId);
    assert.deepEqual(searched(), ['nasa']);
    assert.equal(view.sourceStatus.get('wikimedia').state, 'rate-limited');
    assert.equal(view.sourceStatus.get('wikimedia').notice, 'Blocked for now.');
    assert.equal(view.sourceStatus.get('librivox').state, 'rate-limited');
    assert.ok(view.sourceStatus.get('librivox').retryAt > Date.now() + HOUR);

    jobs.length = 0;
    retrySources();
    await flush();
    assert.deepEqual(searched(), ['nasa'], 'Retry now searches only the source that is not held');
    assert.equal(isHeldProgress(view.sourceProgress.get('wikimedia')), true);
    assert.ok(catalogScheduler.declaredCooldownRemainingMs('librivox') > HOUR);
  });
});

test('a held source skipped by a preference change resumes when its wait ends', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  await withChain(['peertube'], async ({ jobs }) => {
    view.catalogActive = true;
    view.loadAbort = new AbortController();
    const browsed = () => jobs.filter((job) => job.sourceId === 'peertube' && job.key.startsWith('browse:'));

    // Turning the preference off, with nothing else in flight.
    holdSource('peertube');
    reconcileContentPreference(true, false);
    await flush();
    assert.notEqual(view.chainTimer, null, 'a wake-up is armed for the end of the wait');
    t.mock.timers.tick(HOUR);
    await flush();
    assert.equal(browsed().length, 0, 'nothing before the wait ends');
    t.mock.timers.tick(HOUR + 1_000);
    await flush();
    assert.equal(browsed().length, 1, 'the next page is requested when the wait ends');

    // Turning it on again, with a new wait and nothing else in flight.
    jobs.length = 0;
    holdSource('peertube');
    await reconcileContentPreference(false, true);
    await flush();
    assert.equal(jobs.length, 0, 'the held source is not contacted');
    assert.notEqual(view.chainTimer, null);
    t.mock.timers.tick(2 * HOUR + 1_000);
    await flush();
    assert.equal(browsed().length, 1);
  });
});

test('the first browse page after Retry now asks afresh (force); the pages after it do not', async () => {
  await withChain(['gpodder'], async ({ jobs }) => {
    view.catalogActive = false;
    const progress = backOffSource('gpodder');
    retrySources({ restartExhausted: false });
    assert.equal(view.sourceProgress.get('gpodder'), progress);
    assert.equal(progress.forceNext, true, 'marked for the next page');

    view.catalogActive = true;
    view.loadAbort = new AbortController();
    void loadMore();
    await flush();
    assert.equal(jobs.filter((job) => job.sourceId === 'gpodder' && job.key.startsWith('browse:')).length, 1);
    assert.equal(progress.forceNext, false, 'used by that page only');
  });
  const chain = (await readFile(new URL('../src/modes/library/chain.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const page = chain.slice(chain.indexOf('async function fetchBrowsePage('), chain.indexOf('export function maybeLoadMore('));
  assert.match(page, /const force = progress\.forceNext === true;\n\s+progress\.forceNext = false;/);
  assert.match(page, /browsePageOne\(sourceId, \{\n\s+limit: PAGE_SIZE,\n\s+cursor: progress\.cursor,\n\s+signal,\n\s+\.\.\.\(force \? \{ force: true \} : \{\}\),\n\s+\}\)/);
});

test('a search failure shows a declared wait capped like the scheduler and browse', async () => {
  const chain = await readFile(new URL('../src/modes/library/chain.js', import.meta.url), 'utf8');
  const record = chain.slice(chain.indexOf('function recordSearchFailure('));
  assert.match(record, /retryAt: Date\.now\(\) \+ Math\.min\(RETRY_AFTER_MAX_MS, Number\(error\?\.retryAfterMs \|\| 0\)\),/);
  assert.match(chain, /recordSourceSuccess, RETRY_AFTER_MAX_MS,[\s\S]*?\} from '\.\/progress\.js';/);
  assert.equal(RETRY_AFTER_MAX_MS, MAX_RETRY_AFTER_MS);
});
