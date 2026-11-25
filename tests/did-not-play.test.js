import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { FakeElement, createPlayerDom } from './helpers/fake-dom.js';
import {
  DID_NOT_PLAY_KEY, HELD_MAX_MS, MAX_DID_NOT_PLAY, MAX_HELD, clearDidNotPlay, clearDidNotPlayCache, createStartOutcome,
  didNotPlayAt, didNotPlayText, forgetLoadedDidNotPlay, markDidNotPlay, onDidNotPlayChange, startFailureKind,
} from '../src/lib/did-not-play.js';
import {
  ANSWER_FRESH_MS, CONFIRM_EVERY_MS, CONFIRM_URL, confirmConnection, connectionKnownDown, forgetConnectionEvidence,
  lastOutsideAnswerAt, noteOutsideAnswer, onOutsideAnswer,
} from '../src/lib/connection-evidence.js';
import { getJson } from '../src/lib/http.js';
import { didNotPlayNote, isSavedItem } from '../src/lib/did-not-play-view.js';
import { syncTunerMarks } from '../src/modes/tuner.js';
import { MediaConnectionError } from '../src/lib/media-failover.js';
import { START_FAILOVER_MS } from '../src/lib/start-failover.js';
import { clearCache, getState, STORAGE_KEYS } from '../src/lib/state.js';
import { resetControlSession } from '../src/lib/capture-client.js';
import { view, renderedIds } from '../src/modes/library/state.js';
import { ui } from '../src/modes/library/shell-refs.js';
import { renderResults, syncDidNotPlayMarks } from '../src/modes/library/render.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const TEST_TIMEOUT_MS = 20_000;
const DAY = Date.UTC(2026, 10, 20, 12, 0, 0);

class MemoryStorage {
  constructor() { this.data = new Map(); }
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
  setItem(key, value) { this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
}

/** A fresh browser storage for the marks, put back afterwards. */
function withStorage(t, storage = new MemoryStorage()) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: storage });
  forgetLoadedDidNotPlay();
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
    forgetLoadedDidNotPlay();
  });
  return storage;
}

function withFavorites(t, list) {
  const state = getState();
  const before = state.favorites;
  state.favorites = list;
  t.after(() => { state.favorites = before; });
}

/* ============ The stored marks ============ */

test('a mark is kept per item under its own key, and a play clears it', (t) => {
  const storage = withStorage(t);
  const seen = [];
  const off = onDidNotPlayChange((id) => seen.push(id));
  t.after(off);
  assert.equal(didNotPlayAt('radio:a'), 0);
  assert.equal(markDidNotPlay('radio:a', DAY), true);
  assert.equal(markDidNotPlay('radio:a', DAY), false, 'the same mark again changes nothing');
  assert.equal(didNotPlayAt('radio:a'), DAY);
  assert.deepEqual(JSON.parse(storage.getItem(DID_NOT_PLAY_KEY)), { version: 1, items: [['radio:a', DAY]] });
  // Read back by a new page.
  forgetLoadedDidNotPlay();
  assert.equal(didNotPlayAt('radio:a'), DAY);
  assert.equal(clearDidNotPlay('radio:a'), true);
  assert.equal(clearDidNotPlay('radio:a'), false);
  assert.equal(didNotPlayAt('radio:a'), 0);
  assert.deepEqual(seen, ['radio:a', 'radio:a']);
  for (const id of ['', null, 5, 'x'.repeat(513)]) assert.equal(markDidNotPlay(id, DAY), false);
});

test('the marks are bounded: the oldest go first', (t) => {
  withStorage(t);
  for (let i = 0; i < MAX_DID_NOT_PLAY + 5; i += 1) markDidNotPlay(`id-${i}`, DAY + i);
  assert.equal(MAX_DID_NOT_PLAY, 2000);
  assert.equal(didNotPlayAt('id-0'), 0);
  assert.equal(didNotPlayAt('id-4'), 0);
  assert.equal(didNotPlayAt('id-5'), DAY + 5);
  // Marked again: it is the newest now and stays.
  markDidNotPlay('id-5', DAY + 9_999);
  markDidNotPlay('id-new', DAY + 10_000);
  assert.equal(didNotPlayAt('id-5'), DAY + 9_999);
  assert.equal(didNotPlayAt('id-6'), 0);
});

test('an unreadable or foreign stored value is an empty cache', (t) => {
  const storage = withStorage(t);
  for (const value of ['not json', '{"version":2,"items":[["a",1]]}', '{"version":1,"items":{}}', 'null']) {
    storage.setItem(DID_NOT_PLAY_KEY, value);
    forgetLoadedDidNotPlay();
    assert.equal(didNotPlayAt('a'), 0, value);
  }
  storage.setItem(DID_NOT_PLAY_KEY, JSON.stringify({ version: 1, items: [['a', DAY], ['b', 'x'], [7, DAY], 'c', ['d', -1]] }));
  forgetLoadedDidNotPlay();
  assert.equal(didNotPlayAt('a'), DAY);
  assert.equal(didNotPlayAt('b'), 0);
  assert.equal(didNotPlayAt('d'), 0);
});

test('Clear cache removes the marks; they are no part of the profile or a backup', async (t) => {
  const storage = withStorage(t);
  markDidNotPlay('radio:a', DAY);
  await clearCache().catch(() => {});
  assert.equal(storage.getItem(DID_NOT_PLAY_KEY), null);
  assert.equal(didNotPlayAt('radio:a'), 0);
  assert.ok(!Object.values(STORAGE_KEYS).includes(DID_NOT_PLAY_KEY));
  for (const path of ['src/lib/profile-transfer.js', 'worldmedia_backup.py', 'worldmedia_runtime.py']) {
    assert.doesNotMatch(await read(path), /didnotplay/i, path);
  }
});

test('the sentence names the day and says it is tried again', () => {
  assert.equal(didNotPlayText(DAY, { formatDate: () => 'Nov 20, 2026' }),
    'Did not play last time (Nov 20, 2026). It is tried again when you play it.');
  assert.match(didNotPlayText(DAY), /^Did not play last time \(.+2026\)\. It is tried again when you play it\.$/);
  assert.equal(didNotPlayText(0), '');
  assert.equal(didNotPlayText(Number.NaN), '');
});

/* ============ Which failures count ============ */

test('a failure is the station\'s only when the app and the connection are not the cause', () => {
  const coded = (code, extra = {}) => Object.assign(new Error(code), { code }, extra);
  assert.equal(startFailureKind(null), 'refused', 'no stream address at all');
  assert.equal(startFailureKind(Object.assign(new Error('x'), { name: 'AbortError' })), 'app');
  assert.equal(startFailureKind(coded('MEDIA_REGISTRY_FULL')), 'app');
  assert.equal(startFailureKind(coded('INVALID_TOKEN')), 'app');
  // The app's own server did not answer the request at all.
  assert.equal(startFailureKind(new TypeError('Failed to fetch')), 'app');
  // The lookup could not be carried out: the connection's fault.
  assert.equal(startFailureKind(coded('MEDIA_DNS_FAILED')), 'lookup');
  // No answer, or a name that does not exist: judged by the connection.
  assert.equal(startFailureKind(coded('MEDIA_CONNECT_FAILED')), 'unreachable');
  assert.equal(startFailureKind(coded('MEDIA_HOST_NOT_FOUND')), 'unreachable');
  assert.equal(startFailureKind(coded('TIMEOUT')), 'unreachable');
  assert.equal(startFailureKind(coded('HTTP_STATUS', { status: 502 })), 'unreachable');
  assert.equal(startFailureKind(coded('HTTP_STATUS', { status: 404 })), 'refused');
  assert.equal(startFailureKind(coded('INVALID_MEDIA_URL')), 'refused');
  const allDown = new MediaConnectionError('none', {
    attempts: 2, errors: [coded('MEDIA_CONNECT_FAILED'), Object.assign(new Error('t'), { name: 'AbortError' })],
  });
  assert.equal(startFailureKind(allDown), 'unreachable');
  const lookups = new MediaConnectionError('none', {
    attempts: 2, errors: [coded('MEDIA_DNS_FAILED'), coded('MEDIA_HOST_NOT_FOUND')],
  });
  assert.equal(startFailureKind(lookups), 'lookup');
  const oneAnswered = new MediaConnectionError('none', {
    attempts: 2, errors: [coded('MEDIA_CONNECT_FAILED'), coded('MEDIA_RELAY_STATUS')],
  });
  assert.equal(startFailureKind(oneAnswered), 'refused');
  assert.equal(startFailureKind(new MediaConnectionError('This item has no valid media stream.')), 'refused');
});

/* ============ The result of a start ============ */

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };

/** A connection whose state the test sets; confirm() waits for answer(). */
function fakeConnection() {
  const state = { last: 0, down: false, confirms: 0 };
  const waiting = [];
  const listeners = new Set();
  const connection = {
    lastAnswerAt: () => state.last,
    knownDown: () => state.down,
    confirm: () => { state.confirms += 1; return new Promise((resolve) => waiting.push(resolve)); },
    noteAnswer: (at) => { state.last = at; for (const listener of [...listeners]) listener(at); },
    onAnswer: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return { state, connection, answer: (works) => { for (const resolve of waiting.splice(0)) resolve(works); } };
}

function outcomeHarness({ offline = false } = {}) {
  const marks = new Map();
  const timers = [];
  let clock = DAY;
  const store = {
    mark: (id, at) => { marks.set(id, at); return true; },
    clear: (id) => marks.delete(id),
    get: (id) => marks.get(id) || 0,
  };
  const state = { offline, handing: false };
  const offlineListeners = new Set();
  const link = fakeConnection();
  // Something outside answered a moment ago, unless a test says otherwise.
  link.state.last = clock;
  const outcome = createStartOutcome({
    store,
    isOffline: () => state.offline,
    onOffline: (listener) => { offlineListeners.add(listener); return () => offlineListeners.delete(listener); },
    now: () => clock,
    setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer: (timer) => { timer.cleared = true; },
    limitMs: 30_000,
    handingOver: () => state.handing,
    connection: link.connection,
  });
  // The start time limits only (the held results' age timer is fireAge).
  const fireWhere = (test) => {
    for (const timer of timers.filter((entry) => !entry.cleared && test(entry))) { timer.cleared = true; timer.fn(); }
  };
  const fire = () => fireWhere((timer) => timer.ms === 30_000);
  const fireAge = () => fireWhere((timer) => timer.ms !== 30_000);
  const goOffline = () => { state.offline = true; for (const listener of [...offlineListeners]) listener(); };
  return {
    outcome, marks, timers, state, fire, fireAge, link, goOffline, now: () => clock, advance: (ms) => { clock += ms; },
  };
}

/** A station that could not be reached, with nothing outside heard for two
 *  minutes: its result waits for the check. */
function failUnheard(h, id) {
  h.advance(1000);
  h.link.state.last = h.now() - 2 * 60_000;
  h.outcome.begin(id);
  return h.outcome.failed(id, 'unreachable');
}

test('a start that failed is marked; one that plays clears it', () => {
  const { outcome, marks } = outcomeHarness();
  outcome.begin('a');
  assert.equal(outcome.failed('a', 'refused'), true);
  assert.deepEqual([...marks], [['a', DAY]]);
  assert.equal(outcome.active, false);
  outcome.begin('a');
  outcome.streamSetUp('a');
  outcome.played('a');
  assert.equal(marks.has('a'), false);
  // A later play (a reconnect, say) clears a mark too.
  marks.set('b', DAY);
  outcome.played('b');
  assert.equal(marks.has('b'), false);
});

test('Stop, a pause, another station or a blocked start is no result', () => {
  const { outcome, marks, timers } = outcomeHarness();
  outcome.begin('a');
  outcome.streamSetUp('a');
  outcome.cancel();
  assert.equal(timers[0].cleared, true);
  assert.equal(outcome.failed('a', 'refused'), false, 'nothing left to fail');
  outcome.begin('b');
  outcome.begin('c'); // the user moved on before b had a result
  assert.equal(outcome.failed('b', 'refused'), false);
  outcome.cancel('other'); // a blocked start of another item leaves c alone
  assert.equal(outcome.active, true);
  outcome.cancel('c');
  assert.equal(outcome.active, false);
  assert.equal(marks.size, 0);
});

test('a start that never begins within the start time limit is marked once, and cleared if it then plays', () => {
  const { outcome, marks, timers, fire } = outcomeHarness();
  outcome.begin('a');
  assert.equal(timers.length, 0, 'the limit runs from a stream that is set up');
  outcome.streamSetUp('a');
  assert.equal(timers[0].ms, 30_000);
  // The next stream is set up: the limit starts again from there.
  outcome.streamSetUp('a');
  assert.equal(timers[0].cleared, true);
  assert.equal(timers.length, 2);
  outcome.answered('a');
  fire();
  assert.equal(marks.get('a'), DAY);
  assert.equal(outcome.active, true, 'the start goes on');
  // One result per start: its stream failing later changes nothing.
  marks.delete('a');
  assert.equal(outcome.failed('a', 'stream'), false);
  assert.equal(marks.has('a'), false);
  outcome.begin('b');
  outcome.streamSetUp('b');
  outcome.answered('b');
  fire();
  outcome.played('b');
  assert.equal(marks.has('b'), false);
  assert.equal(outcome.active, false);
});

test('a stream that another stream takes over from is not the result; the last one is', () => {
  const { outcome, marks, timers, state, fire } = outcomeHarness();
  outcome.begin('a');
  outcome.streamSetUp('a');
  outcome.answered('a');
  // Past the limit while the start watch still has a stream to try.
  state.handing = true;
  fire();
  assert.equal(marks.size, 0);
  // The watch hands over: no timer runs until the next stream is set up.
  outcome.streamSetUp('a');
  outcome.handOver('a');
  assert.equal(timers.at(-1).cleared, true);
  outcome.streamSetUp('a');
  state.handing = false;
  fire();
  assert.deepEqual([...marks.keys()], ['a'], 'no stream left: the result, written once');
  assert.equal(outcome.failed('a', 'refused'), false);
});

test('an edited address invalidates both held and active results for that station', async () => {
  const h = outcomeHarness();
  const { outcome, marks, link } = h;
  h.advance(2 * 60_000);
  outcome.begin('a');
  outcome.failed('a', 'unreachable');
  await flush();
  assert.deepEqual(outcome.held, ['a']);
  outcome.invalidate('a');
  link.answer(true);
  await flush();
  assert.equal(marks.has('a'), false);

  outcome.begin('a');
  outcome.streamSetUp('a');
  outcome.invalidate('a');
  assert.equal(outcome.failed('a', 'refused'), false);
});

test('a station that could not be reached is marked only when the connection is shown to work', async () => {
  const h = outcomeHarness();
  const { outcome, marks, link } = h;
  // Something outside answered within the last minute: marked at once.
  outcome.begin('a');
  assert.equal(outcome.failed('a', 'stream'), true, 'a stream that never answered');
  assert.equal(link.state.confirms, 0);

  // Nothing answered for two minutes: the result waits for a check.
  h.advance(2 * 60_000);
  const heldAt = h.now();
  outcome.begin('b');
  assert.equal(outcome.failed('b', 'unreachable'), false);
  assert.deepEqual(outcome.held, ['b']);
  assert.equal(outcome.active, false, 'the next start is not held up');
  await flush();
  assert.equal(link.state.confirms, 1);
  h.advance(3000);
  link.answer(true);
  await flush();
  assert.equal(marks.get('b'), heldAt, 'marked with the time it failed');
  assert.deepEqual(outcome.held, []);

  // The check finds no connection: dropped.
  h.advance(2 * 60_000);
  outcome.begin('c');
  outcome.failed('c', 'unreachable');
  await flush();
  link.answer(false);
  await flush();
  assert.equal(marks.has('c'), false);
  assert.deepEqual(outcome.held, []);

  // The last check said no connection: dropped at once, no new check.
  link.state.down = true;
  outcome.begin('d');
  assert.equal(outcome.failed('d', 'unreachable'), false);
  assert.deepEqual(outcome.held, []);
  link.state.down = false;

  // Offline before the check answers: dropped.
  h.advance(2 * 60_000);
  outcome.begin('e');
  outcome.failed('e', 'unreachable');
  h.goOffline();
  await flush();
  link.answer(true);
  await flush();
  assert.equal(marks.has('e'), false);
  h.state.offline = false;

  // Anything outside answering meanwhile shows the connection works.
  h.advance(2 * 60_000);
  outcome.begin('f');
  outcome.failed('f', 'unreachable');
  outcome.answered('another-station');
  assert.ok(marks.has('f'));
  // A lookup that could not be done, or the app's own limit, is never marked.
  outcome.begin('g');
  assert.equal(outcome.failed('g', 'lookup'), false);
  outcome.begin('h');
  assert.equal(outcome.failed('h', 'app'), false);
  assert.deepEqual([...marks.keys()].sort(), ['a', 'b', 'f']);
});

test('a stream that answered and then failed is the station\'s fault, whatever the connection', async () => {
  const h = outcomeHarness();
  h.advance(10 * 60_000);
  h.outcome.begin('a');
  h.outcome.streamSetUp('a');
  h.outcome.answered('a');
  h.link.state.down = true;
  assert.equal(h.outcome.failed('a', 'stream'), true);
  assert.equal(h.outcome.failed('a', 'stream'), false, 'one result');
  assert.ok(h.marks.has('a'));
});

test('nothing is marked while the browser is offline, or for the app\'s own limits', () => {
  const { outcome, marks, state } = outcomeHarness({ offline: true });
  outcome.begin('a');
  assert.equal(outcome.failed('a', 'refused'), false);
  state.offline = false;
  outcome.begin('b');
  assert.equal(outcome.failed('b', 'app'), false);
  assert.equal(marks.size, 0);
});

test('a waiting result stays through Stop and another station, and is dropped when that station answers or plays', async () => {
  const h = outcomeHarness();
  failUnheard(h, 'a');
  h.outcome.cancel(); // Stop after the failure
  failUnheard(h, 'b'); // the next station on the list
  failUnheard(h, 'c');
  h.outcome.begin('d'); // the user moves on again
  assert.deepEqual(h.outcome.held, ['a', 'b', 'c']);
  // c is tried again and plays: the connection works, so a and b are
  // marked, but c's own earlier failure is not.
  h.outcome.begin('c');
  h.outcome.played('c');
  assert.deepEqual([...h.marks.keys()].sort(), ['a', 'b']);
  assert.deepEqual(h.outcome.held, []);
  assert.equal(h.outcome.listening, false, 'nothing left listening');
  // A station tried again that answers (before it plays) is not marked either.
  failUnheard(h, 'e');
  h.outcome.begin('e');
  h.outcome.answered('e');
  assert.equal(h.marks.has('e'), false);
  await flush();
  h.link.answer(true);
  await flush();
  assert.deepEqual([...h.marks.keys()].sort(), ['a', 'b']);
  assert.equal(h.outcome.listening, false);
});

test('waiting results are bounded in number and age, and nothing listens once none waits', async () => {
  const h = outcomeHarness();
  for (let i = 0; i < MAX_HELD + 10; i += 1) failUnheard(h, `s${i}`);
  assert.equal(MAX_HELD, 50);
  assert.equal(h.outcome.held.length, MAX_HELD);
  assert.equal(h.outcome.held[0], 's10', 'the oldest go first');
  assert.equal(h.outcome.listening, true);
  // Two minutes undecided: dropped, and the listeners and the timer go.
  assert.equal(HELD_MAX_MS, 120_000);
  h.advance(HELD_MAX_MS);
  h.fireAge();
  assert.deepEqual(h.outcome.held, []);
  assert.equal(h.outcome.listening, false);
  await flush();
  h.link.answer(true);
  await flush();
  assert.equal(h.marks.size, 0, 'a late check marks none of them');
  // A late answer from outside settles nothing old either.
  failUnheard(h, 'old');
  h.advance(HELD_MAX_MS + 1);
  h.outcome.answered('other');
  assert.equal(h.marks.has('old'), false);
});

test('Clear cache drops every waiting result, and nothing started before it writes after it', async (t) => {
  withStorage(t);
  const h = outcomeHarness();
  failUnheard(h, 'a');
  failUnheard(h, 'b');
  h.outcome.begin('c');
  h.outcome.streamSetUp('c');
  clearDidNotPlayCache();
  assert.deepEqual(h.outcome.held, []);
  assert.equal(h.outcome.listening, false);
  await flush();
  h.link.answer(true);
  await flush();
  // The start that was on its way when the cache was cleared: no result.
  h.outcome.answered('c');
  h.fire();
  assert.equal(h.marks.size, 0);
  // A start after it is judged as usual.
  h.outcome.begin('d');
  assert.equal(h.outcome.failed('d', 'refused'), true);
  assert.deepEqual([...h.marks.keys()], ['d']);
});

/* ============ Is the connection working? ============ */

test('outside answers are noted, and the check is small, shared and spaced out', async (t) => {
  forgetConnectionEvidence();
  t.after(forgetConnectionEvidence);
  const heard = [];
  const off = onOutsideAnswer((at) => heard.push(at));
  t.after(off);
  noteOutsideAnswer(DAY);
  noteOutsideAnswer(DAY - 5); // older: nothing changes
  assert.equal(lastOutsideAnswerAt(), DAY);
  assert.deepEqual(heard, [DAY]);
  assert.equal(ANSWER_FRESH_MS, 60_000);
  assert.equal(CONFIRM_EVERY_MS, 30_000);
  assert.equal(CONFIRM_URL, 'https://all.api.radio-browser.info/json/stats');

  let clock = DAY + 120_000;
  let asked = 0;
  let works = false;
  const request = () => { asked += 1; return works ? Promise.resolve({}) : Promise.reject(new TypeError('Failed to fetch')); };
  const ask = () => confirmConnection({ now: () => clock, request });
  const [first, second] = await Promise.all([ask(), ask()]);
  assert.deepEqual([first, second, asked], [false, false, 1], 'one request for both');
  assert.equal(connectionKnownDown(clock), true);
  clock += 10_000;
  assert.equal(await ask(), false);
  assert.equal(asked, 1, 'its answer is used for 30 seconds');
  // An answer from outside since the check: no longer known to be down.
  noteOutsideAnswer(clock);
  assert.equal(connectionKnownDown(clock), false);
  clock += CONFIRM_EVERY_MS;
  works = true;
  assert.equal(await ask(), true);
  assert.equal(asked, 2);
  assert.equal(lastOutsideAnswerAt(), clock, 'a check that works is an answer');
  assert.equal(connectionKnownDown(clock), false);
});

test('a catalog request answered through the proxy counts as an outside answer', async (t) => {
  forgetConnectionEvidence();
  t.after(forgetConnectionEvidence);
  const ok = { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{}' };
  const failed = { ok: false, status: 502, headers: { get: () => null }, text: async () => '' };
  await assert.rejects(getJson('https://example.test/a', { fetchImpl: async () => failed, retries: 0 }));
  assert.equal(lastOutsideAnswerAt(), 0, 'the proxy\'s own error is no answer');
  const before = Date.now();
  await getJson('https://example.test/a', { fetchImpl: async () => ok, retries: 0 });
  assert.ok(lastOutsideAnswerAt() >= before);
});

/* ============ Where it is shown ============ */

test('the sentence is shown only for favorites and My Playlists stations', (t) => {
  withStorage(t);
  withFavorites(t, [{ id: 'fav:1', title: 'Saved' }]);
  markDidNotPlay('fav:1', DAY);
  markDidNotPlay('catalog:1', DAY);
  assert.equal(isSavedItem('fav:1'), true);
  assert.equal(isSavedItem('catalog:1'), false);
  assert.equal(didNotPlayNote({ id: 'fav:1' }, { formatDate: () => 'Nov 20, 2026' }),
    'Did not play last time (Nov 20, 2026). It is tried again when you play it.');
  assert.equal(didNotPlayNote({ id: 'catalog:1' }), '');
  assert.equal(didNotPlayNote({ id: 'fav:other' }), '');
  assert.equal(didNotPlayNote(null), '');
});

class Node extends FakeElement {
  constructor(id = '', tag = 'div') {
    super(id, tag);
    this.parentNode = null;
    this.html = '';
  }
  get childNodes() { return this.children; }
  get childElementCount() { return this.children.length; }
  get innerHTML() { return this.html; }
  set innerHTML(value) {
    this.html = value;
    if (value === '') for (const child of [...this.children]) this.removeChild(child);
  }
  setAttribute(name, value) {
    super.setAttribute(name, value);
    if (name.startsWith('data-')) this.dataset[name.slice(5)] = String(value);
  }
  appendChild(child) {
    if (child.tagName === 'FRAGMENT') {
      for (const node of [...child.children]) this.appendChild(node);
      return child;
    }
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child, ref) {
    if (!ref) return this.appendChild(child);
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.children.splice(this.children.indexOf(ref), 0, child);
    return child;
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  remove() { this.parentNode?.removeChild(this); }
  querySelector() { return null; }
  querySelectorAll(selector) {
    return selector === '.card' ? this.children.filter((node) => node.className?.startsWith('card')) : [];
  }
}

test('Library cards of saved stations carry a small mark with the sentence; others do not', (t) => {
  withStorage(t);
  // __contentHidden keeps these cards from asking the artwork relay for logos.
  withFavorites(t, [
    { id: 'fav:a', title: 'Alpha', type: 'radio', source: 'radio-browser', __contentHidden: true },
    { id: 'fav:b', title: 'Beta', type: 'radio', source: 'radio-browser', __contentHidden: true },
  ]);
  const oldDocument = globalThis.document;
  const oldUi = { ...ui };
  const before = { source: view.activeSource, filters: { ...view.personalFilters.favorites }, signature: view.renderSignature };
  const host = new Node('', 'div');
  globalThis.document = {
    activeElement: null,
    createElement: (tag) => new Node('', tag),
    createDocumentFragment: () => new Node('', 'fragment'),
    createTextNode: (text) => Object.assign(new Node('', '#text'), { textContent: text }),
  };
  ui.resultsHost = host;
  ui.windowBack = null;
  ui.sentinelStatus = null;
  renderedIds.clear();
  view.activeSource = 'favorites';
  view.personalFilters.favorites = { query: '', type: '' };
  t.after(() => {
    renderedIds.clear();
    Object.assign(ui, oldUi);
    globalThis.document = oldDocument;
    view.activeSource = before.source;
    view.personalFilters.favorites = before.filters;
    view.renderSignature = before.signature;
  });

  markDidNotPlay('fav:a', DAY);
  renderResults();
  const [alpha, beta] = host.children;
  const mark = alpha.__trouble;
  assert.ok(mark, 'the card that did not play has its mark');
  assert.equal(mark.className, 'card-trouble');
  assert.equal(mark.textContent, '!');
  assert.equal(mark.getAttribute('role'), 'img');
  assert.match(mark.getAttribute('aria-label'), /^Did not play last time \(.+\)\. It is tried again when you play it\.$/);
  assert.equal(mark.getAttribute('title'), mark.getAttribute('aria-label'));
  assert.equal(mark.parentNode, alpha.__thumb, 'on the picture, inside the card\'s button');
  assert.equal(alpha.__open.getAttribute('aria-describedby'), mark.getAttribute('id'));
  assert.equal(alpha.classList.contains('has-trouble'), true);
  assert.equal(beta.__trouble ?? null, null);

  // It played: only the mark goes; the card itself stays.
  clearDidNotPlay('fav:a');
  syncDidNotPlayMarks();
  assert.equal(host.children[0], alpha);
  assert.equal(alpha.__trouble, null);
  assert.equal(mark.parentNode, null);
  assert.equal(alpha.__open.getAttribute('aria-describedby'), null);
  assert.equal(alpha.classList.contains('has-trouble'), false);
  beta.__open.setAttribute('aria-describedby', 'favorite-song-1');
  markDidNotPlay('fav:b', DAY);
  syncDidNotPlayMarks();
  assert.ok(beta.__trouble);
  assert.equal(beta.__open.getAttribute('aria-describedby'),
    `favorite-song-1 ${beta.__trouble.getAttribute('id')}`);
  clearDidNotPlay('fav:b');
  syncDidNotPlayMarks();
  assert.equal(beta.__open.getAttribute('aria-describedby'), 'favorite-song-1');
});

test('a Tuner card\'s mark changes in place: the strip, its scroll position and the focused card stay', (t) => {
  withStorage(t);
  withFavorites(t, [
    { id: 'fav:a', title: 'Alpha', type: 'radio', source: 'radio-browser' },
    { id: 'fav:b', title: 'Beta', type: 'radio', source: 'radio-browser' },
  ]);
  const oldDocument = globalThis.document;
  const strip = new Node('', 'div');
  strip.scrollLeft = 412;
  const pills = [['fav:a', 'Alpha'], ['fav:b', 'Beta']].map(([id, title]) => {
    const pill = new Node('', 'button');
    pill.className = 'station-pill';
    pill.__station = { id, title, source: 'radio-browser' };
    pill.__saved = true;
    strip.appendChild(pill);
    return pill;
  });
  globalThis.document = {
    activeElement: pills[1],
    createElement: (tag) => new Node('', tag),
    createTextNode: (text) => Object.assign(new Node('', '#text'), { textContent: text }),
  };
  t.after(() => { globalThis.document = oldDocument; });

  markDidNotPlay('fav:b', DAY);
  syncTunerMarks(strip);
  assert.deepEqual(strip.children, pills, 'the same cards, in place');
  assert.equal(strip.scrollLeft, 412);
  assert.equal(globalThis.document.activeElement, pills[1], 'focus stays on its card');
  const mark = pills[1].__trouble;
  assert.equal(pills[1].classList.contains('has-trouble'), true);
  assert.equal(mark.className, 'pill-trouble');
  assert.equal(mark.getAttribute('role'), 'img');
  assert.match(mark.getAttribute('aria-label'), /^Did not play last time \(.+\)\. It is tried again when you play it\.$/);
  assert.match(pills[1].getAttribute('title'), /^\u2605 Favorite \u00B7 Beta \u00B7 .+\nDid not play last time/);
  assert.equal(pills[0].classList.contains('has-trouble'), false);
  assert.equal(pills[0].__trouble ?? null, null);
  assert.doesNotMatch(pills[0].getAttribute('title'), /Did not play/);
  // Marked again: the same mark, updated.
  markDidNotPlay('fav:b', DAY + 86_400_000);
  syncTunerMarks(strip);
  assert.equal(pills[1].__trouble, mark);
  assert.equal(pills[1].children.filter((child) => child === mark).length, 1);
  // It played: the mark goes, the card stays.
  clearDidNotPlay('fav:b');
  syncTunerMarks(strip);
  assert.equal(pills[1].__trouble, null);
  assert.equal(mark.parentNode, null);
  assert.equal(pills[1].classList.contains('has-trouble'), false);
  assert.deepEqual(strip.children, pills);
  assert.equal(strip.scrollLeft, 412);
});

test('the Tuner, the details panel and the Library follow the marks; the styles keep it small', async () => {
  const [tuner, detail, index, libraryCss, tunerCss] = await Promise.all([
    read('src/modes/tuner.js'), read('src/modes/library/detail.js'), read('src/modes/library/index.js'),
    read('src/styles/library.css'), read('src/styles/tuner.css'),
  ]);
  assert.match(tuner, /const trouble = didNotPlayNote\(s\);/);
  assert.match(tuner, /pill\.__station = s;\s*pill\.__saved = saved;\s*setPillTrouble\(pill\);/);
  // A mark that comes or goes changes its cards only; the strip is not rebuilt.
  assert.match(tuner, /subs\.push\(onDidNotPlayChange\(\(\) => \{\s*if \(getState\(\)\.mode === 'tuner'\) syncTunerMarks\(\);/);
  assert.match(detail, /detailTrouble = el\('p', \{ className: 'detail-trouble', attrs: \{ role: 'note' \} \}\);/);
  assert.match(index, /subs\.push\(onDidNotPlayChange\(\(\) => \{ syncDidNotPlayMarks\(\); refreshDetailTrouble\(\); \}\)\);/);
  const cardMark = libraryCss.match(/\n\.card-trouble \{[^}]*\}/)[0];
  assert.match(cardMark, /position: absolute;/);
  assert.match(cardMark, /width: 18px;/);
  assert.match(cardMark, /background: var\(--danger\);/);
  const pillMark = tunerCss.match(/\.station-pill > \.pill-trouble \{[^}]*\}/)[0];
  assert.match(pillMark, /position: absolute;/);
  assert.match(pillMark, /width: 12px;/);
  assert.match(tunerCss, /\.station-pill\.has-trouble \{ position: relative; \}/);
});

/* ============ The player ============ */

const settle = async (rounds = 40) => {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
};

const envelope = (status, data, error = null) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => ({ ok: !error, data, error }),
});

function station(id, overrides = {}) {
  return {
    id: `test-dnp:${id}`, title: `Station ${id}`, description: '', source: 'radio-browser',
    type: 'radio', stream_kind: 'audio', stream_url: `https://radio.example/${id}`,
    delivery: 'live', capture_headers: {}, thumbnail: '/api/v1/assets/test_artwork_0001',
    country: '', language: '', _extra: { streamCandidates: [] },
    ...overrides,
  };
}

/** A station with two more listed streams (each is tested before it plays). */
function listedStation(id) {
  return station(id, {
    _extra: {
      streamCandidates: [
        { url: `https://radio.example/${id}/b.mp3`, kind: 'audio' },
        { url: `https://radio.example/${id}/c.mp3`, kind: 'audio' },
      ],
    },
  });
}

const namedError = (name) => Object.assign(new Error(name), { name });

/** The real player on a fake page. `net.outside` says whether the outside
 *  check (CONFIRM_URL) gets an answer: true, false, or 'hang'. */
async function playerSetup(t) {
  t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: DAY });
  withStorage(t);
  forgetConnectionEvidence();
  const previous = {
    document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch,
    sessionStorage: Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'),
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  };
  const { elements, document } = createPlayerDom();
  elements['player-art-initials'] = document.register(new FakeElement('player-art-initials'));
  const net = { registrations: 0, refuse: null, outside: true, checks: 0, waiting: [] };
  const outsideAnswer = () => ({
    ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{"stations":1}',
  });
  /** 'hold': the checks on their way get their answer now. */
  net.release = (works) => {
    for (const { resolve, reject } of net.waiting.splice(0)) {
      if (works) resolve(outsideAnswer()); else reject(new TypeError('Failed to fetch'));
    }
  };
  const navigator = { onLine: true, mediaSession: { playbackState: 'none', metadata: null, setActionHandler() {} } };
  globalThis.document = document;
  globalThis.window = new EventTarget();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: new MemoryStorage() });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: navigator });
  globalThis.fetch = async (path) => {
    if (path === CONFIRM_URL) {
      net.checks++;
      if (net.outside === 'hang') return new Promise(() => {});
      if (net.outside === 'hold') return new Promise((resolve, reject) => net.waiting.push({ resolve, reject }));
      if (!net.outside) throw new TypeError('Failed to fetch');
      return outsideAnswer();
    }
    if (path === '/api/v1/session') return envelope(200, { token: 'dnp-token' });
    if (path === '/api/v1/media/register') {
      net.registrations++;
      if (net.refuse) return envelope(502, null, { code: net.refuse, message: 'refused' });
      const id = `dnp_media_${String(net.registrations).padStart(12, '0')}`;
      return envelope(201, { media_id: id, relay_url: `/api/v1/media/${id}` });
    }
    if (String(path).endsWith('/expire')) return envelope(200, { expired: true });
    if (/\/now-playing$/.test(String(path))) return envelope(200, { title: null, changed_at: null });
    // The test request of a listed stream.
    if (String(path).startsWith('/api/v1/media/')) return envelope(206, null);
    throw new Error(`Unexpected request: ${path}`);
  };
  resetControlSession();
  let player = null;
  t.after(() => {
    try { player?.stop(); } catch (_) {}
    resetControlSession();
    forgetConnectionEvidence();
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    globalThis.fetch = previous.fetch;
    for (const name of ['sessionStorage', 'navigator']) {
      if (previous[name]) Object.defineProperty(globalThis, name, previous[name]);
      else delete globalThis[name];
    }
  });
  player = await import(`../src/lib/player.js?didNotPlay=${Date.now()}-${Math.random()}`);
  player.initPlayer();
  await settle();
  const audio = elements['audio-el'];
  const progress = (seconds = 1.5) => {
    for (let moved = 0; moved < seconds; moved += 0.5) {
      audio.currentTime += 0.5;
      audio.emit('timeupdate');
    }
  };
  const tick = async (ms) => {
    // In steps, so promise chains between timers settle.
    for (let left = ms; left > 0; left -= 1000) {
      t.mock.timers.tick(Math.min(1000, left));
      await settle(4);
    }
    await settle();
  };
  const changes = [];
  const off = onDidNotPlayChange((id) => changes.push(id));
  t.after(off);
  return { player, audio, net, navigator, progress, tick, changes };
}

test('a station whose streams all fail is marked, and playing it again works and clears it', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, net, progress } = await playerSetup(t);
  const item = station('a');
  net.refuse = 'MEDIA_RELAY_STATUS';
  await player.playItem(item);
  await settle();
  assert.ok(didNotPlayAt(item.id) > 0, 'marked');
  // Marked or not, a play starts at once, the same way.
  net.refuse = null;
  const before = net.registrations;
  await player.playItem(item);
  await settle();
  assert.equal(net.registrations, before + 1);
  progress();
  assert.equal(didNotPlayAt(item.id), 0, 'it played: the mark is gone');
});

test('Stop before a result, or being offline, marks nothing', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, audio, net, navigator, tick } = await playerSetup(t);
  // The stream is set up but never starts; the user stops it.
  audio.autoEvents = false;
  audio.play = () => new Promise(() => {});
  const item = station('b');
  void player.playItem(item);
  await settle();
  player.stop();
  await tick(START_FAILOVER_MS + 1000);
  assert.equal(didNotPlayAt(item.id), 0);

  // Offline: every stream fails, but that is not the station's fault.
  navigator.onLine = false;
  net.refuse = 'MEDIA_RELAY_STATUS';
  const other = station('c');
  await player.playItem(other);
  await settle();
  assert.equal(didNotPlayAt(other.id), 0);
});

test('a stream that sends data but never begins within the start time limit is marked, without being stopped', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, audio, net, tick, progress } = await playerSetup(t);
  net.outside = false; // its data is the answer: no check is needed
  audio.autoEvents = false;
  let begin = null;
  audio.play = () => new Promise((resolve) => { begin = resolve; });
  const item = station('d');
  void player.playItem(item);
  await settle();
  assert.equal(net.registrations, 1);
  audio.emit('progress');
  await tick(START_FAILOVER_MS - 1000);
  assert.equal(didNotPlayAt(item.id), 0, 'still within the limit');
  await tick(2000);
  assert.ok(didNotPlayAt(item.id) > 0, 'past the limit');
  assert.equal(net.checks, 0);
  assert.equal(player.getCurrentItem()?.id, item.id, 'the start goes on');
  // It begins after all: the mark goes.
  audio.paused = false;
  begin();
  audio.emit('playing');
  await settle();
  progress();
  assert.equal(didNotPlayAt(item.id), 0);
});

test('with the internet down, a stream that was set up but sent nothing is not marked', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, audio, net, tick } = await playerSetup(t);
  // A single plain stream gets no test request before it plays: the relay is
  // registered (its name was in the cache) although nothing outside answers.
  net.outside = false;
  audio.autoEvents = false;
  audio.play = () => new Promise(() => {});
  const item = station('e');
  void player.playItem(item);
  await settle();
  assert.equal(net.registrations, 1);
  await tick(START_FAILOVER_MS + 2000);
  assert.ok(net.checks >= 1, 'the connection was checked');
  assert.equal(didNotPlayAt(item.id), 0);

  // The same with the connection working: the station's fault, marked.
  net.outside = true;
  t.mock.timers.tick(CONFIRM_EVERY_MS);
  const other = station('f');
  void player.playItem(other);
  await settle();
  await tick(START_FAILOVER_MS + 2000);
  assert.ok(didNotPlayAt(other.id) > 0);
});

test('a start the browser refused to begin without a click is no result, even past the time limit', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, audio, tick, changes } = await playerSetup(t);
  audio.playError = namedError('NotAllowedError');
  const item = station('g');
  await player.playItem(item);
  await settle();
  await tick(START_FAILOVER_MS * 2);
  assert.equal(didNotPlayAt(item.id), 0);
  assert.deepEqual(changes, []);
});

test('listed streams: a first stream that never plays is not the result while another is left', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, audio, net, tick, progress, changes } = await playerSetup(t);
  audio.autoEvents = false;
  const item = listedStation('h');
  await player.playItem(item);
  await settle();
  assert.equal(net.registrations, 1);
  // Past the first stream's time limit: the next stream gets its turn.
  await tick(START_FAILOVER_MS + 1000);
  assert.equal(net.registrations, 2);
  assert.equal(didNotPlayAt(item.id), 0, 'not marked while a stream is left');
  // The second stream plays.
  audio.paused = false;
  audio.emit('playing');
  progress();
  await tick(START_FAILOVER_MS + 1000);
  assert.equal(didNotPlayAt(item.id), 0);
  assert.deepEqual(changes, [], 'never marked, never cleared');
});

test('listed streams: when none of them plays, the start has one result, written once', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, audio, net, tick, changes } = await playerSetup(t);
  audio.autoEvents = false;
  const item = listedStation('i');
  await player.playItem(item);
  await settle();
  await tick(START_FAILOVER_MS + 1000);
  await tick(START_FAILOVER_MS + 1000);
  assert.equal(net.registrations, 3, 'every listed stream was tried');
  assert.equal(didNotPlayAt(item.id), 0, 'the last stream still has its time');
  await tick(START_FAILOVER_MS + 1000);
  assert.ok(didNotPlayAt(item.id) > 0);
  await tick(START_FAILOVER_MS * 2);
  assert.deepEqual(changes, [item.id], 'one result');
});

/** Plays `count` stations whose streams are set up but cannot be reached. */
async function playDeadStations({ player, audio, tick }, prefix, count) {
  audio.autoEvents = false;
  audio.playError = namedError('NotSupportedError');
  const items = Array.from({ length: count }, (_, index) => station(`${prefix}${index}`));
  for (const item of items) {
    await player.playItem(item);
    await settle();
    await tick(5000);
  }
  return items;
}

test('ten stations in a row that cannot be reached, with the connection working: all are marked', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const setup = await playerSetup(t);
  const items = await playDeadStations(setup, 'up', 10);
  assert.deepEqual(items.map((item) => didNotPlayAt(item.id) > 0), Array(10).fill(true));
  assert.ok(setup.net.checks <= 2, `at most one check per 30 seconds (${setup.net.checks})`);
});

test('ten stations in a row while the connection is down (adapter up, names cached): none is marked', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const setup = await playerSetup(t);
  setup.net.outside = false;
  const items = await playDeadStations(setup, 'down', 10);
  assert.deepEqual(items.map((item) => didNotPlayAt(item.id)), Array(10).fill(0));
  assert.ok(setup.net.checks >= 1 && setup.net.checks <= 2, `checked, at most once per 30 seconds (${setup.net.checks})`);
  // The same with the relay unable to connect to any stream.
  setup.audio.playError = null;
  setup.net.refuse = 'MEDIA_CONNECT_FAILED';
  const more = station('down-relay');
  await setup.player.playItem(more);
  await settle();
  await setup.tick(1000);
  assert.equal(didNotPlayAt(more.id), 0);
});

test('a single station that cannot be reached is marked', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const setup = await playerSetup(t);
  const [item] = await playDeadStations(setup, 'one', 1);
  assert.ok(didNotPlayAt(item.id) > 0);
  assert.equal(setup.net.checks, 1);
});

test('waiting for word on the connection never delays or blocks the next play', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const setup = await playerSetup(t);
  const { player, audio, net, progress } = setup;
  net.outside = 'hang';
  const [dead] = await playDeadStations(setup, 'wait', 1);
  assert.equal(net.checks, 1);
  audio.playError = null;
  const next = station('next');
  const before = net.registrations;
  await player.playItem(next);
  await settle();
  assert.equal(net.registrations, before + 1, 'connected at once');
  assert.equal(player.getCurrentItem()?.id, next.id);
  audio.paused = false;
  audio.emit('playing');
  progress();
  // Its own data was an answer from outside: the station held is marked.
  assert.ok(didNotPlayAt(dead.id) > 0);
  assert.equal(didNotPlayAt(next.id), 0);
});

test('a failure waiting for the check stays through another station and Stop, and is marked when the check answers', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const setup = await playerSetup(t);
  const { player, audio, net } = setup;
  net.outside = 'hold';
  const [dead] = await playDeadStations(setup, 'stay', 1);
  // On to another station, which is still starting, then Stop.
  audio.playError = null;
  audio.play = () => new Promise(() => {});
  void player.playItem(station('next'));
  await settle();
  player.stop();
  await settle();
  assert.equal(didNotPlayAt(dead.id), 0, 'still waiting');
  net.release(true);
  await settle();
  assert.ok(didNotPlayAt(dead.id) > 0);
  assert.equal(didNotPlayAt('test-dnp:next'), 0);
});

test('Clear cache while a failure waits for the check: nothing is marked after it', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const setup = await playerSetup(t);
  setup.net.outside = 'hold';
  const items = await playDeadStations(setup, 'clear', 3);
  await clearCache().catch(() => {});
  setup.net.release(true);
  await settle();
  assert.deepEqual(items.map((item) => didNotPlayAt(item.id)), [0, 0, 0]);
  // Stations after it are judged as usual.
  setup.net.outside = true;
  const [later] = await playDeadStations(setup, 'after', 1);
  assert.ok(didNotPlayAt(later.id) > 0);
});

test('a station that plays while its earlier failure waits for the check is not marked', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const setup = await playerSetup(t);
  const { player, audio, net, progress, changes } = setup;
  net.outside = 'hold';
  const [item] = await playDeadStations(setup, 'again', 1);
  audio.playError = null;
  await player.playItem(item);
  await settle();
  audio.paused = false;
  audio.emit('playing');
  progress();
  net.release(true);
  await settle();
  assert.equal(didNotPlayAt(item.id), 0);
  assert.deepEqual(changes, [], 'never marked');
});

test('a failure left undecided for two minutes is dropped; a later play does not mark it', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const setup = await playerSetup(t);
  const { player, audio, net, progress, tick } = setup;
  net.outside = 'hold';
  const [old] = await playDeadStations(setup, 'old', 1);
  await tick(HELD_MAX_MS);
  // Another station plays: an answer from outside, but too late for it.
  audio.playError = null;
  await player.playItem(station('fine'));
  await settle();
  audio.paused = false;
  audio.emit('playing');
  progress();
  net.release(true);
  await settle();
  assert.equal(didNotPlayAt(old.id), 0);
});

test('the player reports every start result through one place', async () => {
  const player = await read('src/lib/player.js');
  assert.match(player, /const startOutcome = createStartOutcome\(\{ limitMs: START_FAILOVER_MS, handingOver: \(\) => startWatch\.active \}\);/);
  assert.match(player, /startOutcome\.begin\(item\?\.id\);/);
  assert.match(player, /startOutcome\.streamSetUp\(item\.id\);\s*if \(relayWasProbed\(relay\)\) startOutcome\.answered\(item\.id\);/);
  assert.match(player, /startOutcome\.handOver\(item\.id\);/);
  assert.match(player, /startOutcome\.failed\(item\.id, registryFull \? 'app' : startFailureKind\(error\)\);/);
  assert.match(player, /startOutcome\.played\(currentItem\?\.id\);/);
  // Data from the stream is its answer.
  for (const event of ['loadedmetadata', 'loadeddata', 'progress']) {
    assert.match(player, new RegExp(`\\['${event}', onData\\]`));
  }
  // Autoplay refusals are the browser's, not the station's: no result at all.
  assert.equal((player.match(/if \(e\?\.name === 'NotAllowedError'\) startOutcome\.cancel\(item\.id\);\s*else startOutcome\.failed\(currentItem\?\.id, 'stream'\);/g) || []).length, 2);
  // So are this browser's or this app's own limits.
  assert.match(player, /showBrokenState\(eqPreparation\.reason, \{ showNext: false \}\);[^}]*startOutcome\.cancel\(item\.id\);/);
  assert.match(player, /showBrokenState\('HLS playback is unavailable in this browser\.', \{ showNext: false \}\);\s*startOutcome\.cancel\(item\.id\);/);
  assert.match(player, /'DASH playback could not be initialized\.',\s*\{ showNext: false \},\s*\);\s*\/\/[^\n]*\n\s*startOutcome\.cancel\(item\.id\);/);
});
