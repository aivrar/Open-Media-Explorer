import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  LINE_BACK_QUIET_MS, SOURCE_RETRY_DELAYS_MS, createSourceRetries, failedSourceState, mergeSourceItems,
  runLiveLoad, sourceRetryDelay,
} from '../src/lib/live-load.js';

const read = async (path) => (await readFile(new URL(`../${path}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const item = (id, source) => ({ id, source, type: 'tv', title: id });
const flush = () => new Promise((resolve) => setImmediate(resolve));
const abortError = () => Object.assign(new Error('cancelled'), { name: 'AbortError' });
// The per-source time limits are not what these tests look at.
const noDeadlines = { setTimeout: () => 0, clearTimeout() {} };

function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    setTimeout(fn, ms) { const id = next++; pending.set(id, { fn, ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    /** Fire every timer waiting now; returns their delays. */
    fireAll() {
      const due = [...pending];
      for (const [id] of due) pending.delete(id);
      for (const [, entry] of due) entry.fn();
      return due.map(([, entry]) => entry.ms);
    },
    delays: () => [...pending.values()].map((entry) => entry.ms),
    pending,
  };
}

function fakeEvents() {
  const listeners = new Set();
  return {
    listen: (callback) => { listeners.add(callback); return () => listeners.delete(callback); },
    emit: (value) => { for (const callback of [...listeners]) callback(value); },
    listeners,
  };
}

/**
 * A Tuner or Grid in miniature, wired as the real views are: one load asks
 * every source through runLiveLoad, a failure goes to the retries, a retry
 * runs one source through runLiveLoad and merges as a late answer does.
 */
function makeView(sources, options = {}) {
  const timers = fakeTimers();
  const online = fakeEvents();
  const answers = fakeEvents();
  const view = { list: [], states: new Map(), asked: [], open: new Map(), gen: 0, timers, online, answers };
  view.retries = createSourceRetries({
    timers, isVisible: () => true, whenVisible: () => null,
    onOnline: online.listen, onAnswer: answers.listen, lastAnswerAt: () => 0,
    now: () => view.clock || 0,
    ...options,
  });
  const ask = (source, signal, attempt = 0) => new Promise((resolve, reject) => {
    view.asked.push(attempt ? `${source.id} again` : source.id);
    view.open.set(source.id, { resolve, reject, signal });
    signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
  view.load = () => {
    const gen = ++view.gen;
    view.retries.stop();
    view.states = new Map();
    const onItems = (source, items) => {
      view.states.set(source.id, 'ready');
      view.retries.succeeded(source.id);
      view.list = mergeSourceItems(view.list, source.id, items, 'tv');
    };
    const onFailed = (source, message, error) => {
      view.states.set(source.id, failedSourceState(view.list, source.id, message).state);
      view.retries.fail(source, retrySource, { error, declaredMs: view.declaredMs || 0 });
    };
    const retrySource = (source, signal, isCurrent, attempt) => runLiveLoad({
      candidates: [source], signal, ask: (one, oneSignal) => ask(one, oneSignal, attempt),
      isCurrent, onItems, onFailed, onDone() {}, timers: noDeadlines,
    });
    return runLiveLoad({
      candidates: sources, signal: new AbortController().signal, ask,
      isCurrent: () => gen === view.gen, onItems, onFailed, onDone() {}, timers: noDeadlines,
    });
  };
  view.answer = (id, items) => view.open.get(id).resolve(items);
  view.refuse = (id, error = new Error('down')) => view.open.get(id).reject(error);
  return view;
}

const RADIO = { id: 'radio-browser' };
const IPTV = { id: 'iptv-org' };
const OWNCAST = { id: 'owncast' };

test('a failed source is tried again on its own after 15 s, 60 s and then every 5 minutes', () => {
  assert.deepEqual([...SOURCE_RETRY_DELAYS_MS], [15_000, 60_000, 300_000]);
  assert.deepEqual([0, 1, 2, 3, 9].map((tries) => sourceRetryDelay(tries)), [15_000, 60_000, 300_000, 300_000, 300_000]);
  const timers = fakeTimers();
  const runs = [];
  const retries = createSourceRetries({ timers, isVisible: () => true, onOnline: null });
  const run = (source, signal, isCurrent, attempt) => { runs.push([source.id, attempt, isCurrent()]); };
  const seen = [];
  retries.fail(IPTV, run);
  for (let step = 0; step < 4; step += 1) {
    seen.push(...timers.fireAll());
    retries.fail(IPTV, run); // the try failed again
  }
  assert.deepEqual(seen, [15_000, 60_000, 300_000, 300_000]);
  assert.deepEqual(runs.map(([id, , current]) => [id, current]), Array(4).fill(['iptv-org', true]));
  assert.equal(new Set(runs.map(([, attempt]) => attempt)).size, 4, 'every try is a job of its own');
  assert.equal(retries.tries('iptv-org'), 4);
  retries.succeeded('iptv-org');
  assert.deepEqual(retries.pending(), []);
  assert.equal(timers.pending.size, 0);
});

test('one source fails while another answers; the failed one is tried again and merged behind the list', async () => {
  const view = makeView([RADIO, IPTV]);
  const loading = view.load();
  await flush();
  view.answer('radio-browser', [item('r1', 'radio-browser'), item('r2', 'radio-browser')]);
  view.refuse('iptv-org', new Error('Timed out'));
  await loading;
  assert.deepEqual(view.list.map(({ id }) => id), ['r1', 'r2']);
  assert.equal(view.states.get('iptv-org'), 'error', 'the status line still says it is unavailable');
  assert.deepEqual(view.timers.delays(), [15_000]);
  // The user is on r2: its place stays.
  const selected = 'r2';
  const before = view.list.findIndex(({ id }) => id === selected);
  view.timers.fireAll();
  await flush();
  assert.deepEqual(view.asked, ['radio-browser', 'iptv-org', 'iptv-org again']);
  assert.equal(view.states.get('iptv-org'), 'error', 'unchanged while the try is on its way');
  view.answer('iptv-org', [item('t1', 'iptv-org'), item('t2', 'iptv-org')]);
  await flush();
  assert.deepEqual(view.list.map(({ id }) => id), ['r1', 'r2', 't1', 't2'], 'added after what is shown');
  assert.equal(view.list.findIndex(({ id }) => id === selected), before);
  assert.equal(view.states.get('iptv-org'), 'ready');
  assert.deepEqual(view.retries.pending(), []);
  assert.equal(view.timers.pending.size, 0);
  assert.equal(view.retries.listening(), false, 'no listener once nothing waits');
});

test('a try that fails again goes to the next step', async () => {
  const view = makeView([RADIO, IPTV]);
  const loading = view.load();
  await flush();
  view.answer('radio-browser', [item('r1', 'radio-browser')]);
  view.refuse('iptv-org');
  await loading;
  view.timers.fireAll();
  await flush();
  view.refuse('iptv-org');
  await flush();
  assert.deepEqual(view.timers.delays(), [60_000]);
  assert.deepEqual(view.list.map(({ id }) => id), ['r1']);
});

test('leaving the view cancels a waiting try and aborts one on its way; a late answer is ignored', async () => {
  const view = makeView([RADIO, IPTV, OWNCAST]);
  const loading = view.load();
  await flush();
  view.answer('radio-browser', [item('r1', 'radio-browser')]);
  view.refuse('iptv-org');
  view.refuse('owncast');
  await loading;
  assert.equal(view.timers.pending.size, 2);
  assert.equal(view.retries.listening(), true);
  view.timers.fireAll();
  await flush();
  const inFlight = view.open.get('iptv-org');
  view.retries.stop(); // the view's tearDown
  assert.equal(view.timers.pending.size, 0);
  assert.equal(inFlight.signal.aborted, true, 'the try on its way is aborted');
  assert.equal(view.retries.listening(), false, 'the listeners go with the timers');
  inFlight.resolve([item('late', 'iptv-org')]);
  await flush();
  assert.deepEqual(view.list.map(({ id }) => id), ['r1'], 'nothing arrives after the view closed');
  assert.equal(view.online.listeners.size, 0);
  assert.equal(view.answers.listeners.size, 0);
  // A try that falls due when the view is no longer on screen asks nothing.
  let shown = true;
  const timers = fakeTimers();
  let runs = 0;
  const retries = createSourceRetries({ timers, isShown: () => shown, isVisible: () => true, onOnline: null });
  retries.fail(IPTV, () => { runs += 1; });
  shown = false;
  timers.fireAll();
  assert.equal(runs, 0);
  assert.deepEqual(retries.pending(), []);
});

test('a manual reload cancels the pending tries; a reload of some sources cancels only theirs', async () => {
  const view = makeView([RADIO, IPTV]);
  let loading = view.load();
  await flush();
  view.answer('radio-browser', [item('r1', 'radio-browser')]);
  view.refuse('iptv-org');
  await loading;
  view.timers.fireAll();
  await flush();
  const stale = view.open.get('iptv-org');
  loading = view.load(); // the user pressed TV again
  assert.equal(stale.signal.aborted, true);
  assert.equal(view.timers.pending.size, 0);
  stale.resolve([item('stale', 'iptv-org')]);
  await flush();
  view.answer('radio-browser', [item('r1', 'radio-browser')]);
  view.answer('iptv-org', [item('t1', 'iptv-org')]);
  await loading;
  assert.deepEqual(view.list.map(({ id }) => id), ['r1', 't1'], 'only the new load\'s answer');

  const timers = fakeTimers();
  const retries = createSourceRetries({ timers, isVisible: () => true, onOnline: null });
  retries.fail(IPTV, () => {});
  retries.fail(OWNCAST, () => {});
  retries.stop(['owncast']);
  assert.deepEqual(retries.pending(), ['iptv-org']);
  assert.equal(timers.pending.size, 1);
});

test('a provider that asked to wait is not asked again sooner, not even early', async () => {
  // A declared Retry-After longer than the step is kept; a shorter one is not a reason to hurry.
  assert.equal(sourceRetryDelay(0, { status: 429, retryAfterMs: 120_000 }), 120_000);
  assert.equal(sourceRetryDelay(0, { status: 503, retryAfterMs: 5_000 }), 15_000);
  assert.equal(sourceRetryDelay(2, { status: 429, retryAfterMs: 90_000 }), 300_000);
  // What the catalog scheduler still holds for the source counts as well.
  assert.equal(sourceRetryDelay(0, new Error('down'), 45_000), 45_000);
  // A 429 that names no wait skips the quick first step.
  assert.equal(sourceRetryDelay(0, { status: 429, retryAfterMs: null }), 60_000);
  assert.equal(sourceRetryDelay(0, { status: 429 }, 0), 60_000);
  // Never past the longest wait the scheduler accepts.
  assert.equal(sourceRetryDelay(0, { retryAfterMs: Number.MAX_SAFE_INTEGER }), 6 * 60 * 60 * 1000);

  const view = makeView([RADIO, IPTV, OWNCAST]);
  const loading = view.load();
  await flush();
  view.answer('radio-browser', [item('r1', 'radio-browser')]);
  view.refuse('iptv-org', Object.assign(new Error('HTTP 429'), { status: 429, retryAfterMs: 120_000 }));
  view.refuse('owncast');
  await loading;
  assert.deepEqual(view.timers.delays().sort((a, b) => a - b), [15_000, 120_000]);
  // The line comes back: owncast is asked at once, iptv-org keeps its wait.
  view.online.emit();
  await flush();
  assert.deepEqual(view.asked.slice(3), ['owncast again']);
  view.clock = 120_000;
  view.timers.fireAll();
  await flush();
  assert.ok(view.asked.includes('iptv-org again'), 'asked once its wait is over');
});

test('an early try answered with a wait sets the next try from that wait and gets no early try until it is over', async () => {
  for (const [name, error, declaredMs, expected] of [
    ['429 with Retry-After', Object.assign(new Error('HTTP 429'), { status: 429, retryAfterMs: 600_000 }), 0, 600_000],
    ['the scheduler still holds it', new Error('down'), 450_000, 450_000],
    ['429 naming no wait', Object.assign(new Error('HTTP 429'), { status: 429 }), 0, 300_000],
  ]) {
    const view = makeView([RADIO, IPTV]);
    const loading = view.load();
    await flush();
    view.answer('radio-browser', [item('r1', 'radio-browser')]);
    view.refuse('iptv-org');
    await loading;
    // Move iptv-org to its 60 s wait.
    view.timers.fireAll();
    await flush();
    view.refuse('iptv-org');
    await flush();
    assert.deepEqual(view.timers.delays(), [60_000], name);
    // The line seems back: the early try is answered with a wait.
    view.clock = 1_000;
    view.online.emit();
    await flush();
    assert.equal(view.asked.at(-1), 'iptv-org again', name);
    view.declaredMs = declaredMs;
    view.refuse('iptv-org', error);
    await flush();
    view.declaredMs = 0;
    assert.deepEqual(view.timers.delays(), [expected], `${name}: the old 60 s wait is replaced, never sooner than asked`);
    assert.equal(view.retries.tries('iptv-org'), 1, `${name}: the early try adds no step`);
    // No early try inside the wait, however the line looks.
    const asked = view.asked.length;
    view.clock = 1_000 + expected - 1;
    view.online.emit();
    view.answers.emit(10 * LINE_BACK_QUIET_MS);
    await flush();
    assert.equal(view.asked.length, asked, name);
    // Its try comes when the wait ends.
    view.clock = 1_000 + expected;
    view.timers.fireAll();
    await flush();
    assert.equal(view.asked.at(-1), 'iptv-org again', name);
    assert.equal(view.asked.length, asked + 1, name);
  }
});

test('when a retried source answers, the others waiting are tried at once, and go back to their wait if they fail', async () => {
  const view = makeView([RADIO, IPTV, OWNCAST]);
  const loading = view.load();
  await flush();
  // The line dropped: nothing answered.
  view.refuse('radio-browser');
  view.refuse('iptv-org');
  view.refuse('owncast');
  await loading;
  assert.equal(view.timers.pending.size, 3);
  // Move radio-browser along its schedule: it is now on its 60 s wait.
  const radioTimer = [...view.timers.pending].find(([, entry]) => entry.ms === 15_000);
  view.timers.pending.delete(radioTimer[0]);
  radioTimer[1].fn();
  await flush();
  view.refuse('radio-browser');
  await flush();
  assert.equal(view.retries.tries('radio-browser'), 1);
  // The 15 s try of iptv-org goes through: the line is back.
  const iptvTimer = [...view.timers.pending].find(([id, entry]) => entry.ms === 15_000 && id !== radioTimer[0]);
  view.timers.pending.delete(iptvTimer[0]);
  iptvTimer[1].fn();
  await flush();
  view.asked.length = 0;
  view.answer('iptv-org', [item('t1', 'iptv-org')]);
  await flush();
  assert.deepEqual(view.asked.sort(), ['owncast again', 'radio-browser again'], 'both asked at once');
  view.answer('owncast', [item('o1', 'owncast')]);
  view.refuse('radio-browser');
  await flush();
  assert.deepEqual(view.list.map(({ id }) => id), ['t1', 'o1']);
  // radio-browser failed its early try: still on the 60 s wait it was on, count unchanged.
  assert.deepEqual(view.retries.pending(), ['radio-browser']);
  assert.deepEqual(view.timers.delays(), [60_000]);
  assert.equal(view.retries.tries('radio-browser'), 1);
  // Only one early try per wait: another sign of the line does not ask it again.
  view.asked.length = 0;
  view.online.emit();
  view.answers.emit(10 * LINE_BACK_QUIET_MS);
  await flush();
  assert.deepEqual(view.asked, []);
  // Its own try comes when the wait ends, and the next wait is the next step.
  view.timers.fireAll();
  await flush();
  assert.deepEqual(view.asked, ['radio-browser again']);
  view.refuse('radio-browser');
  await flush();
  assert.deepEqual(view.timers.delays(), [300_000]);
});

test('the window\'s online event, or an outside answer after a quiet spell, tries the waiting sources at once', async () => {
  for (const sign of ['online', 'answer after quiet']) {
    const view = makeView([RADIO, IPTV]);
    const loading = view.load();
    await flush();
    view.answer('radio-browser', [item('r1', 'radio-browser')]);
    view.refuse('iptv-org');
    await loading;
    view.asked.length = 0;
    if (sign === 'online') view.online.emit();
    else view.answers.emit(LINE_BACK_QUIET_MS); // the first answer after none at all
    await flush();
    assert.deepEqual(view.asked, ['iptv-org again'], sign);
    view.answer('iptv-org', [item('t1', 'iptv-org')]);
    await flush();
    assert.deepEqual(view.list.map(({ id }) => id), ['r1', 't1'], sign);
    assert.equal(view.timers.pending.size, 0, sign);
  }
  // Answers that keep coming (a station playing) are not a line coming back.
  const view = makeView([RADIO, IPTV], { lastAnswerAt: () => 100_000 });
  const loading = view.load();
  await flush();
  view.answer('radio-browser', [item('r1', 'radio-browser')]);
  view.refuse('iptv-org');
  await loading;
  view.asked.length = 0;
  view.answers.emit(101_000);
  view.answers.emit(102_000);
  await flush();
  assert.deepEqual(view.asked, []);
  view.answers.emit(102_000 + LINE_BACK_QUIET_MS);
  await flush();
  assert.deepEqual(view.asked, ['iptv-org again']);
});

test('a hidden window makes no early try; the waiting try is made once it is shown', async () => {
  let visible = false;
  const show = fakeEvents();
  const view = makeView([RADIO, IPTV], { isVisible: () => visible, whenVisible: show.listen });
  const loading = view.load();
  await flush();
  view.answer('radio-browser', [item('r1', 'radio-browser')]);
  view.refuse('iptv-org');
  await loading;
  view.asked.length = 0;
  view.online.emit();
  await flush();
  assert.deepEqual(view.asked, [], 'nothing while hidden');
  view.timers.fireAll();
  assert.equal(show.listeners.size, 1);
  visible = true;
  show.emit();
  await flush();
  assert.deepEqual(view.asked, ['iptv-org again']);
  assert.equal(show.listeners.size, 0);
});

test('the Tuner and the Grid send failed sources to the retries and end them on every new load and on leaving', async () => {
  for (const [path, list, name] of [['src/modes/tuner.js', 'state.stations', 'Tuner'], ['src/modes/grid.js', 'state.tiles', 'Grid']]) {
    const source = await read(path);
    assert.match(source, /const sourceRetries = createSourceRetries\(\{\n\s+isShown: \(\) => getState\(\)\.mode === '(tuner|grid)'/, name);
    assert.match(source, /onAnswer: onOutsideAnswer,\n\s+lastAnswerAt: lastOutsideAnswerAt,/, name);
    const loadStart = source.indexOf(name === 'Tuner' ? 'async function loadStations(' : 'async function load(');
    const load = source.slice(loadStart, source.indexOf('function finishLoad()'));
    assert.match(load, /sourceRetries\.stop\(preserve \? candidates\.map\(\(source\) => source\.id\) : null\);/, name);
    assert.ok(load.indexOf('sourceRetries.stop(') < load.indexOf('await runLiveLoad('), `${name}: before anything is asked`);
    assert.match(load, new RegExp(`failedSourceState\\(${list.replace('.', '\\.')}, source\\.id, message\\)`), name);
    assert.match(load, /sourceRetries\.fail\(source, retrySource, \{\n\s+error, declaredMs: catalogScheduler\.declaredCooldownRemainingMs\(source\.id\),/, name);
    assert.match(load, /sourceRetries\.succeeded\(source\.id\);/, name);
    // A retry is one source through the same load path, as a job of its own.
    assert.match(load, /const retrySource = \(source, signal, isCurrent, attempt\) => runLiveLoad\(\{\n\s+candidates: \[source\],/, name);
    assert.match(load, /ask: \(one, oneSignal\) => ask\(one, oneSignal, attempt\),/, name);
    assert.match(load, /:retry\$\{attempt\}/, name);
    const finish = source.slice(source.indexOf('function finishLoad() {'));
    assert.match(finish.slice(0, finish.indexOf('\n}\n')), /\)\) sourceRetries\.stop\(\);/, `${name}: none while the whole list is tried again`);
    const tearDown = source.slice(source.indexOf('function tearDown() {'));
    assert.match(tearDown.slice(0, tearDown.indexOf('\n}\n')), /sourceRetries\.stop\(\);/, name);
    assert.doesNotMatch(source, /AudioContext/, name);
  }
  const tuner = await read('src/modes/tuner.js');
  const favorites = tuner.slice(tuner.indexOf('function loadFavoriteStations() {'), tuner.indexOf('async function loadStations('));
  assert.match(favorites, /sourceRetries\.stop\(\);/);
  const liveLoad = await read('src/lib/live-load.js');
  assert.match(liveLoad, /onFailed\(source, deadline\.timedOut\(\) \? 'Timed out' : String\(error\?\.message \|\| error\), error\);/);
});
