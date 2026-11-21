import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  NOW_PLAYING_METER_SEGMENTS, NOW_PLAYING_MODE, NOW_PLAYING_TEXT, announceable, countryText, detailRows, elapsedText, kindText,
  languageText, mountNowPlaying, msToNextMinute, nowPlayingMounted, nowPlayingView, playingForText,
  renderNowPlaying, songApplies, songView,
} from '../src/modes/now-playing.js';
import { MEDIA_ADVANCING_EVENT, createPlayClock } from '../src/lib/play-clock.js';
import { meterLayout, meterScale, METER_BARS } from '../src/lib/player-meter.js';
import { playedQualityLabel } from '../src/lib/stream-quality.js';
import { bindSongStar } from '../src/lib/song-star.js';
import { createPlayerMeter } from '../src/lib/player-meter.js';
import { NOW_PLAYING_EVENT } from '../src/lib/now-playing.js';
import { FAVORITE_GROUPS_EVENT } from '../src/lib/favorite-groups.js';
import { COPIED_LABEL, COPY_FAILED, COPY_LABEL } from '../src/lib/song-log-panel.js';
import { fakeMotion, fakeResizeObserverWin } from './helpers/visualizer-fakes.js';
import { createClockHarness, fakeAnalyser } from './helpers/signal-harness.js';
import { createAudioSignal } from '../src/lib/audio-signal.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const RADIO = Object.freeze({
  id: 'radio-browser:jazz-1',
  title: 'Jazz FM',
  source: 'radio-browser',
  type: 'radio',
  delivery: 'live',
  stream_kind: 'audio',
  country: 'DE',
  language: 'german,english',
  thumbnail: '',
  _extra: { bitrate: 128, codec: 'MP3' },
});

const radio = (extra = {}) => ({ ...RADIO, _extra: { ...RADIO._extra }, ...extra });

/* ---------------- What is shown for each kind of item ---------------- */

test('each kind of item is named plainly', () => {
  assert.equal(kindText(radio()), 'Radio station');
  assert.equal(kindText({ type: 'tv', delivery: 'live', source: 'iptv-org' }), 'TV channel');
  assert.equal(kindText({ type: 'audio', delivery: 'on-demand', source: 'gpodder' }), 'Podcast');
  assert.equal(kindText({ type: 'video', delivery: 'on-demand', source: 'gpodder' }), 'Video podcast');
  assert.equal(kindText({ type: 'video', delivery: 'on-demand', source: 'internet-archive' }), 'Video');
  assert.equal(kindText({ type: 'video', delivery: 'live', source: 'peertube' }), 'Live video');
  assert.equal(kindText({ type: 'audio', delivery: 'on-demand', source: 'librivox' }), 'Audio');
  assert.equal(kindText({ type: 'audio', delivery: 'live', source: 'media-ccc' }), 'Live audio');
  assert.equal(kindText({ type: 'radio', source: 'playlist' }), 'Radio station', 'a playlist station');
  assert.equal(kindText(null), '');
});

test('the song part: the announced song of this item, a plain line when a station announces none, nothing for video', () => {
  const item = radio();
  assert.deepEqual(songView(item, { itemId: item.id, title: 'Miles Davis - So What' }),
    { show: true, title: 'Miles Davis - So What', text: 'Miles Davis - So What' });
  // Another station's song is never shown under this one.
  assert.deepEqual(songView(item, { itemId: 'radio-browser:other', title: 'Other song' }),
    { show: true, title: '', text: NOW_PLAYING_TEXT.noSong });
  assert.deepEqual(songView(item, null), { show: true, title: '', text: NOW_PLAYING_TEXT.noSong });
  assert.match(NOW_PLAYING_TEXT.noSong, /not announcing a song title/);
  const tv = { id: 'iptv-org:x', type: 'tv', delivery: 'live' };
  assert.deepEqual(songView(tv, null), { show: false, title: '', text: '' });
  const episode = { id: 'gpodder:e1', type: 'audio', delivery: 'on-demand', source: 'gpodder' };
  assert.equal(songView(episode, null).show, false);
  assert.equal(songApplies({ type: 'audio', delivery: 'live' }), true);
  assert.equal(songApplies({ type: 'video', delivery: 'live' }), false);
  assert.equal(songApplies(null), false);
});

test('playing time, countries and languages read as words', () => {
  assert.equal(elapsedText(0), 'Under a minute');
  assert.equal(elapsedText(59_999), 'Under a minute');
  assert.equal(elapsedText(60_000), '1 min');
  assert.equal(elapsedText(59 * 60_000 + 59_000), '59 min');
  assert.equal(elapsedText(60 * 60_000), '1 h');
  assert.equal(elapsedText(125 * 60_000), '2 h 5 min');
  assert.equal(elapsedText(Number.NaN), '');
  assert.equal(msToNextMinute(0), 60_000);
  assert.equal(msToNextMinute(61_000), 59_000);
  assert.equal(playingForText(null, false), NOW_PLAYING_TEXT.notYet);
  assert.equal(playingForText(null, true), 'Under a minute');
  assert.equal(playingForText(12 * 60_000, true), '12 min');
  assert.equal(playingForText(12 * 60_000, false), '12 min (paused)');
  assert.equal(countryText('DE'), 'Germany');
  assert.equal(countryText('de'), 'Germany');
  assert.equal(countryText('The Netherlands'), 'The Netherlands');
  assert.equal(countryText(''), '');
  assert.equal(languageText('german,english'), 'German, English');
  assert.equal(languageText('fr'), 'French');
  assert.equal(languageText('  '), '');
  assert.equal(languageText('a,b,c,d,e,f'), 'A, B, C, D', 'at most four');
});

test('stream details: only what is known, the format of the stream that plays first', () => {
  const item = radio();
  assert.deepEqual(detailRows(item, { stream: null, playedMs: 5 * 60_000, playing: true }), [
    ['Source', 'Radio Browser'],
    ['Type', 'Radio station'],
    ['Format', 'MP3 \u00B7 128 kbps'],
    ['Country', 'Germany'],
    ['Language', 'German, English'],
    ['Playing for', '5 min'],
  ]);
  // Pick the best stream played another listed stream: its format is shown.
  const rows = detailRows(item, { stream: { url: 'x', bitrate: 320, codec: 'AAC' }, playedMs: null, playing: false });
  assert.deepEqual(rows.find(([label]) => label === 'Format'), ['Format', 'AAC \u00B7 320 kbps']);
  assert.deepEqual(rows.at(-1), ['Playing for', NOW_PLAYING_TEXT.notYet]);
  // Nothing listed: no Format, Country or Language row at all.
  const bare = { id: 'internet-archive:x', source: 'internet-archive', type: 'video', delivery: 'on-demand' };
  assert.deepEqual(detailRows(bare, {}).map(([label]) => label), ['Source', 'Type', 'Playing for']);
  assert.deepEqual(detailRows(null), []);
  // The player bar's hover line uses the same helper.
  assert.equal(playedQualityLabel(item, null), 'MP3 \u00B7 128 kbps');
  assert.equal(playedQualityLabel(item, { bitrate: 64 }), '64 kbps');
  assert.equal(playedQualityLabel({}, null), '');
});

test('the view: nothing loaded is the empty state; a renamed favorite shows its own name, the original and its category', () => {
  assert.deepEqual(nowPlayingView({ item: null }), { empty: true });
  const item = radio();
  const names = new Map([[item.id, 'My Jazz']]);
  const groups = { groupOf: (id) => (id === item.id ? 'g1' : ''), nameOf: (id) => (id === 'g1' ? 'Evening' : '') };
  const view = nowPlayingView({ item, favorite: true, names, groups, playing: true, playedMs: 0 });
  assert.equal(view.empty, false);
  assert.equal(view.name, 'My Jazz');
  assert.equal(view.originalName, 'Jazz FM');
  assert.equal(view.category, 'Evening');
  assert.equal(view.favorite, true);
  assert.equal(view.initials, 'MJ');
  assert.equal(view.logo, true);
  // Not a favorite (any more): its own name, no category, even if one is stored.
  const plain = nowPlayingView({ item, favorite: false, names, groups });
  assert.equal(plain.name, 'Jazz FM');
  assert.equal(plain.originalName, '');
  assert.equal(plain.category, '');
  assert.equal(nowPlayingView({ item: { ...item, title: '  ' } }).name, NOW_PLAYING_TEXT.untitled);
  assert.equal(nowPlayingView({ item: { id: 'x', type: 'video', title: 'Clip' } }).logo, false);
});

/* ---------------- The play clock ---------------- */

test('the play clock counts only time with sound, per item, and starts again for another item', () => {
  let now = 1_000;
  const clock = createPlayClock({ now: () => now });
  const a = { id: 'a' };
  assert.equal(clock.played('a'), null);
  clock.itemChanged(a);
  assert.equal(clock.played('a'), null, 'connecting is not playing');
  clock.advancingChanged(true, a);
  now += 90_000;
  assert.equal(clock.played('a'), 90_000);
  clock.advancingChanged(false, a); // a pause, buffering or a reconnect wait
  now += 600_000;
  assert.equal(clock.played('a'), 90_000, 'a pause adds nothing');
  clock.itemChanged(a); // the same item started again (or a reconnect)
  clock.advancingChanged(true, a);
  now += 30_000;
  assert.equal(clock.played('a'), 120_000);
  assert.equal(clock.played('b'), null, 'only the loaded item has a time');
  clock.itemChanged({ id: 'b' });
  assert.equal(clock.played('a'), null);
  assert.equal(clock.played('b'), null);
  clock.advancingChanged(true, { id: 'b' });
  now += 5_000;
  assert.equal(clock.played('b'), 5_000);
  clock.itemChanged(null); // Stop
  assert.equal(clock.played('b'), null);
  assert.equal(clock.running, false);
});

test('the play clock follows the player events and stops following when asked', () => {
  let now = 0;
  const clock = createPlayClock({ now: () => now });
  const listeners = new Map();
  const subscribe = (event, fn) => {
    listeners.set(event, fn);
    return () => listeners.delete(event);
  };
  let item = { id: 'x' };
  const stop = clock.start(subscribe, () => item, () => true);
  assert.deepEqual([...listeners.keys()].sort(), ['current-item', MEDIA_ADVANCING_EVENT].sort());
  assert.equal(MEDIA_ADVANCING_EVENT, 'media-advancing');
  assert.equal(clock.running, true, 'already advancing when started');
  now = 61_000;
  listeners.get(MEDIA_ADVANCING_EVENT)(false);
  assert.equal(clock.played('x'), 61_000);
  item = { id: 'y' };
  listeners.get('current-item')(item);
  assert.equal(clock.played('x'), null);
  stop();
  assert.equal(listeners.size, 0);
});

test('the play clock reads a monotonic clock: setting the computer clock back or forward changes nothing', (t) => {
  // The default clock is performance.now, not the wall clock.
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 20, 12) });
  let mono = 5_000;
  t.mock.method(globalThis.performance, 'now', () => mono);
  const clock = createPlayClock();
  const item = { id: 'a' };
  clock.itemChanged(item);
  clock.advancingChanged(true, item);
  mono += 10 * 60_000;
  t.mock.timers.setTime(Date.UTC(2026, 10, 20, 11, 10)); // set back 1 h meanwhile
  assert.equal(clock.played('a'), 10 * 60_000, 'set back 1 h: still 10 min, not 0');
  clock.advancingChanged(false, item); // the next pause keeps the minutes
  assert.equal(clock.played('a'), 10 * 60_000);
  clock.advancingChanged(true, item);
  mono += 60_000;
  t.mock.timers.setTime(Date.UTC(2026, 10, 20, 14, 11)); // set forward 3 h
  assert.equal(clock.played('a'), 11 * 60_000, 'set forward 3 h: 11 min, not 3 h 1 min');
  assert.equal(elapsedText(clock.played('a')), '11 min');
  clock.advancingChanged(false, item);
  assert.equal(clock.played('a'), 11 * 60_000);
});

/* ---------------- The large meter ---------------- */

test('the large meter has big LED segments; the player bar meter is unchanged', () => {
  for (const dpr of [1, 1.25, 1.5, 2]) {
    assert.equal(meterScale(36 * dpr, dpr), dpr, 'no target: the screen scale');
    assert.equal(meterScale(36 * dpr, dpr, 0), dpr);
    for (const cssHeight of [56, 120, 300]) {
      const height = Math.round(cssHeight * dpr);
      const width = Math.round(cssHeight * 5 * dpr);
      const layout = meterLayout(width, height, meterScale(height, dpr, NOW_PLAYING_METER_SEGMENTS), METER_BARS);
      assert.ok(layout.segments >= NOW_PLAYING_METER_SEGMENTS - 3 && layout.segments <= NOW_PLAYING_METER_SEGMENTS + 1,
        `${cssHeight} px at ${dpr}: ${layout.segments} segments`);
      assert.ok(layout.segHeight >= 2 * dpr - 0.5, 'never thinner than the bar meter');
      assert.ok(layout.top + layout.segments * layout.segHeight + (layout.segments - 1) * layout.segGap <= height);
      assert.ok(layout.left + METER_BARS * layout.barWidth + (METER_BARS - 1) * layout.barGap <= width);
    }
  }
  // A short canvas never asks for segments smaller than the bar meter's.
  assert.equal(meterScale(20, 1, 20), 1);
});

/* ---------------- Mount and clean-up ---------------- */

class FakeEl extends EventTarget {
  constructor(tag = 'div') {
    super();
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.className = '';
    this.textContent = '';
    this.title = '';
    this.hidden = false;
    this.dataset = {};
    this.listeners = 0;
    this.removed = false;
    this.width = 300;
    this.height = 150;
    const props = new Map();
    this.style = { props, setProperty: (name, value) => props.set(name, value) };
    const names = new Set();
    this.classList = {
      add: (...list) => list.forEach((name) => names.add(name)),
      remove: (...list) => list.forEach((name) => names.delete(name)),
      contains: (name) => names.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !names.has(name) : Boolean(force);
        if (on) names.add(name); else names.delete(name);
        return on;
      },
    };
  }
  addEventListener(type, fn, options) { this.listeners += 1; super.addEventListener(type, fn, options); }
  removeEventListener(type, fn, options) { this.listeners -= 1; super.removeEventListener(type, fn, options); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
  remove() { this.removed = true; }
  set innerHTML(html) { this.html = html; }
  get innerHTML() { return this.html || ''; }
  click() { this.dispatchEvent(new Event('click')); }
  getContext(kind) {
    if (this.tagName !== 'CANVAS' || kind !== '2d') return null;
    this.ctx ||= {
      draws: 0, globalAlpha: 1, fillStyle: '',
      clearRect: () => { this.ctx.draws += 1; }, beginPath() {}, rect() {}, fill() {},
    };
    return this.ctx;
  }
  /** Every element below this one. */
  all() { return this.children.flatMap((child) => (child instanceof FakeEl ? [child, ...child.all()] : [])); }
  listenerTotal() { return this.listeners + this.all().reduce((sum, child) => sum + child.listeners, 0); }
}

function fakeBus() {
  const map = new Map();
  return {
    subscribe(event, fn) {
      if (!map.has(event)) map.set(event, new Set());
      map.get(event).add(fn);
      return () => map.get(event)?.delete(fn);
    },
    emit(event, payload) { for (const fn of [...(map.get(event) || [])]) fn(payload); },
    count() { return [...map.values()].reduce((sum, set) => sum + set.size, 0); },
    events() { return [...map.entries()].filter(([, set]) => set.size).map(([event]) => event).sort(); },
  };
}

function fakeStarred() {
  const songs = [];
  const listeners = new Set();
  return {
    songs,
    listeners,
    starredFor: (song) => songs.find((entry) => entry.title === song.title && entry.stationId === song.stationId) || null,
    toggle(song) {
      const at = songs.findIndex((entry) => entry.title === song.title && entry.stationId === song.stationId);
      if (at >= 0) songs.splice(at, 1); else songs.push(song);
      for (const fn of [...listeners]) fn();
    },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

function harness({
  item = null, playing = false, title = '', favorite = false, names = new Map(), groups = null,
  custom = '', customFails = false, resolveTo = '', clipboard = undefined, openMode = () => {},
  bestStream = () => null, settings = {}, makeSignal = null, loadImage = null,
} = {}) {
  const bus = fakeBus();
  const docListeners = new Map();
  const doc = {
    visibilityState: 'visible',
    createElement: (tag) => new FakeEl(tag),
    addEventListener: (name, fn) => {
      if (!docListeners.has(name)) docListeners.set(name, new Set());
      docListeners.get(name).add(fn);
    },
    removeEventListener: (name, fn) => docListeners.get(name)?.delete(fn),
  };
  const signalSubs = new Set();
  const signal = makeSignal ? makeSignal(doc) : {
    opts: null,
    subscribe(fn, opts) { signalSubs.add(fn); this.opts = opts; return () => signalSubs.delete(fn); },
  };
  const motion = fakeMotion(false);
  const win = fakeResizeObserverWin(motion);
  const timers = new Set();
  const loads = [];
  const resolves = [];
  const pictureListeners = new Set();
  let now = 0;
  const clock = createPlayClock({ now: () => now });
  const state = {
    item,
    playing,
    nowPlaying: title && item ? { itemId: item.id, mediaId: 'm1', title, changedAt: 1 } : null,
    favorites: new Set(favorite && item ? [item.id] : []),
    custom,
    settings,
  };
  if (item) {
    clock.itemChanged(item);
    if (playing) clock.advancingChanged(true, item);
  }
  const starred = fakeStarred();
  const meters = [];
  const deps = {
    doc,
    win,
    subscribe: (event, fn) => bus.subscribe(event, fn),
    getCurrentItem: () => state.item,
    getNowPlaying: () => state.nowPlaying,
    isPlaying: () => state.playing,
    getSettings: () => state.settings,
    isFavorite: (id) => state.favorites.has(id),
    addFavorite: (entry) => { state.favorites.add(entry.id); bus.emit('favorites-change'); },
    removeFavorite: (id) => { state.favorites.delete(id); bus.emit('favorites-change'); },
    favoriteNames: () => names,
    favoriteGroups: () => groups || { groupOf: () => '', nameOf: () => '' },
    signal,
    starred,
    bindSongStar,
    createMeter: (options) => {
      const meter = createPlayerMeter(options);
      meters.push(meter);
      return meter;
    },
    playClock: clock,
    clipboard,
    loadImage: loadImage || ((img, source, options) => {
      loads.push({ source, options });
      if (source === custom && customFails) return Promise.reject(new Error('Artwork image could not load.'));
      img.setAttribute('src', source === custom ? 'blob:station-picture' : source);
      return Promise.resolve(img);
    }),
    resolveArtwork: (target, options) => {
      resolves.push(options);
      if (resolveTo) target.thumbnail = resolveTo;
      return Promise.resolve(target);
    },
    customSourceFor: () => state.custom,
    onStationImagesChange: (fn) => { pictureListeners.add(fn); return () => pictureListeners.delete(fn); },
    playedStream: () => null,
    bestStream,
    openMode,
    setTimer: (fn, ms) => { const timer = { fn, ms }; timers.add(timer); return timer; },
    clearTimer: (timer) => { timers.delete(timer); },
  };
  const host = new FakeEl('main');
  const view = mountNowPlaying(host, deps);
  return {
    view, host, bus, doc, docListeners, signalSubs, signal, motion, win, timers, loads, resolves, pictureListeners,
    clock, state, starred, meters,
    get now() { return now; },
    set now(value) { now = value; },
    setVisible(visible) {
      doc.visibilityState = visible ? 'visible' : 'hidden';
      for (const fn of [...(docListeners.get('visibilitychange') || [])]) fn();
    },
    docListenerCount: () => [...docListeners.values()].reduce((sum, set) => sum + set.size, 0),
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('nothing playing: a calm empty state that points to the Library and the Tuner, with nothing running', async () => {
  const opened = [];
  const h = harness({ openMode: (mode) => opened.push(mode) });
  const { parts } = h.view;
  assert.equal(h.view.root.dataset.state, 'empty');
  assert.equal(parts.empty.hidden, false);
  assert.equal(parts.layout.hidden, true);
  const texts = parts.empty.all().map((node) => node.textContent);
  assert.ok(texts.includes(NOW_PLAYING_TEXT.emptyTitle));
  assert.equal(parts.empty.children[0].tagName, 'H2', 'a heading');
  parts.libraryBtn.click();
  parts.tunerBtn.click();
  assert.deepEqual(opened, ['library', 'tuner']);
  // Nothing animates: no timer, no picture load, and the meter is not laid out.
  h.win.observers[0].fire(0, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.loads.length, 0);
  assert.equal(h.signalSubs.size, 0);
  assert.equal(h.view.timerPending, false);
  await settle();
  h.view.destroy();
});

test('a playing station: large picture, name, category, song with star and Copy, details and the large meter', async () => {
  const item = radio();
  const groups = { groupOf: () => 'g1', nameOf: () => 'Evening' };
  const writes = [];
  const h = harness({
    item, playing: true, title: 'Miles Davis - So What', favorite: true, groups,
    custom: 'station-image:abc:1', clipboard: { writeText: async (text) => { writes.push(text); } },
  });
  const { parts } = h.view;
  assert.equal(h.view.root.dataset.state, 'playing');
  assert.equal(parts.empty.hidden, true);
  assert.equal(parts.title.tagName, 'H2');
  assert.equal(parts.title.textContent, 'Jazz FM');
  assert.equal(parts.kind.textContent, 'Radio station');
  assert.equal(parts.category.textContent, 'Category: Evening');
  assert.equal(parts.category.hidden, false);
  assert.equal(parts.original.hidden, true);
  assert.equal(parts.fav.getAttribute('aria-pressed'), 'true');
  assert.equal(parts.fav.getAttribute('aria-label'), NOW_PLAYING_TEXT.removeFavorite);
  assert.equal(parts.artInitials.textContent, 'JF');
  assert.ok(parts.art.classList.contains('is-logo'));
  // The user's own picture first, at the player bar's priority; the backdrop
  // gets the same picture once it has loaded.
  await settle();
  assert.equal(h.loads[0].source, 'station-image:abc:1');
  assert.equal(h.loads[0].options.priority, 20);
  assert.ok(parts.artImg.classList.contains('loaded'));
  assert.equal(parts.backdropImg.getAttribute('src'), 'blob:station-picture');
  assert.equal(parts.backdrop.hidden, false);
  assert.ok(h.view.root.classList.contains('has-picture'));
  // The song, its star (a real song) and Copy.
  assert.equal(parts.songText.textContent, 'Miles Davis - So What');
  assert.equal(parts.songStarBtn.hidden, false);
  assert.equal(parts.copyBtn.hidden, false);
  parts.songStarBtn.click();
  assert.equal(h.starred.songs.length, 1);
  assert.equal(h.starred.songs[0].station, 'Jazz FM');
  assert.equal(parts.songStarBtn.getAttribute('aria-pressed'), 'true');
  parts.copyBtn.click();
  await settle();
  assert.deepEqual(writes, ['Miles Davis - So What']);
  assert.equal(parts.copyBtn.textContent, COPIED_LABEL);
  assert.equal(parts.copyStatus.textContent, COPIED_LABEL);
  const copyTimer = [...h.timers].find((timer) => timer.ms === 1500);
  copyTimer.fn();
  h.timers.delete(copyTimer);
  assert.equal(parts.copyBtn.textContent, COPY_LABEL);
  assert.equal(parts.copyStatus.textContent, '');
  // The details.
  const facts = parts.facts.children.map((row) => row.children.map((cell) => cell.textContent));
  assert.deepEqual(facts.map(([label]) => label), ['Source', 'Type', 'Format', 'Country', 'Language', 'Playing for']);
  assert.equal(parts.facts.children[0].children[0].tagName, 'DT');
  // The meter: decorative, on the shared signal at the bar meter's rate, once laid out.
  assert.equal(parts.meterBox.getAttribute('aria-hidden'), 'true');
  assert.equal(h.signalSubs.size, 0, 'not laid out yet');
  h.win.observers[0].fire(800, 200);
  assert.equal(h.signalSubs.size, 1);
  assert.equal(h.signal.opts.fps, 15);
  assert.equal(parts.canvas.height, 200);
  h.view.destroy();
});

test('a picture of the user\'s that will not load falls back to the item\'s own artwork; none at all leaves the initials tile', async () => {
  const relayUrl = '/api/v1/assets/abcdefghijklmnop1234';
  const h = harness({ item: radio(), playing: true, custom: 'station-image:abc:1', customFails: true, resolveTo: relayUrl });
  await settle();
  await settle();
  assert.deepEqual(h.loads.map((load) => load.source), ['station-image:abc:1', relayUrl]);
  assert.equal(h.resolves.length, 1);
  assert.equal(h.resolves[0].signal, undefined, 'the shared lookup is never cancelled by this tab');
  assert.equal(h.view.parts.backdropImg.getAttribute('src'), relayUrl);
  h.view.destroy();

  const bare = harness({ item: radio(), playing: true });
  await settle();
  assert.equal(bare.loads.length, 0);
  assert.equal(bare.view.parts.artImg.classList.contains('loaded'), false);
  assert.equal(bare.view.parts.backdrop.hidden, true, 'the plain app background');
  assert.equal(bare.view.root.classList.contains('has-picture'), false);
  assert.equal(bare.view.parts.artInitials.hidden, false);
  bare.view.destroy();
});

test('the star follows the player bar rules: what is announced must look like a song', async () => {
  const h = harness({ item: radio(), playing: true, title: 'Jazz FM' });
  assert.equal(h.view.parts.songText.textContent, 'Jazz FM', 'the line is shown as announced');
  assert.equal(h.view.parts.songStarBtn.hidden, true, 'the station\'s own name is not a song');
  h.state.nowPlaying = { itemId: h.state.item.id, title: '- - -' };
  h.bus.emit(NOW_PLAYING_EVENT, h.state.nowPlaying);
  assert.equal(h.view.parts.songStarBtn.hidden, true, 'no letters or digits');
  h.state.nowPlaying = { itemId: h.state.item.id, title: 'Nina Simone - Sinnerman' };
  h.bus.emit(NOW_PLAYING_EVENT, h.state.nowPlaying);
  assert.equal(h.view.parts.songStarBtn.hidden, false);
  // A renamed favorite: its original station name is not a song either.
  const names = new Map([[RADIO.id, 'My Jazz']]);
  const renamed = harness({ item: radio(), playing: true, title: 'Jazz FM', favorite: true, names });
  assert.equal(renamed.view.parts.title.textContent, 'My Jazz');
  assert.equal(renamed.view.parts.original.textContent, 'Original name: Jazz FM');
  assert.equal(renamed.view.parts.songStarBtn.hidden, true);
  h.view.destroy();
  renamed.view.destroy();
});

test('no title announced: said plainly, no star or Copy; a copy that fails says so', async () => {
  const h = harness({ item: radio(), playing: true, clipboard: { writeText: async () => { throw new Error('denied'); } } });
  const { parts } = h.view;
  assert.equal(parts.song.hidden, false);
  assert.equal(parts.songText.textContent, NOW_PLAYING_TEXT.noSong);
  assert.ok(parts.songText.classList.contains('is-none'));
  assert.equal(parts.songStarBtn.hidden, true);
  assert.equal(parts.copyBtn.hidden, true);
  h.state.nowPlaying = { itemId: h.state.item.id, title: 'A - B' };
  h.bus.emit(NOW_PLAYING_EVENT, h.state.nowPlaying);
  parts.copyBtn.click();
  await settle();
  assert.equal(parts.copyStatus.textContent, COPY_FAILED);
  h.view.destroy();
  // TV: no song part at all, the details and the tile only.
  const tv = harness({ item: { id: 'iptv-org:x', title: 'News 24', source: 'iptv-org', type: 'tv', delivery: 'live' }, playing: true });
  assert.equal(tv.view.parts.song.hidden, true);
  assert.equal(tv.view.parts.kind.textContent, 'TV channel');
  tv.view.destroy();
});

test('a new song is announced once to screen readers, never on opening the tab', () => {
  const h = harness({ item: radio(), playing: true, title: 'First - Song' });
  const { announcer } = h.view.parts;
  assert.equal(announcer.getAttribute('aria-live'), 'polite');
  assert.equal(announcer.textContent, '', 'the song already playing is not read out on opening');
  h.state.nowPlaying = { itemId: h.state.item.id, title: 'Second - Song' };
  h.bus.emit(NOW_PLAYING_EVENT, h.state.nowPlaying);
  assert.equal(announcer.textContent, 'Now playing: Second - Song');
  announcer.textContent = '';
  h.bus.emit('playing-change', true); // other events re-render: no second announcement
  h.bus.emit(NOW_PLAYING_EVENT, h.state.nowPlaying);
  assert.equal(announcer.textContent, '');
  h.state.nowPlaying = null; // the title goes away and comes back
  h.bus.emit(NOW_PLAYING_EVENT, null);
  h.state.nowPlaying = { itemId: h.state.item.id, title: 'Second - Song' };
  h.bus.emit(NOW_PLAYING_EVENT, h.state.nowPlaying);
  assert.equal(announcer.textContent, '', 'the same title is said once');
  // The visible line is not itself a live region.
  assert.equal(h.view.parts.songText.getAttribute('aria-live'), null);
  h.view.destroy();
});

test('what the star treats as not a song is shown but never announced', () => {
  const names = new Map([[RADIO.id, 'My Jazz']]);
  const h = harness({ item: radio(), playing: true, title: 'First - Song', favorite: true, names });
  const { announcer, songText } = h.view.parts;
  const send = (title) => {
    announcer.textContent = '';
    h.state.nowPlaying = { itemId: RADIO.id, title };
    h.bus.emit(NOW_PLAYING_EVENT, h.state.nowPlaying);
  };
  for (const title of ['Jazz FM', 'JAZZ-FM!', 'My Jazz', '*** - ***', '...']) {
    send(title);
    assert.equal(songText.textContent, title, `"${title}" is still shown`);
    assert.equal(announcer.textContent, '', `"${title}" is not read out`);
  }
  send('Second - Song');
  assert.equal(announcer.textContent, 'Now playing: Second - Song');
  h.view.destroy();
  // The pure rule, the same as the star's.
  const shown = { id: RADIO.id, title: 'My Jazz', originalTitle: 'Jazz FM', __favoriteName: true };
  assert.equal(announceable('Jazz FM', shown), false, 'the original name of a renamed favorite');
  assert.equal(announceable('my jazz', shown), false, 'the name shown');
  assert.equal(announceable('!!!', shown), false, 'no letter or digit');
  assert.equal(announceable('Miles Davis - So What', shown), true);
  assert.equal(announceable('Jazz FM', { id: 'x', title: 'Other FM' }), true, 'not renamed: only its own name is blocked');
  assert.equal(announceable('', shown), false);
  assert.equal(announceable('A - B', null), false);
});

test('the favorite star and the category follow changes made anywhere', () => {
  let group = '';
  const groups = { groupOf: () => group, nameOf: (id) => (id === 'g2' ? 'Late' : '') };
  const h = harness({ item: radio(), playing: true, groups });
  const { fav, category } = h.view.parts;
  assert.equal(fav.getAttribute('aria-pressed'), 'false');
  assert.equal(fav.title, NOW_PLAYING_TEXT.addFavorite);
  fav.click();
  assert.equal(h.state.favorites.has(RADIO.id), true);
  assert.equal(fav.getAttribute('aria-pressed'), 'true');
  assert.equal(category.hidden, true);
  group = 'g2';
  h.bus.emit(FAVORITE_GROUPS_EVENT, {});
  assert.equal(category.textContent, 'Category: Late');
  h.state.favorites.delete(RADIO.id); // removed in the Library
  h.bus.emit('favorites-change');
  assert.equal(fav.getAttribute('aria-pressed'), 'false');
  assert.equal(category.hidden, true);
  h.view.destroy();
});

test('the playing time moves on once a minute, only while the media advances and the window is shown', () => {
  const h = harness({ item: radio(), playing: true });
  const ticks = () => [...h.timers].filter((timer) => timer.ms > 1500);
  assert.equal(ticks().length, 1);
  assert.equal(ticks()[0].ms, 60_050);
  const playingFor = () => h.view.parts.facts.children.at(-1).children[1].textContent;
  assert.equal(playingFor(), 'Under a minute');
  h.now = 60_100;
  const first = ticks()[0];
  h.timers.delete(first);
  first.fn();
  assert.equal(playingFor(), '1 min');
  assert.equal(ticks().length, 1, 'the next minute is waited for');
  // Hidden window: no timer; shown again: the line is right at once.
  h.setVisible(false);
  assert.equal(ticks().length, 0);
  h.now = 200_000;
  h.setVisible(true);
  assert.equal(playingFor(), '3 min');
  assert.equal(ticks().length, 1);
  // Buffering: still playing for the controls, but the clock and the timer stop.
  h.clock.advancingChanged(false, h.state.item);
  h.bus.emit(MEDIA_ADVANCING_EVENT, false);
  assert.equal(ticks().length, 0, 'no timer while buffering');
  h.now = 500_000;
  h.bus.emit('playing-change', true);
  assert.equal(playingFor(), '3 min', 'buffering adds nothing');
  assert.equal(ticks().length, 0);
  h.clock.advancingChanged(true, h.state.item);
  h.bus.emit(MEDIA_ADVANCING_EVENT, true);
  assert.equal(ticks().length, 1, 'sound again: the timer is back');
  assert.equal(ticks()[0].ms, msToNextMinute(200_000) + 50);
  // Paused: the line says so and nothing waits.
  h.state.playing = false;
  h.clock.advancingChanged(false, h.state.item);
  h.bus.emit(MEDIA_ADVANCING_EVENT, false);
  h.bus.emit('playing-change', false);
  assert.equal(playingFor(), '3 min (paused)');
  assert.equal(ticks().length, 0);
  // Stopped: back to the empty state, nothing running.
  h.state.item = null;
  h.clock.itemChanged(null);
  h.bus.emit('current-item', null);
  assert.equal(h.view.parts.empty.hidden, false);
  assert.equal(h.timers.size, 0);
  h.view.destroy();
});

test('the "Better stream" line is the Library\'s own, made once per item and again only when the setting changes', async () => {
  const made = [];
  const bestStream = (item, options) => {
    const line = { item, options, destroyed: false, node: new FakeEl('div') };
    line.destroy = () => { line.destroyed = true; };
    made.push(line);
    return line;
  };
  const h = harness({ item: radio(), playing: true, bestStream, settings: { bestStreamMode: 'listed' } });
  assert.equal(made.length, 1);
  assert.deepEqual(h.view.parts.bestHost.children, [made[0].node], 'under the stream details');
  // Its "Use the station's own stream" button removes itself: focus goes to the favorite star.
  assert.equal(made[0].options.focusAfterUse(), h.view.parts.fav);
  h.bus.emit('playing-change', true);
  h.bus.emit('media-relay', { available: true });
  h.bus.emit('settings-change', h.state.settings);
  assert.equal(made.length, 1, 'other events keep the same line');
  h.state.settings = { bestStreamMode: 'auto' };
  h.bus.emit('settings-change', h.state.settings);
  assert.equal(made.length, 2, 'Auto turned on: made again');
  assert.equal(made[0].destroyed, true);
  h.state.item = radio({ id: 'radio-browser:other', title: 'Other' });
  h.bus.emit('current-item', h.state.item);
  assert.equal(made.length, 3);
  assert.equal(made[1].destroyed, true);
  assert.equal(made[2].item.id, 'radio-browser:other');
  h.view.destroy();
  assert.equal(made[2].destroyed, true, 'its listeners go with the tab');
  // The real line (modes/library/other-streams.js) is what the tab uses.
  const source = await read('src/modes/now-playing.js');
  assert.match(source, /import \{ createBestStreamStatus \} from '\.\/library\/other-streams\.js';/);
  assert.match(source, /bestStream: \(item, options\) => createBestStreamStatus\(item, options\),/);
});

test('station pictures that change reload the picture only when it is a different one', async () => {
  const h = harness({ item: radio(), playing: true, custom: 'station-image:abc:1' });
  await settle();
  assert.equal(h.loads.length, 1);
  for (const fn of [...h.pictureListeners]) fn();
  await settle();
  assert.equal(h.loads.length, 1, 'the same picture: nothing reloads');
  h.state.custom = 'station-image:abc:2';
  for (const fn of [...h.pictureListeners]) fn();
  await settle();
  assert.equal(h.loads.length, 2);
  assert.equal(h.loads[1].source, 'station-image:abc:2');
  // Events that do not change the item never reload it.
  h.bus.emit('playing-change', true);
  h.bus.emit('media-relay', { available: true });
  await settle();
  assert.equal(h.loads.length, 2);
  h.view.destroy();
});

test('artwork that arrives late for the same item replaces the initials, and is loaded once', async () => {
  // The first lookup finds nothing (an audiobook before its stream resolves).
  const item = { id: 'librivox:book-1', title: 'A Book', source: 'librivox', type: 'audio', delivery: 'on-demand', thumbnail: '' };
  const h = harness({ item, playing: true });
  await settle();
  assert.equal(h.resolves.length, 1);
  assert.equal(h.loads.length, 0);
  assert.equal(h.view.root.classList.contains('has-picture'), false, 'the initials tile');
  // The same item gains its artwork; the player sends it again.
  item.thumbnail = '/api/v1/assets/late_artwork_0001';
  h.bus.emit('current-item', item);
  await settle();
  assert.deepEqual(h.loads.map((load) => load.source), ['/api/v1/assets/late_artwork_0001']);
  assert.equal(h.view.parts.artImg.getAttribute('src'), '/api/v1/assets/late_artwork_0001');
  assert.equal(h.view.root.classList.contains('has-picture'), true);
  h.bus.emit('current-item', item);
  h.bus.emit('playing-change', true);
  await settle();
  assert.equal(h.loads.length, 1, 'the same picture is not loaded again');
  h.view.destroy();
  // The lookup itself fills it in during the first load: keyed as loaded, so
  // the player sending the item again does not load it a second time.
  const filled = { ...item, id: 'librivox:book-2', thumbnail: '' };
  const g = harness({ item: filled, playing: true, resolveTo: '/api/v1/assets/late_artwork_0002' });
  await settle();
  assert.deepEqual(g.loads.map((load) => load.source), ['/api/v1/assets/late_artwork_0002']);
  g.bus.emit('current-item', filled);
  await settle();
  assert.equal(g.loads.length, 1);
  assert.equal(g.resolves.length, 1);
  g.view.destroy();
});

test('leaving the tab leaves nothing behind: no listener, timer, picture load or meter subscription', async () => {
  const h = harness({
    item: radio(), playing: true, title: 'A - B', custom: 'station-image:abc:1',
    clipboard: { writeText: async () => {} },
  });
  h.win.observers[0].fire(800, 200);
  h.view.parts.copyBtn.click();
  await settle();
  assert.ok(h.bus.count() > 0);
  assert.ok(h.signalSubs.size === 1);
  assert.ok(h.timers.size >= 1);
  assert.ok(h.docListenerCount() >= 1);
  assert.ok(h.starred.listeners.size >= 1);
  assert.ok(h.view.root.listenerTotal() > 0);
  // A picture load still on its way when the tab closes is stopped.
  let aborted = null;
  const slow = harness({
    item: radio(),
    playing: true,
    custom: 'station-image:slow:1',
    loadImage: (img, source, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => { aborted = source; reject(new DOMException('gone', 'AbortError')); });
    }),
  });
  assert.equal(slow.view.pictureLoading, true);
  slow.view.destroy();
  assert.equal(aborted, 'station-image:slow:1');
  assert.equal(slow.bus.count(), 0);

  h.view.destroy();
  assert.equal(h.view.destroyed, true);
  assert.equal(h.bus.count(), 0, `still subscribed: ${h.bus.events().join(', ')}`);
  assert.equal(h.signalSubs.size, 0, 'the meter is off the shared signal');
  assert.equal(h.timers.size, 0, 'no timer left');
  assert.equal(h.view.timerPending, false);
  assert.equal(h.docListenerCount(), 0);
  assert.equal(h.pictureListeners.size, 0);
  assert.equal(h.starred.listeners.size, 0);
  assert.equal(h.motion.listeners.size, 0, 'no reduced-motion listener');
  assert.ok(h.win.observers.every((observer) => observer.disconnected), 'the resize observer is gone');
  assert.equal(h.view.root.listenerTotal(), 0, 'no element listener');
  assert.equal(h.view.root.removed, true);
  h.view.destroy(); // twice is harmless
});

test('the large meter draws from the shared signal only while the window is shown, and never touches Web Audio', () => {
  const clock = createClockHarness();
  const analyser = fakeAnalyser({ level: 200 });
  let signal = null;
  const h = harness({
    item: radio(),
    playing: true,
    makeSignal: (doc) => {
      signal = createAudioSignal({
        source: {
          isPlaying: () => true,
          isAudible: () => true,
          getVolume: () => 1,
          getAnalyser: () => analyser,
          release() {},
          getSourceKey: () => 'k',
        },
        doc,
        ...clock.io,
      });
      return signal;
    },
  });
  h.win.observers[0].fire(800, 200);
  assert.equal(signal.subscriberCount, 1);
  clock.run(1000);
  const ctx = h.view.parts.canvas.ctx;
  assert.ok(ctx.draws > 1, `drawn while shown (${ctx.draws})`);
  assert.ok(h.view.meter.lit.some((count) => count > 0), 'the bars move with the sound');
  h.setVisible(false);
  clock.run(100);
  const draws = ctx.draws;
  const requests = clock.counts.frameRequests;
  clock.run(5000);
  assert.equal(ctx.draws, draws, 'nothing drawn while hidden');
  assert.equal(clock.counts.frameRequests, requests, 'no frame asked for while hidden');
  assert.equal(clock.pending(), 0, 'nothing scheduled');
  h.setVisible(true);
  clock.run(1000);
  assert.ok(ctx.draws > draws, 'drawn again once shown');
  h.view.destroy();
  assert.equal(signal.subscriberCount, 0);
  clock.run(1000);
  assert.equal(clock.pending(), 0, 'the signal stops with its last listener');
});

test('the tab\'s code never makes, resumes or reads Web Audio itself', async () => {
  const source = await read('src/modes/now-playing.js');
  assert.doesNotMatch(source, /AudioContext|createAnalyser|createMediaElementSource|\.resume\(|requestAnimationFrame|setInterval/);
  assert.match(source, /signal: getAudioSignal\(\),/);
});

test('reduced motion: the large meter rests and never subscribes, like the bar meter', () => {
  const h = harness({ item: radio(), playing: true });
  h.motion.set(true);
  h.win.observers[0].fire(800, 200);
  assert.equal(h.signalSubs.size, 0);
  h.motion.set(false);
  assert.equal(h.signalSubs.size, 1);
  h.view.destroy();
  assert.equal(h.signalSubs.size, 0);
});

test('the tab tears itself down when another tab opens', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const previousDocument = globalThis.document;
  const doc = {
    createElement: (tag) => new FakeEl(tag),
    addEventListener() {}, removeEventListener() {},
    visibilityState: 'visible',
  };
  globalThis.document = doc;
  try {
    const state = await import('../src/lib/state.js');
    state.setMode(NOW_PLAYING_MODE);
    const host = new FakeEl('main');
    renderNowPlaying(host);
    assert.equal(nowPlayingMounted(), true);
    assert.equal(host.children.length, 1);
    assert.equal(host.children[0].dataset.state, 'empty', 'nothing plays in a test');
    state.setMode('tuner');
    assert.equal(nowPlayingMounted(), false);
    assert.equal(host.children[0].removed, true);
    // Opened again while open: the old one goes first.
    state.setMode(NOW_PLAYING_MODE);
    const first = new FakeEl('main');
    renderNowPlaying(first);
    renderNowPlaying(new FakeEl('main'));
    assert.equal(first.children[0].removed, true);
    state.setMode('library');
    assert.equal(nowPlayingMounted(), false);
  } finally {
    globalThis.document = previousDocument;
  }
});

/* ---------------- Registration, layout and readability ---------------- */

test('the tab sits after Discovery and before Visualizer, with its own styles, and the play clock starts with the player', async () => {
  const html = await read('src/index.html');
  assert.match(html, /data-mode="discovery">Discovery<\/button>\s+<button class="mode-btn" data-mode="now-playing">Now Playing<\/button>\s+<button class="mode-btn" data-mode="visualizer">/);
  assert.match(html, /<link rel="stylesheet" href="\.\/styles\/now-playing\.css" \/>/);
  const main = await read('src/main.js');
  assert.match(main, /import \{ renderNowPlaying \} from '\.\/modes\/now-playing\.js';/);
  assert.match(main, /'now-playing': renderNowPlaying,/);
  assert.match(main, /initPlayer\(\);[\s\S]{0,300}playClock\.start\(subscribe, getCurrentItem,/);
  assert.equal(NOW_PLAYING_MODE, 'now-playing');
  // No new setting: the start-up tab list is unchanged.
  const state = await read('src/lib/state.js');
  assert.match(state, /defaultMode: \['library', 'tuner', 'grid', 'discovery', 'about'\]\.includes/);
});

test('nothing in the tab\'s styles moves, and the backdrop is a still CSS blur', async () => {
  const css = await read('src/styles/now-playing.css');
  assert.doesNotMatch(css, /@keyframes|animation|transition/);
  assert.match(css, /\.np-backdrop-img \{[^}]*filter: blur\(/);
  // The picture and the text scale with the room, within limits.
  assert.match(css, /\.np-root \{[^}]*container: np \/ size;/);
  assert.match(css, /\.np-art \{[^}]*width: clamp\(150px, min\(42cqw, 68cqh\), 1280px\);/);
  assert.match(css, /\.np-title \{[^}]*font-size: clamp\(22px, [\d.]+cqmin, 88px\);/);
  assert.match(css, /#app\.has-video \.np-layout \{ padding-bottom: calc\(var\(--video-clearance\)/);
});

/** The rules of a style sheet as { media, selectors, decls } (one level of @media). */
function cssRules(text) {
  const rules = [];
  const source = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const walk = (body, media) => {
    let at = 0;
    while (at < body.length) {
      const open = body.indexOf('{', at);
      if (open < 0) break;
      const head = body.slice(at, open).trim();
      if (head.startsWith('@')) {
        let depth = 1;
        let end = open + 1;
        while (depth && end < body.length) {
          if (body[end] === '{') depth += 1;
          else if (body[end] === '}') depth -= 1;
          end += 1;
        }
        walk(body.slice(open + 1, end - 1), head);
        at = end;
        continue;
      }
      const close = body.indexOf('}', open);
      const decls = new Map();
      for (const part of body.slice(open + 1, close).split(';')) {
        const colon = part.indexOf(':');
        if (colon > 0) decls.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim());
      }
      rules.push({ media, selectors: head.split(',').map((s) => s.trim()), decls });
      at = close + 1;
    }
  };
  walk(source, '');
  return rules;
}

test('the top bar: a tab name never wraps, and from 980 px the seven tabs fit or scroll, with the sleep timer counting down', async () => {
  const sheets = await Promise.all(['base', 'now-playing', 'library', 'tuner', 'grid', 'discovery', 'visualizer']
    .map((name) => read(`src/styles/${name}.css`).catch(() => '')));
  const rules = sheets.flatMap(cssRules);
  const targetsTab = (selector) => /\.mode-btn(?![\w-])[^\s>+~]*$/.test(selector);
  const tabRules = rules.filter((rule) => rule.selectors.some(targetsTab));
  assert.ok(tabRules.length >= 3);
  // No rule anywhere lets a tab's name wrap.
  for (const rule of tabRules) {
    const value = rule.decls.get('white-space');
    if (value !== undefined) assert.ok(['nowrap', 'pre'].includes(value), `${rule.selectors} ${rule.media}: white-space ${value}`);
    assert.equal(rule.decls.has('word-break') || rule.decls.has('overflow-wrap'), false);
  }
  const plain = tabRules.find((rule) => !rule.media && rule.selectors.includes('.mode-btn'));
  assert.equal(plain.decls.get('white-space'), 'nowrap', 'at every width');

  // 1001 to 1240 px: one row. The tabs are held to their column (max-width)
  // and scroll there, so they never run under the tools.
  const ONE_ROW = '@media (min-width: 1001px) and (max-width: 1240px)';
  const inOneRow = (selector) => rules.find((rule) => rule.media === ONE_ROW && rule.selectors.includes(selector));
  const modes = inOneRow('.modes');
  assert.equal(modes.decls.get('min-width'), '0');
  assert.equal(modes.decls.get('max-width'), '100%');
  assert.equal(modes.decls.get('overflow-x'), 'auto');
  // Every tab stays a plain button in the row: the keyboard reaches each one
  // (Tab), and the browser scrolls a focused one into view.
  const html = await read('src/index.html');
  const nav = html.slice(html.indexOf('<nav class="modes"'), html.indexOf('</nav>'));
  const buttons = [...nav.matchAll(/<button class="mode-btn(?: is-active)?" data-mode="([\w-]+)"(?: aria-current="page")?>([^<]+)<\/button>/g)];
  assert.equal(buttons.length, 7);
  assert.doesNotMatch(nav, /tabindex="-1"|disabled|hidden/);

  // The arithmetic at 1001 px with "Sleep 720:00" showing (the longest the
  // countdown gets). Text widths are Segoe UI at the bar's sizes, rounded up.
  const px = (value) => value.split(/\s+/).map((part) => Number.parseFloat(part));
  const LABEL = { Library: 39, Tuner: 33, Grid: 24.5, Discovery: 55.5, 'Now Playing': 72, Visualizer: 54.5, About: 35.5 };
  const BRAND = 22 + 10 + 83; // the glyph, the gap and "World Media"
  const TOOLS = 365; // the sleep timer with "Sleep 720:00", Song log, Settings and Shutdown
  const bar = inOneRow('.topbar');
  const barPad = px(bar.decls.get('padding'))[1];
  const barGap = px(bar.decls.get('gap'))[0];
  const tabPad = px(inOneRow('.mode-btn').decls.get('padding'))[1];
  const plainModes = rules.find((rule) => !rule.media && rule.selectors.includes('.modes'));
  const modesGap = px(plainModes.decls.get('gap'))[0];
  const modesPad = px(plainModes.decls.get('padding'))[0];
  const labels = buttons.map(([, , name]) => {
    assert.ok(LABEL[name], `a width for "${name}"`);
    return LABEL[name];
  });
  const tabsWidth = labels.reduce((sum, w) => sum + w + 2 * tabPad, 0) + modesGap * (labels.length - 1) + 2 * modesPad + 2;
  const need = 2 * barPad + 2 * barGap + BRAND + tabsWidth + TOOLS;
  assert.ok(need <= 1001 - 8, `one row needs ${need} px at 1001 px`);
  // Up to 1000 px (the window is at least 980 px wide): two rows, the tabs alone on theirs.
  const twoRow = rules.filter((rule) => rule.media === '@media (max-width: 1000px)');
  const twoRowTab = twoRow.find((rule) => rule.selectors.includes('.mode-btn'));
  const minWidth = Number.parseFloat(twoRowTab.decls.get('min-width'));
  const twoPad = px(twoRowTab.decls.get('padding'))[1];
  const rowWidth = labels.reduce((sum, w) => sum + Math.max(minWidth, w + 2 * twoPad), 0) + modesGap * 6 + 2 * modesPad + 2;
  const sidePad = px(twoRow.find((rule) => rule.selectors.includes('.topbar')).decls.get('padding'))[1];
  assert.ok(rowWidth <= 980 - 2 * sidePad, `the tab row needs ${rowWidth} px at 980 px`);
  assert.equal(twoRow.find((rule) => rule.selectors.includes('.modes')).decls.get('overflow-x'), 'auto');
});

/* Contrast as WCAG works it out; layers are blended in sRGB, as browsers do. */
const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const hexColor = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
const over = (top, alpha, under) => under.map((c, index) => top[index] * alpha + c * (1 - alpha));

function themeBlock(css, selector) {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) return '';
  return css.slice(at, css.indexOf('}', at));
}
function themeVar(css, theme, name) {
  const own = themeBlock(css, theme === 'dark' ? ':root' : `:root[data-theme='${theme}']`);
  const match = own.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))
    || themeBlock(css, ':root').match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  return hexColor(match[1]);
}

test('text over the blurred picture reads at 4.5:1 or better in every theme, 7:1 for dark text on a light theme, over any picture', async () => {
  const base = await read('src/styles/base.css');
  const css = await read('src/styles/now-playing.css');
  const scrim = css.match(/\.np-scrim \{[^}]*background: color-mix\(in srgb, var\(--bg\) (\d+)%, transparent\);/);
  assert.ok(scrim, 'the scrim is the theme background over the picture');
  const alpha = Number(scrim[1]) / 100;
  // The text uses only the theme's main text colour and the tab's dim one.
  const textColors = new Set(css.match(/color: var\(--[a-z-]+\)/g).map((rule) => rule.slice(11, -1)));
  for (const name of textColors) assert.ok(['--text', '--np-dim', '--np-accent'].includes(name), name);
  assert.match(css, /\.np-root \{[^}]*--np-dim: var\(--text-dim\);/);
  // Light themes: a deeper grey for the small texts, set for the chosen and
  // for the system's light theme alike.
  const lightDim = [...css.matchAll(/\.np-root \{ --np-accent: var\(--accent-strong\); --np-dim: (#[0-9a-f]{6}); \}/g)]
    .map((match) => match[1]);
  assert.equal(lightDim.length, 2);
  assert.equal(lightDim[0], lightDim[1]);
  const themes = ['dark', 'light', 'midnight', 'forest', 'ember', 'amethyst'];
  for (const theme of themes) {
    const bg = themeVar(base, theme, '--bg');
    const text = themeVar(base, theme, '--text');
    const dim = theme === 'light' ? hexColor(lightDim[0]) : themeVar(base, theme, '--text-dim');
    // Thin dark letters on a light ground are drawn lighter than their colour
    // (the small grey texts measured 3.3 to 3.9:1 in the app window at a
    // computed 4.9 to 5.3:1), so dark text on a light theme keeps 7:1.
    const darkOnLight = luminance(text) < luminance(bg);
    const needed = darkOnLight ? 7 : 4.5;
    for (const picture of [[1, 1, 1], [0, 0, 0], [0.5, 0.5, 0.5], [0, 0, 1], [1, 0, 0], [0, 0.5, 0]]) {
      const back = over(bg, alpha, picture);
      for (const [name, color] of [['--text', text], ['dim', dim]]) {
        const ratio = contrast(color, back);
        assert.ok(ratio >= needed, `${theme} ${name} over ${picture}: ${ratio.toFixed(2)}:1`);
      }
    }
  }
});

test('new files are ASCII with Windows line ends', async () => {
  for (const path of ['src/modes/now-playing.js', 'src/lib/play-clock.js', 'src/styles/now-playing.css', 'tests/now-playing-tab.test.js']) {
    const text = await read(path);
    assert.ok(/^[\x00-\x7f]*$/.test(text), `${path} is ASCII`);
    assert.ok(!/[^\r]\n/.test(text), `${path} has CRLF line ends`);
  }
});
