import test from 'node:test';
import assert from 'node:assert/strict';
import { resetControlSession } from '../src/lib/capture-client.js';
import { STATION_STREAMS_KEY } from '../src/lib/station-stream-addresses.js';
import { emit, getState, normalizeSettings, setCurrentItem, setPlaying } from '../src/lib/state.js';
import { mountFavoriteTitles, splitFavoriteTitle, syncFavoriteTitles } from '../src/modes/library/favorite-titles.js';
import { view } from '../src/modes/library/state.js';
import { FakeElement } from './helpers/fake-dom.js';

const turn = () => new Promise((resolve) => setImmediate(resolve));

test('favorite titles default off and only restore an explicit true', () => {
  assert.equal(normalizeSettings({}).showFavoriteTitles, false);
  assert.equal(normalizeSettings({ showFavoriteTitles: 'true' }).showFavoriteTitles, false);
  assert.equal(normalizeSettings({ showFavoriteTitles: true }).showFavoriteTitles, true);
});

test('favorite titles split only at the first spaced dash with two non-empty sides', () => {
  for (const [title, performer, song] of [
    ['Jean-Michel Jarre - Oxygene', 'Jean-Michel Jarre', 'Oxygene'],
    ['A - B - C', 'A', 'B - C'],
    ['A – B — C', 'A', 'B — C'],
    ['A — B', 'A', 'B'],
    ['A song', '', 'A song'],
    [' - B - C', '', ' - B - C'],
    ['A - ', '', 'A - '],
    [' - ', '', ' - '],
  ]) {
    assert.deepEqual(splitFavoriteTitle(title), { performer, song }, title);
  }
});

test('Favorites observes only radio cards and stops peeking on hide, tab change, and turn off', async (t) => {
  const original = {
    document: globalThis.document, fetch: globalThis.fetch,
    IntersectionObserver: globalThis.IntersectionObserver, MutationObserver: globalThis.MutationObserver,
  };
  const state = getState();
  const previousSource = view.activeSource;
  const previousSetting = state.settings.showFavoriteTitles;
  const previousFavorites = state.favorites;
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let addressEdits = null;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true, value: { getItem: (key) => key === STATION_STREAMS_KEY ? addressEdits : null },
  });
  const host = new FakeElement();
  const button = new FakeElement('', 'button');
  const radio = new FakeElement();
  const tv = new FakeElement();
  const playing = new FakeElement();
  const hls = new FakeElement();
  const observers = [];
  const requests = [];
  for (const [card, id, type] of [[radio, 'r1', 'radio'], [tv, 'tv', 'tv'], [playing, 'r2', 'radio'], [hls, 'r3', 'radio']]) {
    card.__item = { id, title: id, type, delivery: 'live', stream_url: 'https://station.example/live' };
    card.__open = new FakeElement('', 'button');
    card.__titleNode = { after(node) { card.songLine = node; } };
    card.parentElement = host;
    host.appendChild(card);
  }
  radio.__open.setAttribute('aria-describedby', 'card-trouble-1');
  hls.__item.stream_url = 'https://station.example/live.m3u8?token=abc#live';
  hls.__item.stream_kind = 'audio';
  state.favorites = [radio.__item, tv.__item, playing.__item, hls.__item];

  globalThis.document = Object.assign(new EventTarget(), {
    hidden: false, createElement: (tag) => new FakeElement('', tag),
  });
  globalThis.IntersectionObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.cards = new Set();
      observers.push(this);
    }
    observe(card) { this.cards.add(card); }
    unobserve(card) { this.cards.delete(card); }
    disconnect() { this.cards.clear(); }
    show(...cards) {
      this.callback(cards.map((target) => ({ target, isIntersecting: true, intersectionRatio: 1 })), this);
    }
  };
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  const session = { ok: true, json: async () => ({ ok: true, data: { token: 'session' } }) };
  let heldSession;
  globalThis.fetch = (path, options) => {
    if (path === '/api/v1/session') return heldSession || Promise.resolve(session);
    return new Promise((resolve) => requests.push({ path, options, resolve }));
  };
  const titleAnswer = (title) => ({ ok: true, json: async () => ({ ok: true, data: { title } }) });
  const assertSongLine = (title, ...lines) => {
    assert.deepEqual(radio.songLine.children.map((child) => child.textContent), lines);
    assert.equal(radio.songLine.getAttribute('title'), title);
    assert.equal(radio.songLine.getAttribute('aria-label'), title);
    const descriptionId = radio.songLine.getAttribute('id');
    if (title) assert.match(descriptionId, /^favorite-song-\d+$/);
    else assert.equal(descriptionId, null);
    assert.equal(radio.__open.getAttribute('aria-describedby'),
      title ? `card-trouble-1 ${descriptionId}` : 'card-trouble-1');
  };
  const toggle = (enabled) => {
    state.settings.showFavoriteTitles = enabled;
    emit('settings-change', state.settings);
  };
  view.activeSource = 'favorites';
  toggle(false);
  const unmount = mountFavoriteTitles(host, button);
  t.after(() => {
    unmount();
    toggle(previousSetting);
    setPlaying(false);
    setCurrentItem(null);
    view.activeSource = previousSource;
    state.favorites = previousFavorites;
    if (storage) Object.defineProperty(globalThis, 'localStorage', storage);
    else delete globalThis.localStorage;
    Object.assign(globalThis, original);
    resetControlSession();
  });

  assert.equal(observers.length, 0);
  assert.equal(radio.songLine, undefined);
  toggle(true);
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assertSongLine(null);
  assert.equal(radio.songLine.className, 'favorite-song-title');
  assert.equal(playing.songLine.className, 'favorite-song-title');
  assert.equal(hls.songLine.className, 'favorite-song-title');
  assert.equal(tv.songLine, undefined);
  assert.deepEqual([...observers[0].cards], [radio, playing, hls]);
  setCurrentItem(playing.__item);
  setPlaying(true);
  observers[0].show(radio, playing, hls);
  await turn();
  assert.deepEqual(requests.map(({ options }) => JSON.parse(options.body).item_id), ['r1']);
  assert.equal(requests[0].path, '/api/v1/streams/title-peek');
  requests[0].resolve(titleAnswer('A song'));
  await turn();
  assertSongLine('A song', 'A song');

  const cachedLine = radio.songLine;
  radio.__item.stream_kind = 'hls';
  syncFavoriteTitles();
  assert.equal(cachedLine.removed, true, 'a manifest cannot display a cached audio peek');
  assertSongLine(null);
  radio.__item.stream_kind = 'audio';
  syncFavoriteTitles();
  assertSongLine('A song', 'A song');

  const oldLine = radio.songLine;
  const editAddress = (main) => {
    addressEdits = JSON.stringify({ version: 1, stations: { r1: { main } } });
    emit('station-streams-change', 'r1');
  };
  editAddress('https://station.example/edited');
  assert.equal(oldLine.removed, true);
  assertSongLine(null);
  await turn();
  assert.equal(JSON.parse(requests[1].options.body).url, 'https://station.example/edited');

  editAddress('https://station.example/replacement');
  assert.equal(requests[1].options.signal.aborted, true);
  requests[1].resolve(titleAnswer('Stale song'));
  await turn();
  assertSongLine(null);
  assert.equal(JSON.parse(requests[2].options.body).url, 'https://station.example/replacement');
  const replacement = ' Jean-Michel Jarre — Oxygene - Part 2 ';
  requests[2].resolve(titleAnswer(replacement));
  await turn();
  assertSongLine(replacement, '♪ Oxygene - Part 2', 'Jean-Michel Jarre');
  const replacementLine = radio.songLine;

  setPlaying(false);
  await turn();
  assert.equal(requests.length, 4);
  setPlaying(true);
  assert.equal(requests[3].options.signal.aborted, true);
  requests[3].resolve(titleAnswer('Stale playback peek'));
  await turn();
  assert.equal(radio.songLine, replacementLine);

  setPlaying(false);
  await turn();
  assert.equal(requests.length, 5);
  playing.__item.stream_kind = 'hls';
  syncFavoriteTitles();
  assert.equal(requests[4].options.signal.aborted, true);
  requests[4].resolve(titleAnswer('Stale manifest peek'));
  await turn();
  assert.equal(radio.songLine, replacementLine);

  document.hidden = true;
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(radio.songLine.removed, true);
  assert.equal(radio.__open.getAttribute('aria-describedby'), 'card-trouble-1');
  observers[0].show(radio);
  await turn();
  assert.equal(requests.length, 5);

  document.hidden = false;
  document.dispatchEvent(new Event('visibilitychange'));
  view.activeSource = 'all';
  syncFavoriteTitles();
  observers[1].show(radio);
  assert.equal(observers[1].cards.size, 0);

  view.activeSource = 'favorites';
  syncFavoriteTitles();
  toggle(false);
  assert.equal(observers[2].cards.size, 0);
  assert.equal(radio.songLine.removed, true);
  assert.equal(playing.songLine.removed, true);
  assert.equal(hls.songLine.removed, true);
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.equal(requests.length, 5);
  playing.__item.stream_kind = 'audio';
  resetControlSession();
  let finishSession;
  heldSession = new Promise((resolve) => { finishSession = resolve; });
  toggle(true);
  observers[3].show(playing);
  await turn();
  assert.equal(requests.length, 5);
  // The card disappears before the DOM observer has delivered the removal.
  playing.parentElement = null;
  host.children.splice(host.children.indexOf(playing), 1);
  finishSession(session);
  await turn();
  assert.equal(requests.length, 5, 'a session arriving after removal cannot send a peek');
});
