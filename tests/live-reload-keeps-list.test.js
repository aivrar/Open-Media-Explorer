import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  LIVE_RETRY_DELAYS_MS, createLiveRetry, failedSourceState, liveStatusText, mergeSourceItems,
  pendingSourcesText, refreshKeepsList, runLiveLoad,
} from '../src/lib/live-load.js';
import { emptyLiveText, tunerListKey } from '../src/modes/tuner.js';

const read = async (path) => (await readFile(new URL(`../${path}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const item = (id, source, type = 'radio') => ({ id, source, type, title: id });

function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    setTimeout(fn, ms) { const id = next++; pending.set(id, { fn, ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    fireNext() {
      const [id, entry] = [...pending][0];
      pending.delete(id);
      entry.fn();
      return entry.ms;
    },
    pending,
  };
}

test('a reload of the same view keeps the list; a new view starts empty', () => {
  const list = [item('a', 'radio-browser')];
  assert.equal(refreshKeepsList('radio||all', 'radio||all', list), true);
  assert.equal(refreshKeepsList('radio||all', 'tv||all', list), false, 'another band');
  assert.equal(refreshKeepsList('radio||all', 'radio|DE|all', list), false, 'another country');
  assert.equal(refreshKeepsList('radio||all', 'radio||all', []), false, 'nothing to keep');
  assert.equal(refreshKeepsList('', '', list), false, 'no key yet');
  const tuner = { band: 'radio', country: '', sourceFilter: 'all', enabled: '111', showExplicit: false };
  const same = tunerListKey(tuner);
  assert.equal(tunerListKey({ ...tuner }), same);
  for (const change of [{ band: 'tv' }, { country: 'DE' }, { sourceFilter: 'radio-browser' }, { enabled: '101' }, { showExplicit: true }]) {
    assert.notEqual(tunerListKey({ ...tuner, ...change }), same, JSON.stringify(change));
  }
});

test('a source that fails on a reload keeps its earlier stations and the status line says so', () => {
  // 80 stations from one source, two sources with nothing for radio.
  const earlier = Array.from({ length: 80 }, (_, index) => item(`rb-${index}`, 'radio-browser'));
  let list = earlier;
  const states = new Map([
    ['radio-browser', { state: 'loading', count: 80, refreshing: true }],
    ['owncast', { state: 'loading', count: 0, refreshing: true }],
    ['peertube', { state: 'loading', count: 0, refreshing: true }],
  ]);
  assert.equal(liveStatusText({ count: 80, noun: 'stations', sourceStates: states, loading: true }),
    '80 stations from 3 sources \u00b7 refreshing 3 sources\u2026');
  list = mergeSourceItems(list, 'owncast', [], 'radio');
  states.set('owncast', { state: 'ready', count: 0 });
  list = mergeSourceItems(list, 'peertube', [], 'radio');
  states.set('peertube', { state: 'ready', count: 0 });
  states.set('radio-browser', failedSourceState(list, 'radio-browser', 'Timed out'));
  assert.equal(list.length, 80, 'the earlier list stays on the dial');
  assert.deepEqual(states.get('radio-browser'), { state: 'stale', count: 80, error: 'Timed out' });
  assert.equal(liveStatusText({ count: list.length, noun: 'stations', sourceStates: states, loading: false }),
    '80 stations from 3 sources \u00b7 1 source could not be refreshed (earlier list kept)');
  // A first load that fails has nothing to keep: the source is unavailable.
  assert.deepEqual(failedSourceState([], 'radio-browser', 'down'), { state: 'error', count: 0, error: 'down' });
  assert.deepEqual(failedSourceState(undefined, 'x', undefined), { state: 'error', count: 0, error: '' });
});

test('compact Tuner captions keep the count and a short source status', () => {
  const caption = (count, states, loading = false) => liveStatusText({
    count, noun: 'stations', sourceStates: new Map(Object.entries(states)), loading, compact: true,
  });
  assert.equal(caption(0, { a: { state: 'loading' } }, true), 'Loading 1 live source…');
  assert.equal(caption(0, {}), '0 stations');
  assert.equal(caption(0, { a: { state: 'error' } }), '0 stations · 1 unavailable');
  assert.equal(caption(80, { a: { state: 'ready' }, b: { state: 'ready' }, c: { state: 'ready' } }),
    '80 stations from 3 sources');
  assert.equal(caption(80, { a: { state: 'stale' }, b: { state: 'loading' } }, true),
    '80 stations from 1 source · 1 out of date · updating…');
});

test('the live status line counts sources and names failures, refreshes and pending sources', () => {
  const map = (entries) => new Map(Object.entries(entries));
  assert.equal(liveStatusText({ count: 0, noun: 'stations', sourceStates: new Map(), loading: true, sourceCount: 4 }),
    'Loading 4 live sources\u2026');
  assert.equal(liveStatusText({ count: 0, noun: 'stations', sourceStates: map({ a: { state: 'loading' } }), loading: true }),
    'Loading 1 live source\u2026');
  assert.equal(liveStatusText({ count: 0, noun: 'stations', sourceStates: new Map(), loading: true, sourceCount: 1 }),
    'Loading 1 live source\u2026');
  // Stations are never shown as coming "from 0 sources".
  assert.equal(liveStatusText({ count: 80, noun: 'stations', sourceStates: new Map(), loading: true, sourceCount: 3 }),
    '80 stations');
  assert.equal(liveStatusText({ count: 0, noun: 'stations', sourceStates: map({ a: { state: 'error' } }), loading: false }),
    '0 stations \u00b7 1 unavailable');
  assert.equal(liveStatusText({ count: 0, noun: 'stations', sourceStates: map({ a: { state: 'ready' }, b: { state: 'ready' }, c: { state: 'error' } }), loading: false }),
    '0 stations from 2 sources \u00b7 1 unavailable');
  assert.equal(liveStatusText({ count: 12, noun: 'live items', sourceStates: map({ a: { state: 'ready' }, b: { state: 'loading' } }), loading: true }),
    '12 live items from 1 source \u00b7 loading 1 more source\u2026');
  assert.equal(liveStatusText({ count: 9, noun: 'channels', sourceStates: map({ a: { state: 'stale' }, b: { state: 'stale' }, c: { state: 'error' } }), loading: false }),
    '9 channels from 2 sources \u00b7 2 sources could not be refreshed (earlier list kept) \u00b7 1 unavailable');
  assert.equal(pendingSourcesText(map({ a: { state: 'loading', refreshing: true } })), ' \u00b7 refreshing 1 source\u2026');
  assert.equal(pendingSourcesText(map({ a: { state: 'loading', refreshing: true }, b: { state: 'loading' } })), ' \u00b7 loading 2 more sources\u2026');
});

test('the Tuner mark the requested sources before drawing their counts', async () => {
  const path = 'src/modes/tuner.js';
  const [start, end] = ['async function loadStations(', 'function finishLoad()'];
  const [list, render] = ['state.stations', 'renderStationCaption'];
  const source = await read(path);
  const load = source.slice(source.indexOf(start), source.indexOf(end));
  const asked = load.indexOf('const candidates = liveSources().filter(');
  const marked = load.indexOf("state.sourceStates.set(source.id, refresh\n");
  const drawn = load.indexOf(`${render}();`);
  assert.ok(asked > 0 && marked > asked, `${path}: the sources are chosen, then marked`);
  assert.ok(drawn > marked, `${path}: the first status line comes after they are marked`);
  assert.equal(load.split("state.sourceStates.set(source.id, refresh\n").length, 2, `${path}: marked once`);
  assert.match(load, new RegExp(`count: ${list.replace('.', '\\.')}\\.filter\\(\\(item\\) => item\\.source === source\\.id\\)\\.length, refreshing: true`), path);
  // Without a known state the count is of the chosen sources only.
  assert.match(source, /sourceCount: chosenLiveSourceCount\(\),/, path);
  assert.match(source, /function chosenLiveSourceCount\(\) \{\n\s+return liveSources\(\)\.filter\(\(source\) => state\.sourceFilter === 'all' \|\| source\.id === state\.sourceFilter\)\.length;/, path);
});

test('an empty view left by a failed source tries again by itself twice, after 8 s and 20 s', () => {
  assert.deepEqual([...LIVE_RETRY_DELAYS_MS], [8_000, 20_000]);
  const timers = fakeTimers();
  let runs = 0;
  const retry = createLiveRetry({ run: () => { runs += 1; }, timers });
  assert.equal(retry.settle(false), false, 'a load that worked waits for nothing');
  assert.equal(retry.waiting(), false);
  assert.equal(retry.settle(true), true);
  assert.equal(retry.waiting(), true);
  assert.equal(timers.pending.size, 1);
  assert.equal(timers.fireNext(), 8_000);
  assert.equal(runs, 1);
  assert.equal(retry.tries(), 1);
  assert.equal(retry.waiting(), false);
  // The automatic load failed again.
  assert.equal(retry.settle(true), true);
  assert.equal(timers.fireNext(), 20_000);
  assert.equal(runs, 2);
  assert.equal(retry.settle(true), false, 'no third try');
  assert.equal(timers.pending.size, 0);
  assert.equal(retry.tries(), 2);
});

test('only one automatic try waits at a time, a user reload cancels it, and none runs off screen', () => {
  const timers = fakeTimers();
  let runs = 0;
  let shown = true;
  const retry = createLiveRetry({ run: () => { runs += 1; }, isShown: () => shown, timers });
  retry.settle(true);
  retry.settle(true);
  assert.equal(timers.pending.size, 1, 'never two waiting');
  retry.reset();
  assert.equal(timers.pending.size, 0, 'a reload the user asked for cancels the wait');
  assert.equal(retry.tries(), 0);
  retry.settle(true);
  retry.stop();
  assert.equal(timers.pending.size, 0, 'leaving the view cancels the wait');
  assert.equal(runs, 0);
  retry.settle(true);
  shown = false;
  timers.fireNext();
  assert.equal(runs, 0, 'nothing is asked while the view is not on screen');
  assert.equal(retry.settle(true), false, 'and no further tries until the user reloads');
  retry.reset();
  shown = true;
  assert.equal(retry.settle(true), true);
  timers.fireNext();
  assert.equal(runs, 1);
});

test('the empty Tuner say truthfully whether they will try again', () => {
  const failed = new Map([['a', { state: 'ready' }], ['b', { state: 'error' }]]);
  assert.equal(emptyLiveText(false, failed), 'The stations could not be loaded. Press Radio or TV above to try again.');
  assert.match(emptyLiveText(false, failed, { waiting: true, tries: 0 }), /Trying again by itself in a few seconds, or press Radio or TV above to try now\./);
  assert.match(emptyLiveText(false, failed, { waiting: true, tries: 1 }), /Trying again by itself/);
  assert.equal(emptyLiveText(false, failed, { waiting: false, tries: 2 }),
    'The stations could not be loaded, also after trying again. Press Radio or TV above to try again.');
  assert.equal(emptyLiveText(false, new Map([['a', { state: 'ready' }]]), { waiting: true }), 'No stations found for this country.');
  assert.equal(emptyLiveText(true, failed, { waiting: true }), 'Loading stations\u2026');
});

test('the Tuner keep a refreshed list, mark failed sources and wire the automatic tries', async () => {
  const tuner = await read('src/modes/tuner.js');
  const loadStations = tuner.slice(tuner.indexOf('async function loadStations('), tuner.indexOf('function applyContentPreference('));
  assert.match(loadStations, /if \(!automatic\) autoRetry\.reset\(\);/);
  assert.match(loadStations, /const refresh = !preserve && refreshKeepsList\(state\.listKey, key, state\.stations\);/);
  assert.match(loadStations, /if \(!preserve && !refresh\) \{\n\s+setStations\(\[\]\);/);
  assert.match(loadStations, /failedSourceState\(state\.stations, source\.id, message\)/);
  assert.match(loadStations, /autoRetry\.settle\(state\.stations\.length === 0/);
  assert.match(tuner, /run: \(\) => \{ loadStations\(\{ automatic: true \}\); \}/);
  assert.match(tuner, /isShown: \(\) => getState\(\)\.mode === 'tuner'/);
  const tearDown = tuner.slice(tuner.indexOf('function tearDown() {'), tuner.indexOf('export function renderTuner('));
  assert.match(tearDown, /autoRetry\.stop\(\);/);
  const favorites = tuner.slice(tuner.indexOf('function loadFavoriteStations() {'), tuner.indexOf('async function loadStations('));
  assert.match(favorites, /autoRetry\.reset\(\);/);

  // Only the current load can settle the automatic retry.
  const source = tuner;
  const name = 'Tuner';
  assert.match(source, /isCurrent: \(\) => gen === state\.loadGen,/, name);
  assert.match(source, /onDone: finishLoad,/, name);
  assert.match(source, /if \(gen === state\.loadGen\) finishLoad\(\);/, name);
  assert.equal(source.split('autoRetry.settle(').length, 2, `${name}: one settle`);
  const finish = source.slice(source.indexOf('function finishLoad() {'));
  assert.match(finish.slice(0, finish.indexOf('\n}\n')), /autoRetry\.settle\(/, name);
  assert.doesNotMatch(source, /Promise\.allSettled/, `${name}: the loop lives in runLiveLoad`);
});

test('a load overtaken by a newer one never changes the list, the source states or the automatic tries', async () => {
  const sources = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const view = { gen: 0, list: [], states: new Map(), settles: 0 };
  const answers = new Map();
  const ask = (source) => new Promise((resolve, reject) => answers.set(`${view.gen}:${source.id}`, { resolve, reject }));
  const load = () => {
    const gen = ++view.gen;
    return runLiveLoad({
      candidates: sources,
      signal: new AbortController().signal,
      ask,
      isCurrent: () => gen === view.gen,
      onItems: (source, items) => {
        view.states.set(source.id, 'ready');
        view.list = mergeSourceItems(view.list, source.id, items, 'radio');
      },
      onFailed: (source, message) => { view.states.set(source.id, failedSourceState(view.list, source.id, message).state); },
      onDone: () => { view.settles += 1; },
      timers: { setTimeout: () => 0, clearTimeout() {} },
    });
  };
  const first = load();
  await Promise.resolve();
  answers.get('1:a').resolve([item('a1', 'a')]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(view.list.map((station) => station.id), ['a1']);
  // A newer load starts; the first one's late answers and failures change nothing.
  const second = load();
  await Promise.resolve();
  answers.get('1:b').resolve([item('b1', 'b')]);
  answers.get('1:c').reject(new Error('down'));
  await first;
  assert.deepEqual(view.list.map((station) => station.id), ['a1']);
  assert.deepEqual([...view.states.keys()], ['a']);
  assert.equal(view.settles, 0, 'the overtaken load never reaches its end');
  // The current load reports and ends normally.
  answers.get('2:a').resolve([item('a2', 'a')]);
  answers.get('2:b').reject(new Error('down'));
  answers.get('2:c').reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
  await second;
  assert.deepEqual(view.list.map((station) => station.id), ['a2']);
  assert.equal(view.states.get('b'), 'error');
  assert.equal(view.states.has('c'), false, 'a plain cancellation is not a failure');
  assert.equal(view.settles, 1);
});

test('a source past its time limit is reported as timed out', async () => {
  const timers = fakeTimers();
  const failures = [];
  const loading = runLiveLoad({
    candidates: [{ id: 'slow' }],
    signal: new AbortController().signal,
    ask: (_source, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
    isCurrent: () => true,
    onItems() { assert.fail('no answer'); },
    onFailed: (source, message) => failures.push([source.id, message]),
    onDone() {},
    timeoutMs: 5_000,
    timers,
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(timers.fireNext(), 5_000);
  await loading;
  assert.deepEqual(failures, [['slow', 'Timed out']]);
});

function fakeVisibility(visible = true) {
  const listeners = new Set();
  return {
    visible,
    isVisible() { return this.visible; },
    whenVisible: (callback) => { listeners.add(callback); return () => listeners.delete(callback); },
    show() { this.visible = true; for (const callback of [...listeners]) callback(); },
    listeners,
  };
}

test('a try due while the window is hidden is made once the window is shown again', () => {
  const timers = fakeTimers();
  const window = fakeVisibility(false);
  let runs = 0;
  const retry = createLiveRetry({
    run: () => { runs += 1; }, timers, isVisible: () => window.isVisible(), whenVisible: window.whenVisible,
  });
  retry.settle(true);
  timers.fireNext();
  assert.equal(runs, 0, 'nothing while hidden');
  assert.equal(window.listeners.size, 1, 'one listener');
  assert.equal(retry.waiting(), true, 'the empty view still truthfully says it will try');
  retry.settle(true);
  assert.equal(window.listeners.size, 0, 'a new wait replaces the old one');
  assert.equal(timers.pending.size, 1);
  timers.fireNext();
  assert.equal(window.listeners.size, 1);
  window.show();
  window.show();
  assert.equal(runs, 1, 'made once');
  assert.equal(window.listeners.size, 0, 'the listener is removed');
  assert.equal(retry.waiting(), false);
  assert.equal(retry.tries(), 1);
});

test('a reset or a stop while waiting for the window never runs the try', () => {
  for (const end of ['reset', 'stop']) {
    const timers = fakeTimers();
    const window = fakeVisibility(false);
    let runs = 0;
    const retry = createLiveRetry({
      run: () => { runs += 1; }, timers, isVisible: () => window.isVisible(), whenVisible: window.whenVisible,
    });
    retry.settle(true);
    timers.fireNext();
    assert.equal(window.listeners.size, 1, end);
    retry[end]();
    assert.equal(window.listeners.size, 0, `${end} removes the listener`);
    assert.equal(retry.waiting(), false, end);
    window.show();
    assert.equal(runs, 0, end);
  }
  // Shown again after the view was closed: no request.
  const timers = fakeTimers();
  const window = fakeVisibility(false);
  let shown = true;
  let runs = 0;
  const retry = createLiveRetry({
    run: () => { runs += 1; }, isShown: () => shown, timers,
    isVisible: () => window.isVisible(), whenVisible: window.whenVisible,
  });
  retry.settle(true);
  timers.fireNext();
  shown = false;
  window.show();
  assert.equal(runs, 0);
});
