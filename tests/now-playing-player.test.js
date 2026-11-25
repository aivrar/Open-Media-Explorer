import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeElement, createPlayerDom } from './helpers/fake-dom.js';
import { addFavorite, emit, getState, subscribe } from '../src/lib/state.js';
import { saveStationStreams } from '../src/lib/station-stream-edit.js';
import { didNotPlayAt, markDidNotPlay } from '../src/lib/did-not-play.js';
import { forgetLoadedPlayedStreams, playedStreamOf, stationStreamLabel } from '../src/lib/played-streams.js';
import Hls from '../src/vendor/hls.js';
import { loadDashLibrary, resetDashLibraryForTests } from '../src/lib/dash-player.js';
import { FAVORITE_NAMES_KEY } from '../src/lib/favorite-names.js';
import { resetControlSession } from '../src/lib/capture-client.js';
import { RECONNECTING_TEXT } from '../src/lib/live-resume.js';
import { NOW_PLAYING_EVENT, NOW_PLAYING_FIRST_POLL_MS, NOW_PLAYING_POLL_MS } from '../src/lib/now-playing.js';
import { MEDIA_ADVANCING_EVENT, createPlayClock } from '../src/lib/play-clock.js';

const TEST_TIMEOUT_MS = 20_000;
const NOTE = '\u266A';

const settle = async (rounds = 40) => {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
};

class MemoryStorage {
  constructor() { this.data = new Map(); }
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
  setItem(key, value) { this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
}

class FakeMediaMetadata {
  constructor(init = {}) { Object.assign(this, init); }
}

const envelope = (status, data, error = null) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => ({ ok: !error, data, error }),
});

const mediaId = (index) => `song_media_${String(index).padStart(12, '0')}`;

function liveItem(id, overrides = {}) {
  return {
    id: `test-song:${id}`, title: `Station ${id}`, description: '', source: 'radio-browser',
    type: 'radio', stream_kind: 'audio', stream_url: `https://radio.example/${id}`,
    delivery: 'live', capture_headers: {}, thumbnail: '/api/v1/assets/test_artwork_0001',
    country: '', language: '',
    _extra: { streamCandidates: [] },
    ...overrides,
  };
}

async function setup(t) {
  t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const previous = {
    document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch,
    sessionStorage: Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'),
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    MediaMetadata: Object.getOwnPropertyDescriptor(globalThis, 'MediaMetadata'),
  };
  const { elements, document } = createPlayerDom();
  elements['player-art-initials'] = document.register(new FakeElement('player-art-initials'));
  const net = { registrations: 0, titles: new Map(), polls: [], held: [], hold: false, media: [], refuseUrl: '' };
  const mediaSession = {
    playbackState: 'none', metadata: 'metadata-before-song', setActionHandler() {},
  };
  globalThis.document = document;
  globalThis.window = new EventTarget();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: new MemoryStorage() });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaSession } });
  Object.defineProperty(globalThis, 'MediaMetadata', { configurable: true, writable: true, value: FakeMediaMetadata });
  globalThis.fetch = async (path, options = {}) => {
    if (path === '/api/v1/session') return envelope(200, { token: 'song-token' });
    if (path === '/api/v1/media/register') {
      net.registrations++;
      const media = JSON.parse(options.body);
      net.media.push(media);
      if (media.url === net.refuseUrl) return envelope(502, null, { code: 'MEDIA_CONNECT_FAILED' });
      const id = mediaId(net.registrations);
      return envelope(201, { media_id: id, relay_url: `/api/v1/media/${id}` });
    }
    if (String(path).endsWith('/expire')) return envelope(200, { expired: true });
    const match = String(path).match(/^\/api\/v1\/media\/([A-Za-z0-9_-]+)\/now-playing$/);
    if (match) {
      assert.equal(options.method, 'GET');
      assert.equal(options.headers['X-WorldMedia-Token'], 'song-token');
      net.polls.push(match[1]);
      const answer = () => envelope(200, net.titles.get(match[1]) || { title: null, changed_at: null });
      if (net.hold) return new Promise((resolve) => net.held.push({ id: match[1], resolve: () => resolve(answer()) }));
      return answer();
    }
    if (options.headers?.Range) {
      if (net.media.at(-1)?.media_type === 'hls') {
        return new Response('#EXTM3U\n#EXT-X-ENDLIST\n', { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
      }
      return new Response(null, { status: 206 });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  resetControlSession();
  const events = [];
  const unsubscribe = subscribe(NOW_PLAYING_EVENT, (payload) => events.push(payload));
  let player = null;
  t.after(() => {
    unsubscribe();
    try { player?.stop(); } catch (_) {}
    while (net.held.length) net.held.shift().resolve();
    resetControlSession();
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    globalThis.fetch = previous.fetch;
    for (const name of ['sessionStorage', 'navigator', 'MediaMetadata']) {
      if (previous[name]) Object.defineProperty(globalThis, name, previous[name]);
      else delete globalThis[name];
    }
  });
  player = await import(`../src/lib/player.js?nowPlaying=${Date.now()}-${Math.random()}`);
  player.initPlayer();
  await settle();
  const audio = elements['audio-el'];
  const source = elements['player-source'];
  const tick = async (ms) => { t.mock.timers.tick(ms); await settle(); };
  const progress = (seconds = 1.5) => {
    for (let moved = 0; moved < seconds; moved += 0.5) {
      audio.currentTime += 0.5;
      audio.emit('timeupdate');
    }
  };
  return { player, elements, audio, source, net, mediaSession, events, tick, progress };
}

test('saved backups take over after connection and player failures with best-stream off', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const { settings, favorites } = getState();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() });
  getState().settings = { ...settings, bestStreamMode: 'off' };
  getState().favorites = [];
  t.after(() => {
    if (storage) Object.defineProperty(globalThis, 'localStorage', storage);
    else delete globalThis.localStorage;
    getState().settings = settings;
    getState().favorites = favorites;
  });
  const { player, net, audio, tick, progress } = await setup(t);
  const original = liveItem('edited', { stream_url: 'https://radio.example/original.m3u8', stream_kind: 'hls' });
  const main = 'https://radio.example/new.aac';
  const backups = ['https://radio.example/backup1.aac', 'https://radio.example/backup2.aac'];
  addFavorite(original);
  const request = async () => {};
  await saveStationStreams(original, { main, backups }, { request });
  net.refuseUrl = main;
  const play = audio.play.bind(audio);
  audio.play = async () => {
    if (audio.src.endsWith(mediaId(2))) throw new Error('Unsupported audio');
    return play();
  };
  await player.playItem(original);
  await settle();
  assert.deepEqual(net.media.map(({ url, media_type }) => [url, media_type]),
    [main, ...backups].map((url) => [url, 'audio']));
  assert.equal(audio.src, `/api/v1/media/${mediaId(3)}`);
  assert.equal(player.getCurrentItem().stream_url, original.stream_url);
  net.titles.set(mediaId(3), { title: 'Backup signal', stream: { content_type: 'audio/aac', bitrate: 96 } });
  await tick(NOW_PLAYING_FIRST_POLL_MS);
  progress();
  assert.equal(player.getNowPlaying().title, 'Backup signal');
  assert.match(stationStreamLabel(original), /AAC.*96 kbps/);

  markDidNotPlay(original.id);
  const changed = 'https://radio.example/changed.mp3';
  await saveStationStreams(original, { main: changed, backups: [] }, { request });
  assert.equal(didNotPlayAt(original.id), 0);
  assert.equal(stationStreamLabel(original), '');
  await tick(NOW_PLAYING_POLL_MS);
  assert.equal(stationStreamLabel(original), '');
  await player.togglePlay();
  await player.togglePlay();
  assert.equal(net.media.at(-1).url, changed, 'Play from Now Playing starts with the edited address');
});

test('a playing station shows its song with the source line on hover, and Stop ends it', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, source, net, mediaSession, events, tick } = await setup(t);
  await player.playItem(liveItem('a'));
  await settle();
  const normalLine = source.textContent;
  assert.ok(normalLine, 'the normal source line');
  assert.equal(source.title, '');

  net.titles.set(mediaId(1), { title: 'Artist - Song', changed_at: 1_700_000_000 });
  await tick(NOW_PLAYING_FIRST_POLL_MS);
  assert.deepEqual(net.polls, [mediaId(1)]);
  assert.equal(source.textContent, `${NOTE} Artist - Song`);
  assert.equal(source.title, `${NOTE} Artist - Song\n${normalLine}`);
  assert.ok(mediaSession.metadata instanceof FakeMediaMetadata);
  assert.equal(mediaSession.metadata.title, 'Artist - Song');
  assert.equal(mediaSession.metadata.artist, 'Station a');
  assert.deepEqual(events, [{
    itemId: 'test-song:a', mediaId: mediaId(1), title: 'Artist - Song', changedAt: 1_700_000_000_000,
  }]);
  assert.deepEqual(player.getNowPlaying(), events[0]);

  await tick(NOW_PLAYING_POLL_MS);
  assert.equal(net.polls.length, 2);
  assert.equal(events.length, 1, 'no event without a change');

  // The station stops announcing: the meta line is exactly as before.
  net.titles.set(mediaId(1), { title: null, changed_at: null });
  await tick(NOW_PLAYING_POLL_MS);
  assert.equal(source.textContent, normalLine);
  assert.equal(source.title, '');
  assert.equal(mediaSession.metadata, 'metadata-before-song');
  assert.equal(events.at(-1).title, null);

  net.titles.set(mediaId(1), { title: 'Second', changed_at: 1_700_000_100 });
  await tick(NOW_PLAYING_POLL_MS);
  assert.equal(source.textContent, `${NOTE} Second`);
  player.stop();
  assert.equal(mediaSession.metadata, 'metadata-before-song');
  assert.equal(events.at(-1).title, null);
  assert.equal(player.getNowPlaying(), null);
  const polls = net.polls.length;
  await tick(60_000);
  assert.equal(net.polls.length, polls, 'no polling after Stop');
});

test('pause stops polling and clears the song; Play brings it back', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, audio, source, net, tick } = await setup(t);
  await player.playItem(liveItem('p'));
  await settle();
  const normalLine = source.textContent;
  net.titles.set(mediaId(1), { title: 'Paused Song', changed_at: 5 });
  await tick(NOW_PLAYING_FIRST_POLL_MS);
  assert.equal(source.textContent, `${NOTE} Paused Song`);

  await player.togglePlay();
  assert.equal(audio.paused, true);
  assert.equal(source.textContent, normalLine);
  const polls = net.polls.length;
  await tick(30_000);
  assert.equal(net.polls.length, polls);

  await player.togglePlay();
  await settle();
  assert.equal(audio.paused, false);
  await tick(NOW_PLAYING_FIRST_POLL_MS);
  assert.equal(net.polls.length, polls + 1);
  assert.equal(source.textContent, `${NOTE} Paused Song`);
  player.stop();
});

test('the dock reports its rendered height and clears its visible state for audio', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const previousObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  let observeResize;
  let watched;
  let boxOptions;
  globalThis.ResizeObserver = class {
    constructor(callback) { observeResize = callback; }
    observe(element, options) {
      watched = element;
      boxOptions = options;
    }
  };
  t.after(() => {
    if (previousObserver) Object.defineProperty(globalThis, 'ResizeObserver', previousObserver);
    else delete globalThis.ResizeObserver;
  });

  const { player, elements } = await setup(t);
  const cssValues = new Map();
  elements.app.style.setProperty = (name, value) => cssValues.set(name, value);
  assert.equal(watched, elements['video-el']);
  assert.deepEqual(boxOptions, { box: 'border-box' });

  await player.playItem(liveItem('dock', { type: 'tv', stream_kind: 'video', stream_url: 'https://tv.example/dock.mp4' }));
  assert.ok(elements.app.classList.contains('has-video'));
  for (const blockSize of [180.5, 270.875, 224]) {
    observeResize([{ borderBoxSize: [{ blockSize }] }]);
    assert.equal(cssValues.get('--video-height'), `${blockSize}px`);
  }
  await player.playItem(liveItem('dock-audio'));
  assert.equal(elements['video-el'].hidden, true);
  assert.equal(elements.app.classList.contains('has-video'), false);
});

test('audio-only HLS listed as TV keeps the dock and waits before saving a new rendition', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, elements, net, tick } = await setup(t);
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() });
  forgetLoadedPlayedStreams();
  t.after(() => {
    if (storage) Object.defineProperty(globalThis, 'localStorage', storage);
    else delete globalThis.localStorage;
    forgetLoadedPlayedStreams();
  });

  let hls;
  const levels = [
    { audioCodec: 'mp4a.40.2', attrs: { BANDWIDTH: '128000' } },
    { audioCodec: 'mp4a.40.5', attrs: { BANDWIDTH: '64000' } },
  ];
  t.mock.method(Hls, 'isSupported', () => true);
  t.mock.method(Hls.prototype, 'loadSource', function () { hls = this; });
  t.mock.method(Hls.prototype, 'attachMedia', () => {});
  t.mock.getter(Hls.prototype, 'levels', () => levels);
  const video = elements['video-el'];
  video.buffered = { length: 1, start: () => 0, end: () => 20 };

  const station = liveItem('hls', { type: 'tv', stream_url: 'https://radio.example/live.m3u8', stream_kind: 'hls' });
  await player.playItem(station);
  assert.ok(hls, 'the HLS engine was attached');
  assert.equal(video.hidden, false, 'the TV listing supplies the startup hint');
  hls.emit(Hls.Events.LEVEL_SWITCHED, Hls.Events.LEVEL_SWITCHED, { level: 1 });
  video.emit('loadedmetadata');
  assert.equal(video.hidden, false, 'zero-size metadata leaves the TV dock visible');
  assert.equal(elements.app.classList.contains('has-video'), true);
  assert.equal(playedStreamOf(station.id), null, 'the start has not played a second');
  for (const time of [0.5, 1]) {
    video.currentTime = time;
    video.emit('timeupdate');
  }
  assert.equal(stationStreamLabel(station), 'HLS \u00B7 AAC+ \u00B7 64 kbps');
  for (let index = 0; index < 6; index += 1) {
    hls.emit(Hls.Events.LEVEL_SWITCHED, Hls.Events.LEVEL_SWITCHED, { level: index % 2 });
    video.currentTime += 1;
    video.emit('timeupdate');
    assert.equal(stationStreamLabel(station), 'HLS \u00B7 AAC+ \u00B7 64 kbps');
  }
  hls.emit(Hls.Events.LEVEL_SWITCHED, Hls.Events.LEVEL_SWITCHED, { level: 0 });
  for (let index = 0; index < 5; index += 1) {
    await tick(1000);
    video.currentTime += 1;
    video.emit('timeupdate');
  }
  assert.equal(stationStreamLabel(station), 'HLS \u00B7 AAC \u00B7 128 kbps');
  assert.equal(video.hidden, false, 'the TV dock stays visible during audio-only playback');
  await tick(NOW_PLAYING_FIRST_POLL_MS);
  assert.deepEqual(net.polls, []);
});

test('TV video facts use the playing element size and active HLS level', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, elements, tick } = await setup(t);
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() });
  forgetLoadedPlayedStreams();
  t.after(() => {
    if (storage) Object.defineProperty(globalThis, 'localStorage', storage);
    else delete globalThis.localStorage;
    forgetLoadedPlayedStreams();
  });
  let hls;
  t.mock.method(Hls, 'isSupported', () => true);
  t.mock.method(Hls.prototype, 'loadSource', function () { hls = this; });
  t.mock.method(Hls.prototype, 'attachMedia', () => {});
  t.mock.getter(Hls.prototype, 'levels', () => [
    { width: 1280, height: 720, videoCodec: 'avc1.4d401f', attrs: { BANDWIDTH: '4200000', 'FRAME-RATE': '30' } },
  ]);
  const video = elements['video-el'];
  video.buffered = { length: 1, start: () => 0, end: () => 20 };
  const station = liveItem('tv-video-facts', {
    type: 'tv', stream_url: 'https://tv.example/live.m3u8', stream_kind: 'hls',
  });
  await player.playItem(station);
  hls.emit(Hls.Events.LEVEL_SWITCHED, Hls.Events.LEVEL_SWITCHED, { level: 0 });
  const advance = async (seconds) => {
    for (let second = 0; second < seconds; second++) {
      await tick(1000);
      video.currentTime += 1;
      video.emit('timeupdate');
    }
  };
  await advance(6);
  assert.equal(playedStreamOf(station.id), null);
  video.videoWidth = 1920;
  video.videoHeight = 1080;
  video.emit('resize');
  await advance(5);
  assert.equal(playedStreamOf(station.id), null);
  await advance(1);
  assert.equal(stationStreamLabel(station), ['HLS', '1080p', '30 fps', 'H.264', '4.2 Mbps'].join(' \u00b7 '));
});

test('DASH saves the rendered codec and frame rate after five stable seconds', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, elements, tick } = await setup(t);
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() });
  forgetLoadedPlayedStreams();
  t.after(() => {
    resetDashLibraryForTests();
    if (storage) Object.defineProperty(globalThis, 'localStorage', storage);
    else delete globalThis.localStorage;
    forgetLoadedPlayedStreams();
  });
  let downloading = { codecs: 'avc1.4d401f', frameRate: '30' };
  const events = new Map();
  const dash = {
    on: (name, handler) => events.set(name, handler),
    off: (name) => events.delete(name),
    initialize() {},
    isDynamic: () => true,
    getCurrentRepresentationForType: (type) => type === 'video' ? downloading : null,
  };
  await loadDashLibrary({ importer: async () => ({ MediaPlayer: () => ({ create: () => dash }) }) });
  const video = elements['video-el'];
  video.buffered = { length: 1, start: () => 0, end: () => 20 };
  const station = liveItem('dash-facts', {
    type: 'tv', stream_url: 'https://tv.example/live.mpd', stream_kind: 'dash',
  });
  await player.playItem(station);
  video.videoWidth = 1920;
  video.videoHeight = 1080;
  video.emit('loadedmetadata');
  const advance = async (seconds) => {
    for (let second = 0; second < seconds; second++) {
      await tick(1000);
      video.currentTime += 1;
      video.emit('timeupdate');
    }
  };
  const rendered = events.get('qualityChangeRendered');
  rendered({ mediaType: 'video', newRepresentation: downloading });
  await advance(4);
  downloading = { codecs: 'hvc1.1.6', frameRate: '60000/1001' };
  await advance(5);
  const originalFacts = { codec: '', bitrate: 0, width: 1920, height: 1080, videoCodec: 'H.264', frameRate: 30 };
  assert.deepEqual(playedStreamOf(station.id, station.stream_url), originalFacts);

  rendered({ mediaType: 'video', newRepresentation: downloading });
  await advance(5);
  assert.deepEqual(playedStreamOf(station.id, station.stream_url), originalFacts);
  await advance(1);
  forgetLoadedPlayedStreams();
  assert.deepEqual(playedStreamOf(station.id, station.stream_url),
    { ...originalFacts, videoCodec: 'HEVC', frameRate: 59.94 });
});

test('switching stations follows the new token and a late reply for the old one is ignored', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, source, net, events, tick } = await setup(t);
  await player.playItem(liveItem('old'));
  await settle();
  net.titles.set(mediaId(1), { title: 'Old Song', changed_at: 1 });
  net.hold = true;
  await tick(NOW_PLAYING_FIRST_POLL_MS);
  assert.equal(net.held.length, 1);

  await player.playItem(liveItem('new'));
  await settle();
  const newLine = source.textContent;
  net.held.shift().resolve();
  await settle();
  assert.equal(source.textContent, newLine);
  assert.deepEqual(events, []);

  net.hold = false;
  net.titles.set(mediaId(2), { title: 'New Song', changed_at: 2 });
  await tick(NOW_PLAYING_FIRST_POLL_MS);
  assert.deepEqual(net.polls, [mediaId(1), mediaId(2)]);
  assert.equal(source.textContent, `${NOTE} New Song`);
  assert.deepEqual(events.map((event) => [event.itemId, event.title]), [['test-song:new', 'New Song']]);
  player.stop();
});

test('a muted station switch clears advancing before the next station is published', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, audio } = await setup(t);
  await player.playItem(liveItem('first-muted'));
  player.setMuted(true);
  assert.equal(player.isMediaAdvancing(), true);
  assert.equal(player.isPlayerSilent(), true);

  const next = liveItem('next-muted');
  const published = [];
  const unsubscribe = subscribe('current-item', (item) => {
    if (item?.id === next.id) published.push(player.isMediaAdvancing());
  });
  t.after(unsubscribe);
  audio.autoEvents = false;
  const starting = player.playItem(next);
  assert.deepEqual(published, [false], 'the first publication cannot inherit the old playback state');
  await starting;
  audio.emit('play');
  assert.equal(player.isMediaAdvancing(), false, 'the new source is still loading');
  audio.emit('playing');
  assert.equal(player.isMediaAdvancing(), true);
  assert.equal(player.isPlayerSilent(), true);
});

test('a switch, Play or Stop drops the song before any await, so a pending poll cannot leak', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, source, net, mediaSession, events, tick } = await setup(t);
  for (const action of ['switch', 'replay', 'stop']) {
    await player.playItem(liveItem(`${action}-old`));
    await settle();
    const oldId = mediaId(net.registrations);
    net.titles.set(oldId, { title: `Old ${action}`, changed_at: 1 });
    await tick(NOW_PLAYING_FIRST_POLL_MS);
    assert.equal(mediaSession.metadata.title, `Old ${action}`);
    net.titles.set(oldId, { title: `Late ${action}`, changed_at: 2 });
    net.hold = true;
    await tick(NOW_PLAYING_POLL_MS);
    assert.equal(net.held.length, 1, 'a poll for the old station is on its way');
    const eventsBefore = events.length;

    // Not awaited: everything below must already hold synchronously.
    const pending = action === 'switch' ? player.playItem(liveItem(`${action}-new`))
      : action === 'replay' ? player.playItem(liveItem(`${action}-old`))
        : (player.stop(), Promise.resolve());
    assert.equal(player.getNowPlaying(), null);
    assert.equal(mediaSession.metadata, 'metadata-before-song');
    assert.equal(source.textContent.startsWith(NOTE), false);
    assert.equal(events.at(-1).title, null);

    net.held.shift().resolve(); // the old reply arrives while the new start is still awaiting
    await pending;
    await settle();
    net.hold = false;
    assert.equal(mediaSession.metadata, 'metadata-before-song');
    assert.equal(source.textContent.includes('Late'), false);
    assert.equal(events.slice(eventsBefore).some((event) => event.title), false);
  }
});

test('a reconnect status takes priority, polling waits, and the song returns on the new token', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, audio, source, net, tick, progress } = await setup(t);
  await player.playItem(liveItem('r'));
  await settle();
  progress();
  net.titles.set(mediaId(1), { title: 'Before Drop', changed_at: 1 });
  await tick(NOW_PLAYING_FIRST_POLL_MS);
  assert.equal(source.textContent, `${NOTE} Before Drop`);

  audio.emit('error');
  await settle();
  assert.equal(source.textContent, RECONNECTING_TEXT, 'the status, not the song');
  assert.equal(source.title, RECONNECTING_TEXT);
  const polls = net.polls.length;
  net.titles.set(mediaId(2), { title: 'After Reconnect', changed_at: 2 });
  await tick(1_999);
  assert.equal(net.polls.length, polls, 'no polling while waiting to reconnect');
  await tick(1); // the reconnect attempt: a new registration and relay token
  assert.equal(net.registrations, 2);
  assert.notEqual(source.textContent, RECONNECTING_TEXT);
  progress();
  await tick(NOW_PLAYING_FIRST_POLL_MS);
  assert.deepEqual(net.polls.slice(polls), [mediaId(2)]);
  assert.equal(source.textContent, `${NOTE} After Reconnect`);
  player.stop();
});

test('errors stop polling, and on-demand or video items are never polled', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, audio, source, net, tick } = await setup(t);
  await player.playItem(liveItem('dead'));
  await settle();
  audio.emit('error'); // never played: the plain broken state
  await settle();
  assert.equal(source.textContent, 'Playback error');
  await tick(30_000);
  assert.deepEqual(net.polls, []);

  await player.playItem(liveItem('vod', { delivery: 'on-demand', stream_url: 'https://media.example/show.mp3' }));
  await settle();
  await tick(30_000);
  await player.playItem(liveItem('tv', { type: 'tv', stream_kind: 'video', stream_url: 'https://tv.example/live.mp4' }));
  await settle();
  await tick(30_000);
  assert.deepEqual(net.polls, []);

  // Undeclared delivery counts once the element reports an unbounded stream.
  await player.playItem(liveItem('unknown', { delivery: 'unknown' }));
  await settle();
  await tick(30_000);
  assert.deepEqual(net.polls, []);
  audio.duration = Infinity;
  audio.emit('durationchange');
  await tick(NOW_PLAYING_FIRST_POLL_MS);
  assert.equal(net.polls.length, 1);
  audio.duration = Number.NaN;
  player.stop();
});

test('renaming the playing favorite updates its initials and the media session at once', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, elements, net, mediaSession, tick } = await setup(t);
  const state = getState();
  const before = { favorites: state.favorites, storage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage') };
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: storage });
  t.after(() => {
    state.favorites = before.favorites;
    if (before.storage) Object.defineProperty(globalThis, 'localStorage', before.storage);
    else delete globalThis.localStorage;
  });
  const item = liveItem('a', { title: 'Radio One' });
  state.favorites = [{ ...item }];
  await player.playItem(item);
  await settle();
  net.titles.set(mediaId(1), { title: 'Artist - Song', changed_at: 1_700_000_000 });
  await tick(NOW_PLAYING_FIRST_POLL_MS);
  const initials = elements['player-art-initials'];
  assert.equal(initials.textContent, 'RO');
  assert.equal(mediaSession.metadata.artist, 'Radio One');

  storage.setItem(FAVORITE_NAMES_KEY, JSON.stringify({ version: 1, names: { [item.id]: 'Morning Jazz' } }));
  emit('favorites-change', state.favorites);
  assert.equal(elements['player-title'].textContent, 'Morning Jazz');
  assert.equal(initials.textContent, 'MJ');
  assert.equal(mediaSession.metadata.title, 'Artist - Song');
  assert.equal(mediaSession.metadata.artist, 'Morning Jazz');
  // The song going away still brings back what was there before.
  player.stop();
  assert.equal(mediaSession.metadata, 'metadata-before-song');
});

test('station text is shown as plain text only', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, elements, source, net, mediaSession, tick } = await setup(t);
  await player.playItem(liveItem('x'));
  await settle();
  net.titles.set(mediaId(1), { title: '<img src=x onerror=alert(1)>\u0007 Song\u202E', changed_at: 1 });
  await tick(NOW_PLAYING_FIRST_POLL_MS);
  assert.equal(source.textContent, `${NOTE} <img src=x onerror=alert(1)> Song`);
  assert.equal(mediaSession.metadata.title, '<img src=x onerror=alert(1)> Song');
  for (const element of Object.values(elements)) {
    assert.equal(Object.hasOwn(element, 'innerHTML'), false);
    assert.equal(Object.hasOwn(element, 'outerHTML'), false);
  }
  player.stop();
});

test('the Now Playing clock counts only while the media advances: not between play and playing, not while buffering', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { player, audio } = await setup(t);
  let now = 0;
  const clock = createPlayClock({ now: () => now });
  const advancing = [];
  const stopWatch = subscribe(MEDIA_ADVANCING_EVENT, (value) => advancing.push(value));
  const stopClock = clock.start(subscribe, player.getCurrentItem, player.isMediaAdvancing);
  t.after(() => { stopWatch(); stopClock(); });
  const item = liveItem('clock');
  // The element's events come one by one, as from a real stream.
  audio.autoEvents = false;
  await player.playItem(item);
  await settle();
  audio.emit('play');
  await settle();
  assert.equal(getState().isPlaying, true, 'the controls show playing from `play`');
  assert.equal(player.isMediaAdvancing(), false);
  now += 120_000; // two minutes connecting: no sound yet
  assert.equal(clock.played(item.id), null, 'connecting is not playing');
  audio.emit('waiting');
  now += 30_000;
  assert.equal(clock.played(item.id), null);

  audio.emit('playing');
  assert.equal(player.isMediaAdvancing(), true);
  now += 60_000;
  assert.equal(clock.played(item.id), 60_000);
  // Buffering for two minutes: `waiting` leaves isPlaying true but stops the clock.
  audio.emit('waiting');
  assert.equal(getState().isPlaying, true);
  assert.equal(player.isMediaAdvancing(), false);
  now += 120_000;
  assert.equal(clock.played(item.id), 60_000, 'buffering adds nothing');
  // `stalled` alone (fetching paused, buffered sound still playing) does not stop it.
  audio.emit('playing');
  audio.emit('stalled');
  now += 30_000;
  assert.equal(clock.played(item.id), 90_000);
  // A pause stops it; Play continues from the same time.
  audio.pause();
  audio.emit('pause');
  now += 600_000;
  assert.equal(clock.played(item.id), 90_000);
  await player.togglePlay();
  await settle();
  audio.emit('play');
  audio.emit('playing');
  now += 10_000;
  assert.equal(clock.played(item.id), 100_000);
  // Stop: the item is gone and nothing counts.
  player.stop();
  await settle();
  assert.equal(player.isMediaAdvancing(), false);
  assert.equal(clock.running, false);
  assert.equal(clock.played(item.id), null);
  assert.deepEqual(advancing, [true, false, true, false, true, false]);
});
