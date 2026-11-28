import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';

import { AudioEngine } from '../src/lib/audio-engine.js';
import { artworkSourceFor } from '../src/lib/artwork.js';
import { resetControlSession } from '../src/lib/capture-client.js';
import { computerLibrary, createComputerLibrary } from '../src/lib/computer-library.js';
import { initCaptureUi } from '../src/lib/capture-ui.js';
import { bookPlaybackOptions, bookResumeIndex, computerQueueState, makeComputerItem, playComputerEntries } from '../src/lib/computer-play.js';
import { computerTrackFileKey, loadComputerTrackPrefs, rememberComputerTracks } from '../src/lib/computer-track-prefs.js';
import { didNotPlayAt } from '../src/lib/did-not-play.js';
import { makeItem, validateItem } from '../src/lib/item-model.js';
import { PART_RESUME_KEY, readPartResume } from '../src/lib/part-resume.js';
import { createPlayerMeter } from '../src/lib/player-meter.js';
import { EXTRA_SETTINGS_STORAGE_KEY } from '../src/lib/profile-storage.js';
import { playedStreamOf } from '../src/lib/played-streams.js';
import * as player from '../src/lib/player.js';
import { getSourceLabel, SOURCES } from '../src/lib/sources.js';
import { createSongLog } from '../src/lib/song-log.js';
import { addFavorite, emit, getState, initState, loadComputerStars, normalizeFavoriteItem, removeFavorite, saveSettings, STORAGE_KEYS, subscribe } from '../src/lib/state.js';
import { createPlayerDom, FakeElement } from './helpers/fake-dom.js';
import { fakeComputerStars } from './helpers/fake-computer-stars.js';
import {
  computerCardSubtitle, computerItemForView, nextPlayableLibraryItem, playLibraryItem, updateComputerHits,
} from '../src/modes/library/computer.js';
import { closeDetail } from '../src/modes/library/detail.js';
import { renderResults } from '../src/modes/library/render.js';
import { ui } from '../src/modes/library/shell-refs.js';
import { renderedIds, view } from '../src/modes/library/state.js';

const entry = (id, overrides = {}) => ({
  id, kind: 'audio', title: `Track ${id}`, artist: 'An Artist', album: 'An Album',
  year: 2025, ext: 'mp3', acodec: 'mp3', duration: 120, ...overrides,
});
const response = (data, status = 200, error = null) => Response.json({ ok: !error, data, error }, { status });
const media = (id, kind = 'audio', suffix = '') => ({
  url: `/api/v1/computer/media/${id}${suffix}`, kind, duration: 120,
});
const movie = (id, overrides = {}) => entry(id, {
  kind: 'video', ext: 'vob', vcodec: 'mpeg2video', acodec: 'ac3',
  width: 720, height: 480, channels: 6, duration: 1_200, ...overrides,
});
const hlsMedia = (file, token = file.id, duration = file.duration) => ({
  hls: true, url: `/api/v1/computer/hls/${token}/index.m3u8`, duration, entry: file, converted: true,
});
const vtt = 'WEBVTT\n\n00:00:02.000 --> 00:00:03.000\nHello.\n';
const subtitle = (key, language, extra = {}) => ({ key, label: key, language, ...extra });
const sound = (selected) => [
  { index: 0, label: 'English', language: 'en' },
  { index: 1, label: 'German', language: 'de' },
  { index: 2, label: 'French', language: 'fr' },
].map((track) => ({ ...track, selected: track.index === selected, default: track.index === 0 }));
const film = (id, extra = {}) => movie(id, { size: 5_000_000, mtime: 400, ...extra });
const timeRanges = (...ranges) => ({
  length: ranges.length, start: (i) => ranges[i][0], end: (i) => ranges[i][1],
});

class FakeHls {
  static instances = [];
  static Events = { ERROR: 'error' };
  static DefaultConfig = { loader: class {
    load(_context, config) { this.config = config; }
  } };
  static ErrorTypes = { MEDIA_ERROR: 'mediaError', NETWORK_ERROR: 'networkError' };
  static isSupported() { return true; }

  constructor(config) {
    this.config = config;
    this.listeners = new Map();
    this.levels = [];
    this.loads = [];
    this.stopLoads = 0;
    this.abrController = { clearTimer: () => { this.abrTimerCleared = true; } };
    this.firstFragment = null;
    this.destroyed = false;
    FakeHls.instances.push(this);
  }
  on(event, callback) { this.listeners.set(event, callback); }
  loadSource(url) { this.url = url; }
  attachMedia(video) {
    this.video = video;
    video.src = 'blob:fake-hls';
    video.readyState = 0;
    video.buffered = timeRanges();
  }
  loadManifest() {
    this.levels = [{}];
    this.firstFragment ??= Math.floor(this.config.startPosition / 6);
  }
  startLoad(position) {
    this.loads.push(position);
    this.firstFragment ??= Math.floor(position / 6);
  }
  stopLoad() { this.stopLoads++; }
  destroy() { this.destroyed = true; }
  error(data) { this.listeners.get('error')?.('error', data); }
}

const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise(setImmediate);
};
const click = (element) => element.dispatchEvent(new Event('click'));
function press(element, key, target) {
  const event = new Event('keydown', { cancelable: true });
  Object.defineProperty(event, 'key', { value: key });
  if (target) Object.defineProperty(event, 'target', { value: target });
  element.dispatchEvent(event);
  return event.defaultPrevented;
}

function addTrackDom(document, elements, window) {
  const create = document.createElement;
  document.defaultView = window;
  document.documentElement.clientWidth = 1024;
  document.documentElement.clientHeight = 640;
  for (const name of ['subtitles', 'audio']) {
    const button = document.register(new FakeElement('player-' + name, 'button'));
    const menu = document.register(new FakeElement('player-' + name + '-menu'));
    button.title = name === 'subtitles' ? 'Subtitles (C)' : 'Audio';
    for (const el of [button, menu]) {
      elements[el.id] = el;
      el.ownerDocument = document;
      el.focus = () => { document.activeElement = el; };
      el.getBoundingClientRect = () => ({ left: 400, top: 550, width: 144, height: 160 });
    }
    menu.matches = (selector) => selector === ':popover-open' && menu.open;
    menu.showPopover = () => { menu.open = true; menu.dispatchEvent(new Event('toggle')); };
    menu.hidePopover = () => { menu.open = false; menu.dispatchEvent(new Event('toggle')); };
    menu.replaceChildren = (...rows) => { menu.children = rows; };
  }
  const video = elements['video-el'];
  video.textTracks = new EventTarget();
  document.createElement = (tag) => {
    const el = create(tag);
    el.append = (...children) => el.children.push(...children);
    el.focus = () => { document.activeElement = el; };
    el.click = () => click(el);
    if (tag === 'track') {
      let mode = 'disabled';
      el.track = {
        get mode() { return mode; },
        set mode(value) { mode = value; video.textTracks.dispatchEvent(new Event('change')); },
      };
      el.remove = () => {
        video.children.splice(video.children.indexOf(el), 1);
        video.textTracks.dispatchEvent(new Event('change'));
      };
    }
    return el;
  };
}

test('Computer items are ordinary favorites with a local address and no web or download address', () => {
  const item = makeComputerItem(entry('music'));
  assert.deepEqual(validateItem(item), []);
  assert.equal(item.id, 'computer:music');
  assert.equal(item.source, 'computer');
  assert.equal(item.type, 'audio');
  assert.equal(item.delivery, 'on-demand');
  assert.equal(item.year, 2025);
  assert.equal(item.title, 'Track music');
  assert.equal(item.description, 'An Artist · An Album');
  assert.deepEqual(item._extra.computer, {
    id: 'music', artist: 'An Artist', album: 'An Album', duration: 120, format: 'MP3', formatDetails: 'MP3', ext: 'mp3',
  });
  assert.equal(makeComputerItem(entry('estimated', { duration_estimated: true }))._extra.computer.duration_estimated, true);
  assert.equal(item.stream_url, 'computer:music');
  assert.equal(item.download_url, '');
  assert.equal(item.source_url, '');
  assert.deepEqual(normalizeFavoriteItem(JSON.parse(JSON.stringify(item)), { restart: true }), item);
  assert.equal(getSourceLabel(item.source), 'Computer');
  assert.equal(SOURCES.some(({ id }) => id === item.source), false);
  assert.equal(artworkSourceFor(item), '');
  const covered = makeComputerItem(entry('music', { has_cover: true }));
  assert.equal(artworkSourceFor(covered, { large: true }), '/api/v1/computer/art/music?size=large');
  assert.equal(artworkSourceFor(makeComputerItem(entry('other', { art: true }))), '/api/v1/computer/art/other');
  const video = makeComputerItem(entry('video', { kind: 'video', season: 2, episode: 4 }));
  assert.equal(video.title, 'Track video · S02E04');
  assert.equal(video.type, 'video');
  assert.equal(video.description, '');
  assert.equal(artworkSourceFor(video), '/api/v1/computer/art/video');
  for (const kind of ['audio', 'video']) {
    const unreadable = makeComputerItem(entry('bad', { kind, has_cover: true, error: 'This file could not be read.' }));
    assert.equal(artworkSourceFor(unreadable), '');
    assert.equal(artworkSourceFor(unreadable, { large: true }), '');
  }
});

test('Computer files use the global player and in-memory queue', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
  const { document, elements } = createPlayerDom();
  const visibilityEvents = new EventTarget();
  document.addEventListener = visibilityEvents.addEventListener.bind(visibilityEvents);
  document.removeEventListener = visibilityEvents.removeEventListener.bind(visibilityEvents);
  document.visibilityState = 'visible';
  const window = new EventTarget();
  window.setTimeout = (...args) => setTimeout(...args);
  window.clearTimeout = (id) => clearTimeout(id);
  const storage = new Map();
  const starServer = fakeComputerStars();
  const requests = [];
  const opens = [];
  const releases = [];
  const measurements = [];
  const unexpected = [];
  const answers = new Map();
  const subtitleAnswers = new Map();
  const subtitleRequests = [];
  let libraryFiles;
  const libraryFolders = [{ id: 'music' }, { id: 'drive', available: false }];
  const state = getState();
  const previousState = { settings: state.settings, favorites: state.favorites, sleepTimer: state.sleepTimer };
  state.settings = { ...state.settings, bestStreamMode: 'auto', showTechnicalDetails: true };
  state.favorites = [];
  state.sleepTimer = { until: null };
  const mediaActions = new Map();
  const mediaSession = {
    playbackState: 'none', metadata: 'previous metadata',
    setActionHandler(name, handler) { mediaActions.set(name, handler); },
  };
  const globals = {
    document, window, navigator: { mediaSession },
    MediaMetadata: class { constructor(data) { Object.assign(this, data); } },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    async fetch(path, options = {}) {
      requests.push(path);
      if (path === '/api/v1/session') return response({ token: 'computer-player' });
      if (path === '/api/v1/computer/library' && libraryFiles) {
        return response({ revision: 1, items: libraryFiles, folders: libraryFolders });
      }
      if (path === '/api/v1/computer/play') {
        const { id, convert, audio, standby } = JSON.parse(options.body);
        opens.push({ id, convert, audio, standby, signal: options.signal });
        return answers.has(id) ? answers.get(id)(options) : response(media(id));
      }
      if (path.startsWith('/api/v1/computer/subtitle?')) {
        const query = new URLSearchParams(path.split('?')[1]);
        const key = query.get('key');
        assert.equal(options.headers['X-WorldMedia-Token'], 'computer-player');
        subtitleRequests.push({ id: query.get('entry'), key, signal: options.signal });
        return subtitleAnswers.has(key) ? subtitleAnswers.get(key)() : new Response(vtt);
      }
      if (/^\/api\/v1\/computer\/media\/[^/]+\/(?:keep|release)$/.test(path)) return new Response(null, { status: 204 });
      if (path === '/api/v1/computer/loudness') {
        measurements.push({ id: JSON.parse(options.body).id, signal: options.signal });
        return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
      }
      const release = /^\/api\/v1\/computer\/hls\/([^/]+)\/release$/.exec(path);
      if (release) {
        releases.push({ token: release[1], method: options.method, keepalive: options.keepalive,
          header: options.headers['X-WorldMedia-Token'] });
        return response({ released: true });
      }
      if (path === '/api/v1/computer/stars') return starServer.fetch(path, options);
      if (path === '/api/v1/computer/art/cover') {
        assert.equal(options.headers['X-WorldMedia-Token'], 'computer-player');
        return new Response(new Uint8Array([255, 216, 255, 217]), { headers: { 'Content-Type': 'image/jpeg' } });
      }
      if (String(path).startsWith('/api/v1/computer/art/')) return new Response(null, { status: 404 });
      if (path === '/api/v1/media/register') {
        return response({ media_id: 'remote_test_media_0001', relay_url: '/api/v1/media/remote_test_media_0001' });
      }
      if (String(path).endsWith('/now-playing')) return response({ title: '' });
      if (String(path).endsWith('/expire')) return response({ expired: true });
      if (options.headers?.Range) return new Response(null, { status: 206 });
      unexpected.push(path);
      throw new Error(`Unexpected request ${path}`);
    },
  };
  const previousGlobals = new Map();
  for (const [name, value] of Object.entries(globals)) {
    previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  resetControlSession();
  t.after(() => {
    player.stop();
    resetControlSession();
    Object.assign(state, previousState);
    for (const [name, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  for (const id of ['player-previous-part', 'player-next-part', 'player-previous-part-slot', 'player-next-part-slot']) {
    elements[id] = document.register(new FakeElement(id, 'button'));
  }
  const audio = elements['audio-el'];
  const standby = elements['computer-audio-el'];
  const video = elements['video-el'];
  video.videoWidth = 1920;
  video.setAttribute('controls', '');
  for (const el of [audio, standby, video]) {
    const load = el.load.bind(el);
    el.load = () => {
      el.error = null;
      el.currentTime = 0;
      el.duration = Number.NaN;
      el.buffered = timeRanges();
      el.readyState = 0;
      el.ended = false;
      load();
    };
  }
  const art = elements['player-art'];
  art.isConnected = true;
  Object.defineProperty(art, 'src', { set(value) {
    art.setAttribute('src', value);
    art.naturalWidth = 32;
    art.complete = true;
  } });
  const previous = elements['player-previous-part'];
  const next = elements['player-next-part'];
  const source = elements['player-source'];
  const broken = elements['player-next-broken'];
  const open = (id, overrides) => player.playItem(makeComputerItem(entry(id, overrides)));
  const currentId = () => player.getCurrentItem()?.id;
  const metadata = (el, duration) => { el.duration = duration; el.emit('loadedmetadata'); };
  const ended = (el) => { el.ended = true; el.paused = true; el.emit('ended'); };
  const advanceClock = async (ms) => { t.mock.timers.tick(ms); await settle(); };
  const activeHls = () => FakeHls.instances.at(-1);
  const released = (token) => releases.filter((request) => request.token === token).length;
  const seekTo = (position) => {
    const seek = elements['player-seek'];
    seek.value = String(position);
    seek.dispatchEvent(new Event('input'));
    seek.dispatchEvent(new Event('change'));
  };
  const frame = (position, duration = 1_200) => {
    activeHls().loadManifest();
    video.seeking = false;
    video.readyState = 2;
    video.buffered = timeRanges([position, position + 25]);
    video.currentTime = position;
    metadata(video, duration);
    video.emit('loadeddata');
  };
  const httpError = (status, details, { error, fatal = false } = {}) => {
    const body = JSON.stringify({ error });
    activeHls().error({
      type: FakeHls.ErrorTypes.NETWORK_ERROR, details, fatal, response: { code: status },
      networkDetails: { response: details === 'fragLoadError' ? new TextEncoder().encode(body).buffer : body },
    });
  };
  const expired = (details) => httpError(410, details, {
    error: { code: 'COMPUTER_MEDIA_EXPIRED', message: 'This play link has expired.' },
  });
  const station = makeItem({
    id: 'test:gap-radio', title: 'Radio', source: 'test', type: 'audio', delivery: 'live',
    stream_kind: 'audio', stream_url: 'https://example.org/radio.mp3',
  });

  addTrackDom(document, elements, window);
  player.initPlayer({ loadHls: async () => FakeHls });

  await t.test('opens progressive media by server kind, keeps metadata and capture controls correct', async (subtest) => {
    const capture = initCaptureUi({
      fetchImpl: (path, options) => path === '/api/v1/jobs' ? response({ jobs: [] }) : globals.fetch(path, options),
    });
    subtest.after(() => capture.destroy());
    const log = createSongLog({ native: false, getItem: player.getCurrentItem });
    log.start((name, fn) => subtest.after(subscribe(name, fn)));
    await open('cover', { has_cover: true });
    await settle();
    assert.equal(audio.src, media('cover').url);
    assert.equal(audio.crossOrigin, 'anonymous');
    assert.equal(video.src, '');
    assert.equal(source.textContent, 'An Artist · An Album');
    assert.equal(source.title, 'An Artist · An Album\nMP3');
    saveSettings({ showTechnicalDetails: false });
    assert.equal(source.title, '');
    assert.equal(elements['player-title'].textContent, 'Track cover');
    assert.ok(art.getAttribute('src')?.startsWith('blob:'));
    assert.equal(mediaSession.metadata.title, 'Track cover');
    assert.equal(mediaSession.metadata.artist, 'An Artist');
    assert.equal(mediaSession.metadata.album, 'An Album');
    assert.equal(mediaSession.metadata.artwork[0].src, art.getAttribute('src'));
    assert.equal(player.getCurrentMediaAction({ downloadUrl: 'example', streamUrl: 'example' }), 'unavailable');
    assert.equal(elements['player-capture'].hidden, true, 'the shared Record / Download button is hidden');
    assert.equal(elements['player-capture-secondary'].hidden, true);
    const star = elements['player-fav'];
    assert.equal(star.getAttribute('aria-pressed'), 'false');
    await loadComputerStars();
    addFavorite(makeComputerItem(entry('cover')));
    assert.equal(star.getAttribute('aria-pressed'), 'true');
    removeFavorite(currentId());
    assert.equal(star.getAttribute('aria-pressed'), 'false');
    click(star);
    const saved = state.favorites.find(({ id }) => id === currentId());
    assert.deepEqual(normalizeFavoriteItem(JSON.parse(JSON.stringify(saved)), { restart: true }), saved);
    metadata(audio, 120);
    audio.currentTime = 30;
    audio.emit('timeupdate');
    await advanceClock(60_000);
    assert.equal(player.getNowPlaying(), null);
    assert.deepEqual(log.entries(), []);
    assert.equal(didNotPlayAt(currentId()), 0);
    assert.equal(playedStreamOf(currentId()), null);
    assert.equal(elements['player-seek'].classList.contains('is-live'), false);
    assert.equal(elements['player-seek'].disabled, false);
    assert.ok(requests.every((path) => path === '/api/v1/session' || path.startsWith('/api/v1/computer/')));

    const oldArtwork = mediaSession.metadata.artwork[0].src;
    const revoke = URL.revokeObjectURL;
    let revoked = false;
    const spy = subtest.mock.method(URL, 'revokeObjectURL', (url) => {
      if (url === oldArtwork) {
        revoked = true;
        assert.ok(!mediaSession.metadata?.artwork?.some(({ src }) => src === url));
      }
      revoke(url);
    });
    answers.set('detected-video', () => response(media('detected-video', 'video')));
    await open('detected-video');
    await settle();
    assert.equal(requests.includes('/api/v1/computer/art/detected-video'), false);
    assert.deepEqual(mediaSession.metadata.artwork, []);
    assert.equal(revoked, true);
    spy.mock.restore();
    assert.equal(video.src, media('detected-video').url);
    assert.equal(video.hasAttribute('controls'), true);
    assert.equal(audio.src, '');
    answers.set('named-video', () => response(media('named-video', 'video')));
    await open('named-video', { kind: 'video' });
    assert.equal(source.textContent, 'Video');
    assert.equal(video.classList.contains('is-live-video'), false);
    assert.equal(broken.hidden, true);
  });

  await t.test('episode metadata survives opening the file and a missing favorite leaves playback alone', async () => {
    const episodes = [
      movie('pilot', { rel: 'Test.Show.S01E02.Pilot.720p.mkv', season: 1, episode: 2,
        episode_title: 'Pilot' }),
      movie('next-season', { rel: 'Test.Show.S02E01.720p.mkv', season: 2, episode: 1, episode_title: '' }),
    ];
    for (const item of episodes) {
      answers.set(item.id, () => response({ ...media(item.id, 'video'), entry: item }));
    }
    await playComputerEntries(episodes, 0);
    await settle();
    assert.equal(elements['player-title'].textContent, 'Test Show · S01E02');
    assert.equal(source.textContent, 'Pilot');
    assert.equal(mediaSession.metadata.title, 'Test Show · S01E02');
    assert.equal(mediaSession.metadata.artist, 'Pilot');
    assert.deepEqual(mediaSession.metadata.artwork, []);
    assert.equal(art.getAttribute('src'), null);
    assert.ok(requests.some((path) => path.startsWith('/api/v1/computer/art/pilot')));
    const queue = computerQueueState();
    const openCount = opens.length;
    const paused = video.paused;
    const url = video.src;
    assert.equal(player.showComputerSelectionMessage('That file is no longer there.'), true);
    assert.equal(source.textContent, 'That file is no longer there.');
    assert.equal(source.title, source.textContent);
    assert.equal(video.paused, paused);
    assert.equal(video.src, url);
    assert.equal(computerQueueState(), queue);
    assert.equal(opens.length, openCount);
    await advanceClock(4_999);
    assert.equal(source.textContent, 'That file is no longer there.');
    await advanceClock(1);
    assert.equal(source.textContent, 'Pilot');
    click(next);
    await settle();
    assert.equal(elements['player-title'].textContent, 'Test Show · S02E01');
    assert.equal(source.textContent, '');
    assert.equal(mediaSession.metadata.artist, '');
  });

  await t.test('play a favorite restored by the normal startup path', async () => {
    const settings = state.settings;
    const savedItem = makeComputerItem(entry('persisted'));
    assert.ok(addFavorite(savedItem));
    await settle();
    assert.equal(storage.get(STORAGE_KEYS.favorites), undefined);
    await initState();
    await loadComputerStars();
    state.settings = settings;
    const restored = state.favorites.find(({ id }) => id === savedItem.id);
    assert.equal(restored._extra.computer.chapters, undefined);
    const refreshed = entry('persisted', {
      title: 'New title', artist: 'New artist', album: 'New album', duration: 360,
      chapters: [{ start: 0, title: 'First' }, { start: 120, title: 'Second' }],
    });
    answers.set('persisted', () => response({ ...media('persisted'), entry: refreshed }));
    await player.playItem(restored);
    metadata(audio, 360);
    assert.equal(audio.src, media('persisted').url);
    assert.equal(currentId(), savedItem.id);
    assert.equal(player.getCurrentItem()._extra.computer.duration, 360);
    assert.equal(elements['player-title'].textContent, 'New title');
    assert.equal(mediaSession.metadata.artist, 'New artist');
    assert.equal(mediaSession.metadata.album, 'New album');
    assert.equal(restored.title, 'New title');
    assert.match(source.textContent, /Chapter 1 of 2/);
    click(next);
    assert.equal(audio.currentTime, 120);
    assert.match(source.textContent, /Chapter 2 of 2.*Second/);
    click(previous);
    assert.equal(audio.currentTime, 0);
    assert.equal(requests.includes('/api/v1/computer/art/persisted'), false);
    assert.deepEqual(mediaSession.metadata.artwork, []);
    removeFavorite(savedItem.id);
  });

  await t.test('a row error keeps the current video and queue playing', async () => {
    const playing = movie('keep-playing');
    answers.set(playing.id, () => response(media(playing.id, 'video')));
    await playComputerEntries([playing], 0);
    const queue = computerQueueState();
    const openCount = opens.length;
    const message = 'This file is too short to play.';
    const bad = movie('still', { error: message, duration: null });
    await playComputerEntries([bad], 0);
    assert.equal(source.textContent, message);
    assert.equal(currentId(), 'computer:keep-playing');
    assert.equal(video.src, media(playing.id, 'video').url);
    assert.equal(video.paused, false);
    assert.equal(computerQueueState(), queue);
    assert.equal(opens.length, openCount);

    player.stop();
    await playComputerEntries([bad], 0);
    assert.equal(source.textContent, message);
    assert.equal(elements['player-bar'].hidden, false);
    assert.equal(opens.length, openCount);
  });

  await t.test('refused selections preserve the playing or paused file and its queue', async () => {
    player.stop();
    const keep = entry('protected-song');
    const refusals = [
      ['COMPUTER_FOLDER_OFFLINE', 409, 'That folder is not connected.'],
      ['COMPUTER_FILE_GONE', 404, 'That file is no longer there.'],
      ['COMPUTER_ENTRY_NOT_FOUND', 404, 'That file is not in the library.'],
      ['COMPUTER_VIDEO_TOO_SHORT', 422, 'This file is too short to play.'],
      ['COMPUTER_FILE_UNREADABLE', 422, 'This file cannot be read.'],
    ];
    const rejected = refusals.map(([code]) => entry('protected-' + code));
    await playComputerEntries([keep, rejected[0]], 0);
    const queue = computerQueueState();
    const active = state.currentItem;
    metadata(audio, 120);
    audio.currentTime = 27;
    audio.emit('timeupdate');
    for (const [index, [code, status, message]] of refusals.entries()) {
      const file = rejected[index];
      answers.set(file.id, () => response(null, status, { code, retryable: false, message: 'Unrecognized server wording.' }));
      const before = opens.length;
      if (index === 0) {
        click(next);
        await settle();
      } else {
        if (index === 1) await player.togglePlay();
        await playComputerEntries([file], 0);
      }
      assert.equal(opens.length, before + 1, code);
      assert.equal(state.currentItem, active, code);
      assert.equal(audio.currentTime, 27, code);
      assert.equal(audio.src, media(keep.id).url, code);
      assert.equal(audio.paused, index !== 0, code);
      assert.equal(computerQueueState(), queue, code);
      assert.equal(queue.index, 0, code);
      assert.equal(queue.failures, 0, code);
      assert.equal(source.textContent, message, code);
    }
    await advanceClock(5_000);
    assert.equal(source.textContent, 'An Artist \u00b7 An Album');
    player.stop();
  });

  await t.test('a long preparation keeps the old item until its one successful reply', async () => {
    const old = entry('during-conversion');
    const slow = movie('protected-dvd');
    await playComputerEntries([old, entry('old-successor')], 0);
    const queue = computerQueueState();
    audio.currentTime = 12;
    let finish;
    answers.set(slow.id, () => new Promise((resolve) => { finish = resolve; }));
    const before = opens.length;
    const pending = playComputerEntries([slow, entry('new-successor')], 0);
    await settle();
    await advanceClock(399);
    assert.equal(source.textContent, 'An Artist \u00b7 An Album');
    await advanceClock(1);
    assert.equal(source.textContent, 'Preparing ' + makeComputerItem(slow).title + '...');
    await advanceClock(15_600);
    audio.currentTime = 28;
    audio.emit('timeupdate');
    assert.equal(currentId(), 'computer:' + old.id);
    assert.equal(state.isPlaying, true);
    assert.equal(audio.currentTime, 28);
    assert.equal(computerQueueState(), queue);
    assert.match(source.textContent, /^Preparing /);
    finish(response(hlsMedia(slow)));
    await pending;
    assert.deepEqual(opens.slice(before).map(({ id }) => id), [slow.id]);
    assert.equal(audio.paused, true);
    assert.equal(currentId(), 'computer:' + slow.id);
    assert.equal(activeHls().url, hlsMedia(slow).url);
    assert.deepEqual(computerQueueState().entries.map(({ id }) => id), [slow.id, 'new-successor']);
    player.stop();
  });

  await t.test('a newer click, Stop and starting a station cancel pending Computer selections', async () => {
    const deferOpen = async (id) => {
      let finish;
      answers.set(id, () => new Promise((resolve) => { finish = resolve; }));
      const task = open(id);
      await settle();
      assert.equal(opens.at(-1).id, id);
      return { finish, task, signal: opens.at(-1).signal };
    };
    await open('protected-before-switch');
    const first = await deferOpen('protected-replaced');
    const second = await deferOpen('protected-replacement');
    assert.equal(first.signal.aborted, true);
    first.finish(response(hlsMedia(movie('protected-replaced'))));
    await first.task;
    await settle();
    assert.equal(released('protected-replaced'), 1);
    assert.equal(currentId(), 'computer:protected-before-switch');
    second.finish(response(media('protected-replacement')));
    await second.task;
    assert.equal(currentId(), 'computer:protected-replacement');

    const stopped = await deferOpen('protected-stopped');
    await advanceClock(400);
    assert.match(source.textContent, /^Preparing /);
    player.stop();
    assert.equal(stopped.signal.aborted, true);
    stopped.finish(response(media('protected-stopped')));
    await stopped.task;
    assert.equal(player.getCurrentItem(), null);
    assert.equal(elements['player-bar'].hidden, true);
    await settle();
    assert.ok(requests.includes(media('protected-stopped').url + '/release'));

    await open('protected-before-station');
    const movedOn = await deferOpen('protected-then-station');
    await player.playItem(station);
    assert.equal(movedOn.signal.aborted, true);
    movedOn.finish(response(media('protected-then-station')));
    await movedOn.task;
    assert.equal(currentId(), station.id);
    assert.equal(audio.paused, false);
    player.stop();
  });

  await t.test('a pending selection owns the next start when a prepared track ends', async () => {
    for (const fail of [true, false]) {
      const suffix = String(fail);
      const nextId = 'unused-standby-' + suffix;
      await playComputerEntries([entry('ending-' + suffix), entry(nextId)], 0);
      metadata(audio, 30);
      await settle();
      assert.equal(opens.at(-1).standby, true);
      standby.readyState = 4;
      standby.emit('canplaythrough');
      const id = 'slow-choice-' + suffix;
      const reply = Promise.withResolvers();
      answers.set(id, () => reply.promise);
      const pending = open(id);
      await settle();
      assert.equal(opens.at(-1).standby, true);
      assert.equal(standby.src, '');
      assert.ok(requests.includes(media(nextId).url + '/release'));
      ended(audio);
      assert.equal(computerQueueState().index, 0);
      assert.equal(source.textContent, 'Preparing Track ' + id + '...');
      if (fail) reply.reject(new TypeError('fetch failed'));
      else reply.resolve(response(media(id)));
      await pending;
      assert.equal(opens.filter(open => open.id === nextId).length, 1);
      if (fail) {
        assert.equal(source.textContent, 'Could not open Track ' + id + '.');
        await advanceClock(5_000);
        assert.equal(state.isPlaying, false);
        assert.equal(computerQueueState().index, 0);
      } else {
        assert.equal(audio.src, media(id).url);
        assert.ok(requests.includes(media(id).url + '/keep'));
      }
      player.stop();
    }
  });

  await t.test('a current playback error remains visible when the delayed selection hint fires', async () => {
    await open('current-error');
    const reply = Promise.withResolvers();
    answers.set('after-error', () => reply.promise);
    const pending = open('after-error');
    await settle();
    audio.error = { code: 3 };
    answers.set('current-error', () => response(null, 422, { code: 'COMPUTER_CONVERT_FAILED' }));
    audio.emit('error');
    await settle();
    const message = source.textContent;
    assert.equal(message, 'This file could not be converted.');
    await advanceClock(400);
    assert.equal(source.textContent, message);
    reply.resolve(response(media('after-error')));
    await pending;
    assert.equal(audio.src, media('after-error').url);
    player.stop();
  });

  await t.test('the station keeps playing when a Computer file is refused', async () => {
    await player.playItem(station);
    const file = entry('protected-radio-refusal');
    const before = opens.length;
    const stationUrl = audio.src;
    const active = state.currentItem;
    const normalLine = source.textContent;
    audio.currentTime = 32;
    answers.set(file.id, () => response(null, 409, { code: 'COMPUTER_FOLDER_OFFLINE' }));
    await open(file.id);
    assert.equal(opens.length, before + 1);
    assert.equal(state.currentItem, active);
    assert.equal(state.currentItem.id, station.id);
    assert.equal(audio.src, stationUrl);
    assert.equal(audio.currentTime, 32);
    assert.equal(audio.paused, false);
    assert.equal(computerQueueState(), null);
    assert.equal(source.textContent, 'That folder is not connected.');
    await advanceClock(5_000);
    assert.equal(source.textContent, normalLine);
    player.stop();
  });

  await t.test('a pending retryable 503 retries once after 1.5 seconds and keeps the active file', async () => {
    await open('protected-before-retry');
    const id = 'protected-retryable';
    answers.set(id, () => response(null, 503, {
      code: 'COMPUTER_FILE_UNREADABLE', retryable: true, message: 'The server is busy.',
    }));
    const before = opens.length;
    const pending = playComputerEntries([entry(id)], 0);
    await settle();
    await advanceClock(1_499);
    assert.equal(opens.length, before + 1);
    await advanceClock(1);
    await pending;
    assert.equal(opens.length, before + 2);
    assert.ok(opens.slice(before).every(({ standby }) => standby === true));
    assert.equal(currentId(), 'computer:protected-before-retry');
    assert.equal(audio.paused, false);
    assert.equal(source.textContent, 'The server is busy.');
    const cancelled = open(id);
    await settle();
    player.stop();
    await cancelled;
    await advanceClock(1_500);
    assert.equal(opens.length, before + 3);

    await player.playItem(station);
    const superseded = open(id);
    await settle();
    await open('newer-than-retry');
    await superseded;
    await advanceClock(1_500);
    assert.equal(currentId(), 'computer:newer-than-retry');
    assert.equal(opens.filter(open => open.id === id).length, 4);

    const retry = open(id);
    await settle();
    answers.set(id, () => response(media(id)));
    await advanceClock(1_500);
    await retry;
    assert.equal(currentId(), 'computer:' + id);
    assert.ok(requests.includes(media(id).url + '/keep'));
    player.stop();
  });

  await t.test('without playback a refusal keeps the existing start and retry path', async () => {
    const file = entry('unprotected-refusal');
    let finish;
    answers.set(file.id, () => new Promise((resolve) => { finish = resolve; }));
    const pending = playComputerEntries([file], 0);
    await settle();
    assert.equal(currentId(), 'computer:' + file.id);
    assert.equal(source.textContent, 'Connecting...');
    assert.equal(computerQueueState().index, 0);
    await advanceClock(400);
    assert.equal(source.textContent, 'Preparing...');
    finish(response(null, 404, { code: 'COMPUTER_FILE_GONE' }));
    await pending;
    assert.equal(computerQueueState().failures, 1);
    await advanceClock(5_000);
    assert.equal(source.textContent, 'That file is no longer there.');
    player.stop();
  });

  await t.test('a pending video request shows Preparing only after 400 ms', async () => {
    const delayed = (delay, reply) => () => new Promise((resolve) => setTimeout(() => resolve(reply), delay));
    const slow = movie('slow-index');
    answers.set(slow.id, delayed(1_000, response(hlsMedia(slow))));
    let pending = player.playItem(makeComputerItem(slow));
    await settle();
    assert.equal(opens.at(-1).id, slow.id);
    await advanceClock(399);
    assert.notEqual(source.textContent, 'Preparing...');
    await advanceClock(1);
    assert.equal(source.textContent, 'Preparing...');
    await advanceClock(599);
    assert.equal(source.textContent, 'Preparing...');
    await advanceClock(1);
    await pending;
    assert.equal(source.textContent, 'Preparing...');
    frame(0);
    assert.notEqual(source.textContent, 'Preparing...');

    const fast = movie('fast-native');
    answers.set(fast.id, delayed(50, response(media(fast.id, 'video'))));
    pending = player.playItem(makeComputerItem(fast));
    await settle();
    assert.notEqual(source.textContent, 'Preparing...');
    await advanceClock(50);
    await pending;
    assert.equal(video.src, media(fast.id, 'video').url);
    await advanceClock(350);
    assert.notEqual(source.textContent, 'Preparing...');

    const failed = movie('failed-index');
    player.stop();
    answers.set(failed.id, delayed(1_000, response(null, 422, { code: 'COMPUTER_VIDEO_TOO_SHORT' })));
    pending = player.playItem(makeComputerItem(failed));
    await settle();
    await advanceClock(400);
    assert.equal(source.textContent, 'Preparing...');
    await advanceClock(600);
    await pending;
    assert.equal(source.textContent, 'This file is too short to play.');
  });

  await t.test('new playback cancels a late open and ignores its result', async () => {
    let finish;
    answers.set('late', () => new Promise((resolve) => { finish = resolve; }));
    const pending = open('late');
    await settle();
    assert.equal(opens.at(-1).id, 'late');
    const older = opens.at(-1);
    assert.equal(source.textContent, 'Connecting...');
    await advanceClock(399);
    assert.equal(source.textContent, 'Connecting...');
    await advanceClock(1);
    assert.equal(source.textContent, 'Preparing...');
    await open('newer');
    assert.equal(older.signal.aborted, true);
    finish(response(media('late')));
    await pending;
    assert.equal(currentId(), 'computer:newer');
    assert.equal(audio.src, media('newer').url);
  });

  await t.test('Stop aborts audio preparation and ignores its answer', async () => {
    player.stop();
    let finish;
    answers.set('stop-preparing', () => new Promise((resolve) => { finish = resolve; }));
    const pending = open('stop-preparing');
    await settle();
    const request = opens.at(-1);
    await advanceClock(400);
    assert.equal(source.textContent, 'Preparing...');
    click(elements['player-stop']);
    assert.equal(request.signal.aborted, true);
    finish(response(media('stop-preparing')));
    await pending;
    assert.equal(audio.src, '');
    assert.notEqual(source.textContent, 'Preparing...');
  });

  await t.test('shows conversion errors verbatim and keeps the queue on a preparation timeout', async () => {
    const files = [entry('prep-error'), entry('after-prep')];
    const messages = [
      'Install FFmpeg in Settings to play this format.',
      'This file could not be converted.',
      'There is not enough disk space to prepare this file.',
      'This file takes too long to prepare.',
      'Audio conversion is busy.',
    ];
    for (const [index, message] of messages.entries()) {
      const retryable = index === 4;
      answers.set('prep-error', () => response(null, 422, { message, retryable }));
      await playComputerEntries(files, 0);
      assert.equal(source.textContent, message);
      assert.equal(computerQueueState().failures, retryable ? 0 : 1);
      if (retryable) {
        await advanceClock(2_100);
        assert.equal(computerQueueState().index, 0);
        answers.set('prep-error', () => response(media('prep-error')));
        click(elements['player-play']);
        await settle();
        assert.equal(audio.src, media('prep-error').url);
      }
    }
    player.stop();
    const openCount = opens.length;
    answers.set('bad-index', () => response(null, 422, {
      code: 'COMPUTER_FILE_UNREADABLE', retryable: false, message: 'This file cannot be read.',
    }));
    await open('bad-index', { error: 'Invalid source' });
    assert.equal(source.textContent, 'This file cannot be read.');
    assert.equal(opens.length, openCount + 1);
    answers.set('bad-probe', () => response(null, 422, { code: 'COMPUTER_FILE_UNREADABLE', message: 'Invalid source' }));
    await open('bad-probe');
    assert.equal(source.textContent, 'This file cannot be read.');
    answers.set('too-short', () => response(null, 422, { code: 'COMPUTER_VIDEO_TOO_SHORT', retryable: false }));
    await playComputerEntries([entry('too-short'), entry('after-too-short')], 0);
    assert.equal(source.textContent, 'This file is too short to play.');
    assert.equal(computerQueueState().failures, 1);
    await advanceClock(2_000);
    assert.equal(currentId(), 'computer:after-too-short');
  });

  await t.test('a retryable reply holds the queue and preserves earlier failures', async () => {
    player.stop();
    answers.set('prior-failure', () => response(null, 422, { code: 'COMPUTER_FILE_UNREADABLE' }));
    answers.set('retryable', () => response(null, 503, { retryable: true, message: 'The server is busy.' }));
    await playComputerEntries(['prior-failure', 'retryable', 'after-retry'].map((id) => entry(id)), 0);
    await advanceClock(2_000);
    assert.equal(currentId(), 'computer:retryable');
    assert.equal(computerQueueState().failures, 1);
    assert.equal(source.textContent, 'The server is busy.');
    await advanceClock(2_000);
    assert.equal(currentId(), 'computer:retryable');
    const attempts = opens.length;
    await player.togglePlay();
    assert.equal(opens.length, attempts + 1);
    assert.equal(computerQueueState().failures, 1);
  });

  await t.test('a repaired video row opens as fresh audio with chapters and conversion fallback', async () => {
    const fresh = entry('repaired', {
      title: 'Fresh title', ext: 'aiff', acodec: 'pcm_s16be', chapters: [{ start: 0, title: 'Intro' }],
    });
    answers.set(fresh.id, ({ body }) => {
      const { convert } = JSON.parse(body);
      return response({ ...media(fresh.id, 'audio', convert ? '-converted' : ''),
        entry: fresh, mime: convert ? 'audio/flac' : 'audio/aiff', converted: Boolean(convert) });
    });
    const listed = entry(fresh.id, { kind: 'video', error: 'Unreadable', vcodec: 'hevc', width: 1920 });
    await player.playItem(makeComputerItem(listed));
    assert.deepEqual(opens.filter(({ id }) => id === fresh.id).map(({ convert }) => convert), [undefined, true]);
    assert.equal(video.src, '');
    assert.equal(audio.src, media(fresh.id, 'audio', '-converted').url);
    assert.equal(player.getCurrentItem().type, 'audio');
    assert.equal(elements['player-title'].textContent, fresh.title);
    assert.match(player.getCurrentItem()._extra.computer.format, /AIFF/);
    assert.equal(player.isComputerPlaybackConverted(currentId()), true);
    assert.equal(player.getCurrentItem()._extra.computer.chapters[0].title, 'Intro');
  });

  await t.test('browser MIME rejection forces conversion once and uses the original format', async () => {
    saveSettings({ showTechnicalDetails: true });
    const input = entry('original-aiff', { ext: 'aiff', acodec: 'pcm_s16be', bits: 16, sample_rate: 44_100, lossless: true });
    let finish;
    answers.set(input.id, ({ body }) => JSON.parse(body).convert
      ? new Promise((resolve) => { finish = resolve; })
      : response({ ...media(input.id), mime: 'audio/aiff', entry: input }));
    const checked = [];
    const oldItem = player.getCurrentItem();
    const oldUrl = audio.src;
    const before = audio.canPlayType;
    audio.canPlayType = (mime) => { checked.push(mime); return ''; };
    const pending = player.playItem(makeComputerItem(input));
    try {
      await settle();
      assert.deepEqual(opens.filter(({ id }) => id === input.id).map(({ convert }) => convert), [undefined, true]);
      await advanceClock(400);
      assert.equal(source.textContent, 'Preparing ' + input.title + '...');
      assert.equal(player.getCurrentItem(), oldItem);
      assert.equal(audio.src, oldUrl);
      assert.equal(audio.paused, false);
      finish(response({ ...media(input.id, 'audio', '-converted'), entry: input, mime: 'audio/flac', converted: true, format: 'flac' }));
      await pending;
      assert.deepEqual(checked, ['audio/aiff']);
      assert.equal(audio.src, media(input.id, 'audio', '-converted').url);
      assert.match(source.title, /AIFF · 16-bit · 44\.1 kHz/u);
      assert.doesNotMatch(source.title, /FLAC/i);
    } finally {
      audio.canPlayType = before;
    }
  });

  await t.test('shows each open and format failure without Try next', async () => {
    player.stop();
    for (const [id, status, code, message] of [
      ['gone', 404, 'COMPUTER_FILE_GONE', 'That file is no longer there.'],
      ['offline', 409, 'COMPUTER_FOLDER_OFFLINE', 'That folder is not connected.'],
      ['other', 500, 'INTERNAL_ERROR', 'This file could not be opened.'],
    ]) {
      answers.set(id, () => response(null, status, { code }));
      await player.playItem(normalizeFavoriteItem(makeComputerItem(entry(id)), { restart: true }));
      assert.equal(source.textContent, message);
      assert.equal(broken.hidden, true);
    }
    for (const code of [3, 4]) {
      const play = audio.play;
      audio.play = async () => {
        audio.error = { code };
        audio.emit('error');
        throw new Error('Media failed');
      };
      try {
        await open(`format-${code}`);
        await settle();
      } finally {
        audio.play = play;
      }
      assert.equal(source.textContent, 'This format cannot be played yet.');
      assert.equal(broken.hidden, true);
    }
  });

  await t.test('refreshes an expired URL once and restores the exact playhead', async () => {
    let count = 0;
    answers.set('refresh', () => response(media('refresh', 'audio', '-' + ++count)));
    await open('refresh');
    metadata(audio, 120);
    audio.currentTime = 42;
    await player.togglePlay();
    const play = audio.play;
    audio.play = async () => {
      if (audio.src.endsWith('-1')) {
        audio.error = { code: 2 };
        throw new DOMException('Expired URL', 'NotSupportedError');
      }
      return play.call(audio);
    };
    try {
      await player.togglePlay();
      await settle();
    } finally {
      audio.play = play;
    }
    assert.equal(audio.src, media('refresh', 'audio', '-2').url);
    metadata(audio, 120);
    assert.equal(audio.currentTime, 42);
    assert.equal(audio.paused, false);
    audio.error = { code: 2 };
    audio.emit('error');
    await settle();
    assert.equal(count, 2);
    assert.equal(source.textContent, 'This file could not be opened.');
    assert.equal(broken.hidden, true);
  });

  await t.test('an audio decode error can force conversion while play is still pending', async () => {
    const name = 'pending-decoder';
    answers.set(name, ({ body }) => {
      const { convert } = JSON.parse(body);
      return response({ ...media(name, 'audio', convert ? '-converted' : ''), converted: !!convert });
    });
    const initial = Promise.withResolvers();
    const fakePlay = audio.play.bind(audio);
    let attempts = 0;
    audio.play = () => (++attempts === 1 ? initial.promise : fakePlay());
    const pending = open(name);
    try {
      await settle();
      audio.error = { code: 3 };
      audio.emit('error');
      await settle();
      assert.equal(audio.src, media(name, 'audio', '-converted').url);
      assert.equal(audio.paused, false);
      assert.deepEqual(opens.filter(({ id }) => id === name).map(({ convert }) => convert), [undefined, true]);
    } finally {
      initial.reject(new DOMException('Unsupported file', 'NotSupportedError'));
      await pending;
      audio.play = fakePlay;
    }
    assert.equal(audio.paused, false);
  });

  await t.test('forces conversion on a mid-file decoder error and restores the playhead once', async () => {
    let count = 0;
    answers.set('late-format', ({ body }) => response({
      ...media('late-format', 'audio', '-' + ++count), ...(JSON.parse(body).convert && { converted: true }),
    }));
    await open('late-format');
    metadata(audio, 120);
    audio.currentTime = 45;
    audio.error = { code: 4 };
    const play = audio.play;
    audio.play = async () => {
      metadata(audio, 120);
      assert.equal(audio.currentTime, 45);
      return play.call(audio);
    };
    try {
      audio.emit('error');
      await settle();
    } finally {
      audio.play = play;
    }
    assert.equal(count, 2);
    assert.equal(audio.src, media('late-format', 'audio', '-2').url);
    assert.equal(audio.paused, false);
    assert.equal(opens.at(-1).convert, true);
    audio.error = { code: 4 };
    audio.emit('error');
    assert.equal(source.textContent, 'This format cannot be played yet.');
    assert.equal(count, 2);
  });

  await t.test('a failed reopen skips after two seconds and three failed tracks stop', async () => {
    const entries = ['late-1', 'late-2', 'late-3', 'late-4'].map((id) => entry(id));
    for (const { id } of entries) {
      let count = 0;
      answers.set(id, () => ++count === 1
        ? response(media(id)) : response(null, 404, { code: 'COMPUTER_FILE_GONE' }));
    }
    await playComputerEntries(entries, 0);
    for (const [index, { id }] of entries.slice(0, 3).entries()) {
      assert.equal(currentId(), 'computer:' + id);
      assert.equal(audio.paused, false);
      audio.error = { code: 2 };
      audio.emit('error');
      await settle();
      assert.equal(source.textContent, 'That file is no longer there.');
      await advanceClock(1_999);
      assert.equal(currentId(), 'computer:' + id);
      await advanceClock(1);
      assert.equal(currentId(), 'computer:' + entries[Math.min(index + 1, 2)].id);
    }
    assert.equal(opens.some(({ id }) => id === 'late-4'), false);
  });

  await t.test('pausing during a pending reopen leaves the replacement paused', async () => {
    const reopen = Promise.withResolvers();
    let count = 0;
    answers.set('pause-reopen', () => ++count === 1 ? response(media('pause-reopen')) : reopen.promise);
    await open('pause-reopen');
    metadata(audio, 120);
    audio.currentTime = 37;
    audio.error = { code: 2 };
    audio.emit('error');
    await settle();
    assert.equal(count, 2);
    mediaActions.get('pause')();
    reopen.resolve(response(media('pause-reopen', 'audio', '-new')));
    await settle();
    metadata(audio, 120);
    assert.equal(audio.src, media('pause-reopen', 'audio', '-new').url);
    assert.equal(audio.currentTime, 37);
    assert.equal(audio.paused, true);
    assert.equal(state.isPlaying, false);
    await player.togglePlay();
    assert.equal(audio.paused, false);
    assert.equal(count, 2);
  });

  await t.test('autoplay refusal leaves a playable file attached and does not count as failure', async () => {
    audio.playError = new DOMException('User gesture required', 'NotAllowedError');
    try {
      await playComputerEntries([entry('autoplay'), entry('one')], 0);
    } finally {
      audio.playError = null;
    }
    assert.equal(source.textContent, 'Press Play to start.');
    assert.equal(computerQueueState().failures, 0);
    assert.equal(audio.src, media('autoplay').url);
    assert.equal(audio.paused, true);
    assert.equal(elements['player-play'].disabled, false);
    await advanceClock(4_000);
    assert.equal(currentId(), 'computer:autoplay');
    const count = opens.length;
    await player.togglePlay();
    assert.equal(audio.paused, false);
    assert.equal(opens.length, count);
    assert.equal(source.textContent, 'An Artist \u00b7 An Album');
  });

  await t.test('the playback action count moves for same-item play, pause, resume and stop', async () => {
    let count = player.getPlaybackActionCount();
    const check = () => {
      assert.ok(player.getPlaybackActionCount() > count);
      count = player.getPlaybackActionCount();
    };
    await open('counted');
    check();
    await open('counted');
    check();
    await player.togglePlay();
    check();
    await player.togglePlay();
    check();
    player.stop();
    check();
  });

  await t.test('next, previous, automatic advance, shuffle and queue ends', async () => {
    const entries = ['one', 'two', 'three'].map((id) => entry(id));
    await playComputerEntries(entries, 0);
    assert.equal(previous.disabled, true);
    assert.equal(next.disabled, false);
    assert.equal(previous.getAttribute('aria-label'), 'Previous');
    assert.equal(next.getAttribute('aria-label'), 'Next');
    metadata(audio, 120);
    let previousDisabled = previous.disabled;
    const previousUpdates = t.mock.fn((disabled) => { previousDisabled = disabled; });
    Object.defineProperty(previous, 'disabled', {
      configurable: true,
      get: () => previousDisabled,
      set: previousUpdates,
    });
    audio.currentTime = 3;
    audio.emit('timeupdate');
    assert.equal(previous.disabled, true);
    assert.equal(previousUpdates.mock.callCount(), 0);
    audio.currentTime = 3.01;
    audio.emit('timeupdate');
    audio.emit('timeupdate');
    assert.equal(previous.disabled, false);
    assert.equal(previousUpdates.mock.callCount(), 1);
    click(previous);
    assert.equal(audio.currentTime, 0);
    assert.equal(currentId(), 'computer:one');
    assert.equal(previous.disabled, true);
    Object.defineProperty(previous, 'disabled', { configurable: true, writable: true, value: previousDisabled });
    click(next);
    await settle();
    assert.equal(currentId(), 'computer:two');
    metadata(audio, 120);
    audio.currentTime = 3.01;
    click(previous);
    assert.equal(audio.currentTime, 0);
    assert.equal(currentId(), 'computer:two');
    audio.currentTime = 3;
    click(previous);
    await settle();
    assert.equal(currentId(), 'computer:one');
    ended(audio);
    await settle();
    assert.equal(currentId(), 'computer:two');
    ended(audio);
    await settle();
    assert.equal(currentId(), 'computer:three');
    assert.equal(next.disabled, true);
    ended(audio);
    await settle();
    assert.equal(currentId(), 'computer:three');
    assert.equal(state.isPlaying, false);
    const start = opens.length;
    await playComputerEntries(entries, 1, { shuffle: true, random: () => 0 });
    ended(audio);
    await settle();
    ended(audio);
    await settle();
    assert.deepEqual(opens.slice(start).map(({ id }) => id), ['two', 'three', 'one']);
    await open('outside-queue');
    assert.equal(next.hidden, true);
    assert.equal(previous.hidden, true);
    assert.equal(previous.getAttribute('aria-label'), 'Previous part', 'updated when leaving local playback');
  });

  await t.test('sleep stops both natural advance and pending failure skips', async () => {
    const entries = ['one', 'two'].map((id) => entry(id));
    await playComputerEntries(entries, 0);
    state.sleepTimer.until = Date.now();
    ended(audio);
    await settle();
    assert.equal(currentId(), 'computer:one');
    state.sleepTimer.until = null;
    await playComputerEntries([entry('gone'), ...entries], 0);
    emit('sleep-fired');
    await advanceClock(2_000);
    assert.equal(currentId(), 'computer:gone');
    assert.equal(source.textContent, 'That file is no longer there.');
  });

  await t.test('waits two seconds between failed starts, stops after three and cancels on Stop', async () => {
    await playComputerEntries(['gone', 'other', 'other', 'one'].map((id) => entry(id)), 0);
    await advanceClock(1_999);
    assert.equal(currentId(), 'computer:gone');
    await advanceClock(1);
    assert.equal(currentId(), 'computer:other');
    assert.equal(computerQueueState().index, 1);
    await advanceClock(2_000);
    assert.equal(currentId(), 'computer:other');
    await advanceClock(5_000);
    assert.equal(currentId(), 'computer:other');
    assert.equal(source.textContent, 'This file could not be opened.');
    assert.equal(computerQueueState().index, 2);
    await playComputerEntries([entry('gone'), entry('one')], 0);
    player.stop();
    await advanceClock(2_000);
    assert.equal(player.getCurrentItem(), null);
  });

  await t.test('folder and approval refusals hold the queue by code', async () => {
    for (const code of ['COMPUTER_FOLDER_OFFLINE', 'COMPUTER_ENTRY_NOT_FOUND']) {
      const refused = entry('queue-' + code);
      answers.set(refused.id, () => response(null, 409, { code, message: 'Different server wording.' }));
      player.stop();
      await playComputerEntries([refused, entry('one')], 0);
      const count = opens.length;
      await advanceClock(5_000);
      assert.equal(opens.length, count);
      assert.equal(currentId(), 'computer:' + refused.id);
      assert.equal(computerQueueState().index, 0);
      assert.equal(computerQueueState().failures, 0);
      assert.equal(source.textContent, code === 'COMPUTER_FOLDER_OFFLINE'
        ? 'That folder is not connected.' : 'That file is not in the library.');
    }
  });

  await t.test('saves long-file progress periodically, on pause, seek, switch, pagehide and Stop', async () => {
    await open('long');
    metadata(audio, 1_400);
    audio.currentTime = 100;
    audio.emit('timeupdate');
    assert.equal(readPartResume(currentId()).position, 100);
    await advanceClock(14_999);
    audio.currentTime = 112;
    audio.emit('timeupdate');
    assert.equal(readPartResume(currentId()).position, 100);
    await advanceClock(1);
    audio.emit('timeupdate');
    assert.equal(readPartResume(currentId()).position, 112);
    audio.currentTime = 130;
    await player.togglePlay();
    assert.equal(readPartResume(currentId()).position, 130);
    audio.currentTime = 140;
    audio.emit('seeked');
    assert.equal(readPartResume(currentId()).position, 140);
    audio.currentTime = 141;
    window.dispatchEvent(new Event('pagehide'));
    assert.equal(readPartResume(currentId()).position, 141);
    await settle();
    assert.ok(requests.includes(media('long').url + '/release'));
    assert.equal(audio.src, '');
    audio.currentTime = 142;
    await open('one');
    assert.equal(readPartResume('computer:long').position, 141);
    await open('long');
    metadata(audio, 1_400);
    assert.equal(audio.currentTime, 138);
    audio.currentTime = 260;
    player.stop();
    assert.equal(readPartResume('computer:long').position, 260);
    await open('long');
    metadata(audio, 1_400);
    assert.equal(audio.currentTime, 257);
    ended(audio);
    assert.equal(readPartResume('computer:long'), null);
  });

  await t.test('resumes from server duration before playback and saves with an unknown element length', async () => {
    for (const [event, duration] of [['loadedmetadata', Infinity], ['durationchange', NaN], ['canplay', Infinity]]) {
      const id = 'unknown-' + event;
      answers.set(id, () => response({ ...media(id), duration: 2_000 }));
      await open(id);
      audio.duration = duration;
      audio.currentTime = 75;
      audio.emit('timeupdate');
      assert.equal(readPartResume(currentId()).position, 75);
      player.stop();

      const play = audio.play;
      audio.play = async () => {
        audio.duration = duration;
        if (event === 'canplay') {
          audio.seekable = { length: 0 };
          audio.emit('loadedmetadata');
          assert.equal(audio.currentTime, 0);
        }
        audio.seekable = { length: 1, start: () => 0, end: () => 2_000 };
        audio.emit(event);
        assert.equal(audio.currentTime, 72);
        return play.call(audio);
      };
      try { await open(id); }
      finally {
        audio.play = play;
        delete audio.seekable;
      }
      audio.currentTime = 125;
      player.stop();
      assert.equal(readPartResume('computer:' + id).position, 125);
    }
  });

  await t.test('uses strict duration thresholds and treats near-end bookmarks as finished', async () => {
    for (const [id, kind, el, duration, position, resume] of [
      ['short-audio', 'audio', audio, 1_200, 200, 0],
      ['short-video', 'video', video, 600, 200, 0],
      ['long-video', 'video', video, 601, 300, 297],
      ['last30', 'video', video, 601, 571, 0],
      ['past97', 'audio', audio, 2_000, 1_945, 0],
      ['at97', 'audio', audio, 2_000, 1_940, 1_937],
    ]) {
      answers.set(id, () => response(media(id, kind)));
      await open(id, { kind });
      metadata(el, duration);
      el.currentTime = position;
      player.stop();
      await open(id, { kind });
      metadata(el, duration);
      assert.equal(el.currentTime, resume, id);
      if (!resume) assert.equal(readPartResume(currentId()), null);
    }
  });

  await t.test('explicit starts override bookmarks, including zero, and apply only to the first queue entry', async () => {
    const entries = ['explicit', 'following'].map((id) => entry(id, { duration: 2000 }));
    for (const { id } of entries) {
      answers.set(id, () => response({ ...media(id), duration: 2000 }));
      await open(id);
      metadata(audio, 2000);
      audio.currentTime = 400;
      player.stop();
    }

    await playComputerEntries(entries, 0, { startAt: 124.5 });
    metadata(audio, 2000);
    assert.equal(audio.currentTime, 124.5);
    click(next);
    await settle();
    metadata(audio, 2000);
    assert.equal(audio.currentTime, 397);
    await playComputerEntries([entries[0]], 0, { startAt: 0 });
    metadata(audio, 2000);
    assert.equal(audio.currentTime, 0);
  });

  await t.test('the bar retries an explicit chapter or zero after a failed open', async () => {
    for (const startAt of [41.5, 0]) {
      const id = 'retry-' + startAt;
      const entries = [entry(id, { duration: 2000 })];
      answers.set(id, () => response({ ...media(id), duration: 2000 }));
      await playComputerEntries(entries, 0);
      metadata(audio, 2000);
      audio.currentTime = 400;
      player.stop();

      answers.set(id, () => response(null, 404, { code: 'COMPUTER_FILE_GONE' }));
      await playComputerEntries(entries, 0, { startAt });
      assert.equal(source.textContent, 'That file is no longer there.');
      answers.set(id, () => response({ ...media(id), duration: 2000 }));
      click(elements['player-play']);
      await settle();
      metadata(audio, 2000);
      assert.equal(audio.currentTime, startAt);
      audio.currentTime = 200;
      player.stop();
    }
  });

  await t.test('only visible, advancing video with no decoded frames falls back to conversion', async () => {
    const videoEntry = movie('no-frames', { ext: 'mp4', vcodec: 'hevc', width: 1920, acodec: 'aac' });
    let frames = 0;
    answers.set(videoEntry.id, ({ body }) => response(JSON.parse(body).convert
      ? hlsMedia(videoEntry) : { ...media(videoEntry.id, 'video'), entry: videoEntry }));
    const setVisibility = (value) => {
      document.visibilityState = value;
      visibilityEvents.dispatchEvent(new Event('visibilitychange'));
    };
    const timeUpdate = (seconds) => { video.currentTime = seconds; video.emit('timeupdate'); };
    await open(videoEntry.id, videoEntry);
    timeUpdate(10);
    assert.equal(video.paused, false, 'missing playback-quality API');
    video.getVideoPlaybackQuality = () => ({ totalVideoFrames: frames });
    try {
      await open(videoEntry.id, videoEntry);
      frames = 1;
      video.videoWidth = 0;
      timeUpdate(4);
      assert.equal(video.paused, false, 'decoded frames work even with videoWidth zero');

      frames = 0;
      video.videoWidth = 1920;
      const noStream = entry('sound-only', { kind: 'video', width: 1920 });
      answers.set(noStream.id, () => response({ ...media(noStream.id, 'video'), entry: noStream }));
      await open(noStream.id, noStream);
      timeUpdate(4);
      assert.equal(video.paused, false, 'the fresh row has no video codec');

      await playComputerEntries([videoEntry, entry('after-no-frames')], 0);
      setVisibility('hidden');
      timeUpdate(10);
      video.currentTime = 20;
      setVisibility('visible');
      await player.togglePlay();
      timeUpdate(30);
      assert.equal(computerQueueState().failures, 0);
      await player.togglePlay();
      video.emit('seeking');
      timeUpdate(40);
      video.emit('seeked');
      timeUpdate(42.9);
      assert.equal(video.paused, false);
      timeUpdate(43);
      await settle();
      assert.equal(opens.at(-1).convert, true);
      assert.equal(activeHls().config.startPosition, 43, 'three seconds with no frames triggers a single conversion');
      assert.equal(currentId(), 'computer:no-frames');
      frame(43);
      timeUpdate(50);
      assert.equal(video.paused, false);
      assert.equal(opens.filter(({ id, convert }) => id === videoEntry.id && convert).length, 1);
      assert.equal(computerQueueState().failures, 0);
    } finally {
      setVisibility('visible');
      delete video.getVideoPlaybackQuality;
      video.videoWidth = 1920;
    }
  });

  await t.test('converted video starts at saved time with a full seek bar and same-origin playback', async () => {
    const file = movie('converted-resume');
    answers.set(file.id, () => response(hlsMedia(file)));
    storage.set(PART_RESUME_KEY, JSON.stringify([{ id: 'computer:' + file.id, partKey: 'file', position: 141 }]));
    const requestIndex = requests.length;
    await playComputerEntries([file], 0);

    const hls = activeHls();
    const seek = elements['player-seek'];
    assert.equal(hls.url, hlsMedia(file).url);
    assert.equal(hls.video, video);
    assert.deepEqual(requests.slice(requestIndex).filter((path) => path.startsWith('/api/v1/media/')), []);
    assert.equal(video.crossOrigin, 'anonymous');
    assert.equal(video.hidden, false);
    assert.equal(mediaSession.metadata.title, file.title);
    assert.equal(player.isComputerPlaybackConverted(currentId()), true);
    assert.equal(player.getCurrentItem().stream_url, 'computer:' + file.id);
    assert.equal(player.getCurrentItem()._extra.computer.format, '480p \u00b7 MPEG-2 \u00b7 AC-3 5.1');
    const { config } = hls;
    assert.equal(config.startPosition, 138);
    hls.loadManifest();
    assert.equal(hls.firstFragment, 23);
    assert.equal(video.currentTime, 0, 'startup is positioned through hls.js');
    assert.equal(released(file.id), 0);
    assert.equal(config.maxBufferLength, 30);
    assert.equal(config.maxMaxBufferLength, 60);
    assert.equal(config.backBufferLength, 30);
    assert.equal(config.lowLatencyMode, false);
    assert.equal(config.maxFragLookUpTolerance, 0);
    const fragmentLoader = new config.fLoader();
    fragmentLoader.load({}, { loadPolicy: config.fragLoadPolicy.default }, {});
    assert.equal(config.fragLoadPolicy.default.errorRetry, null, 'the XHR loader owns fragment retries');
    for (const policy of [config.manifestLoadPolicy.default, config.playlistLoadPolicy.default, fragmentLoader.config.loadPolicy]) {
      const { errorRetry } = policy;
      assert.equal(errorRetry.maxNumRetry, 5);
      assert.equal(errorRetry.retryDelayMs, 400);
      assert.equal(errorRetry.shouldRetry(errorRetry, 0, false, { code: 503 }, true), true);
      for (const code of [404, 410, 416, 500]) {
        assert.equal(errorRetry.shouldRetry(errorRetry, 0, false, { code }, true), false);
      }
      assert.equal(errorRetry.shouldRetry(errorRetry, 5, false, { code: 503 }, false), false);
    }
    assert.equal(config.fragLoadPolicy.default.maxTimeToFirstByteMs, 40_000);
    assert.equal(config.fragLoadPolicy.default.maxLoadTimeMs, 40_000);
    assert.equal(seek.disabled, false);
    assert.equal(seek.max, '1200');
    assert.equal(seek.value, '138');
    assert.equal(elements['player-dur'].textContent, '20:00');
    assert.equal(source.textContent, 'Preparing...');
    frame(138, 1_199);
    assert.equal(seek.max, '1199');
    assert.equal(source.textContent, 'Video');

    seekTo(145);
    assert.equal(source.textContent, 'Video', 'seeks within the buffer do not show Preparing');
    seekTo(800);
    video.seeking = true;
    video.readyState = 1;
    video.emit('seeking');
    assert.equal(source.textContent, 'Preparing...');
    assert.deepEqual(hls.loads, [800]);
    video.emit('waiting');
    video.emit('canplay');
    assert.equal(source.textContent, 'Preparing...', 'old frames do not clear the status');
    frame(800, 1_199);
    video.emit('seeked');
    assert.equal(source.textContent, 'Video');
    video.currentTime = 813;
    video.emit('timeupdate');
    player.stop();
    assert.equal(hls.destroyed, true);
    assert.equal(readPartResume('computer:' + file.id).position, 813);
    await settle();
    assert.deepEqual(releases.filter(({ token }) => token === file.id), [{
      token: file.id, method: 'POST', keepalive: true, header: 'computer-player',
    }]);
    await advanceClock(45_000);
    assert.equal(player.isComputerPlaybackConverted('computer:' + file.id), false);
  });

  await t.test('retargets the first fragment and releases pending playback on switch and pagehide', async () => {
    const file = movie('early-seek');
    let count = 0;
    answers.set(file.id, () => response(hlsMedia(file, file.id + '-' + ++count)));
    await playComputerEntries([file], 0, { startAt: 21 });
    const hls = activeHls();
    assert.equal(hls.config.startPosition, 21);
    seekTo(301);
    assert.equal(hls.config.startPosition, 301);
    assert.equal(video.currentTime, 0);
    hls.loadManifest();
    assert.equal(hls.firstFragment, 50);
    await open('one');
    assert.equal(hls.destroyed, true);
    assert.equal(released(file.id + '-1'), 1);
    assert.equal(player.isComputerPlaybackConverted('computer:' + file.id), false);
    await advanceClock(45_000);
    assert.equal(currentId(), 'computer:one');

    await player.playItem(makeComputerItem(file), { startAt: 111 });
    const pageHls = activeHls();
    const pagehide = new Event('pagehide');
    Object.defineProperty(pagehide, 'persisted', { value: true });
    window.dispatchEvent(pagehide);
    assert.equal(pageHls.destroyed, true);
    assert.equal(player.isComputerPlaybackConverted(currentId()), false);
    await advanceClock(45_000);
    assert.equal(released(file.id + '-2'), 1);
    assert.equal(elements['player-play'].disabled, false);
    await player.togglePlay();
    assert.equal(activeHls().config.startPosition, 111);
    assert.equal(released(file.id + '-3'), 0);
    window.dispatchEvent(new Event('pagehide'));
    await settle();
    assert.equal(activeHls().destroyed, true);
    assert.equal(released(file.id + '-3'), 1);
  });

  await t.test('410 refreshes a playlist or segment once per minute and keeps the current target', async () => {
    for (const details of ['manifestLoadError', 'fragLoadError']) {
      const file = movie('expired-' + details);
      let count = 0;
      answers.set(file.id, () => response(hlsMedia(file, file.id + '-' + ++count)));
      await playComputerEntries([file], 0, { startAt: 81 });
      const first = activeHls();
      if (details === 'fragLoadError') {
        frame(81);
        video.currentTime = 120;
      }
      expired(details);
      await settle();
      assert.equal(first.destroyed, true);
      assert.equal(activeHls().url, hlsMedia(file, file.id + '-2').url);
      const position = details === 'manifestLoadError' ? 81 : 120;
      assert.equal(activeHls().config.startPosition, position);
      frame(position);
      assert.equal(activeHls().firstFragment, Math.floor(position / 6));
      assert.equal(released(file.id + '-1'), 1);
      assert.equal(released(file.id + '-2'), 0);
      await advanceClock(60_000);
      expired(details);
      await settle();
      assert.equal(count, 3);
      assert.equal(released(file.id + '-2'), 1);
      assert.equal(released(file.id + '-3'), 0);
      expired(details);
      await settle();
      assert.equal(count, 3);
      assert.equal(activeHls().destroyed, true);
      assert.equal(released(file.id + '-3'), 1);
      assert.equal(source.textContent, 'This play link has expired.');
      assert.equal(computerQueueState().failures, 1);
    }
  });

  await t.test('a recovered HLS session cannot refresh a second time within a minute', async () => {
    const file = movie('refresh-rate-limit');
    let count = 0;
    answers.set(file.id, () => response(hlsMedia(file, file.id + '-' + ++count)));
    await playComputerEntries([file], 0);
    expired('manifestLoadError');
    await settle();
    frame(0);
    await advanceClock(59_999);
    expired('fragLoadError');
    await settle();
    assert.equal(count, 2);
    assert.equal(source.textContent, 'This play link has expired.');
    assert.equal(computerQueueState().failures, 1);
  });

  await t.test('a failed HLS refresh displays the play-route message and respects retryable', async () => {
    for (const retryable of [true, false]) {
      const file = movie('failed-refresh-' + retryable);
      let count = 0;
      answers.set(file.id, () => ++count === 1 ? response(hlsMedia(file)) : response(null, 503, {
        code: 'COMPUTER_CONVERT_FFMPEG', message: 'Install FFmpeg in Settings to play this format.', retryable,
      }));
      await playComputerEntries([file, entry('after-refresh')], 0, { startAt: 35 });
      expired('manifestLoadError');
      await settle();
      assert.equal(count, 2);
      assert.equal(source.textContent, 'Install FFmpeg in Settings to play this format.');
      assert.equal(computerQueueState().failures, retryable ? 0 : 1);
      await advanceClock(2_000);
      assert.equal(currentId(), 'computer:' + (retryable ? file.id : 'after-refresh'));
      if (retryable) {
        answers.set(file.id, () => response(hlsMedia(file, 'manual-retry')));
        click(elements['player-play']);
        await settle();
        assert.equal(activeHls().config.startPosition, 35);
      }
    }
  });

  await t.test('two fatal media errors fail the converted track and the queue stops after three failures', async () => {
    const files = ['fatal-first', 'fatal-second', 'fatal-third'].map((id) => movie(id));
    for (const file of files) answers.set(file.id, () => response(hlsMedia(file)));
    await playComputerEntries([...files, entry('never-reached')], 0);
    const fatal = { type: FakeHls.ErrorTypes.MEDIA_ERROR, fatal: true };
    for (const [index, file] of files.entries()) {
      const first = activeHls();
      frame(0);
      video.currentTime = 25;
      first.error(fatal);
      await settle();
      assert.equal(first.destroyed, true);
      assert.equal(activeHls().url, first.url);
      assert.equal(activeHls().config.startPosition, 25);
      assert.equal(opens.filter(({ id }) => id === file.id).length, 1);
      assert.equal(computerQueueState().failures, index);
      assert.equal(released(file.id), 0, 'the rebuilt player keeps its server conversion');
      first.error(fatal);
      await settle();
      assert.equal(computerQueueState().failures, index, 'stale callbacks cannot fail the replacement');
      activeHls().error(fatal);
      await settle();
      assert.equal(source.textContent, 'This file could not be opened.');
      assert.equal(activeHls().destroyed, true);
      assert.equal(released(file.id), 1);
      assert.equal(computerQueueState().failures, index + 1);
      await advanceClock(1_999);
      assert.equal(currentId(), 'computer:' + file.id);
      await advanceClock(1);
    }
    assert.equal(currentId(), 'computer:fatal-third');
  });

  await t.test('503 keeps the HLS session until its retries are exhausted', async () => {
    const file = movie('exhausted-503');
    answers.set(file.id, () => response(hlsMedia(file)));
    await playComputerEntries([file], 0);
    const hls = activeHls();
    httpError(503, 'fragLoadError');
    await settle();
    assert.equal(hls.destroyed, false);
    assert.equal(released(file.id), 0);
    assert.equal(computerQueueState().failures, 0);
    httpError(503, 'fragLoadError', { fatal: true });
    await settle();
    assert.equal(hls.destroyed, true);
    assert.equal(released(file.id), 1);
    assert.equal(source.textContent, 'This file could not be opened.');
    assert.equal(opens.filter(({ id }) => id === file.id).length, 1);
    assert.equal(computerQueueState().failures, 1);
  });

  await t.test('404 and 500 fail immediately, using the 500 message when supplied', async () => {
    for (const [status, error, message] of [
      [404, { message: 'That file is no longer there.' }, 'That file is no longer there.'],
      [500, { code: 'COMPUTER_CONVERT_FAILED', message: 'There is not enough disk space to prepare this file.' },
        'There is not enough disk space to prepare this file.'],
      [500, { code: 'COMPUTER_CONVERT_FAILED' }, 'This file could not be converted.'],
    ]) {
      const file = movie('failed-http-' + status + '-' + Boolean(error.message));
      answers.set(file.id, () => response(hlsMedia(file)));
      await playComputerEntries([file], 0);
      const hls = activeHls();
      httpError(status, 'fragLoadError', { error });
      await settle();
      assert.equal(hls.destroyed, true);
      assert.equal(released(file.id), 1);
      assert.equal(source.textContent, message);
      assert.equal(opens.filter(({ id }) => id === file.id).length, 1);
      assert.equal(computerQueueState().failures, 1);
      assert.equal(player.isComputerPlaybackConverted(currentId()), false);
    }
  });

  await t.test('416 lets the buffered ending play before clearing the bookmark and advancing', async () => {
    for (const status of [416, null]) {
      const file = movie('last-segment-' + status);
      const id = 'computer:' + file.id;
      answers.set(file.id, () => response(hlsMedia(file)));
      storage.set(PART_RESUME_KEY, JSON.stringify([{ id, partKey: 'file', position: 913 }]));
      await playComputerEntries([file, entry('after-last-segment')], 0);
      const hls = activeHls();
      frame(910);
      assert.equal(hls.firstFragment, 151);
      assert.equal(readPartResume(id).position, 913);
      if (status) {
        seekTo(915);
        httpError(status, 'fragLoadError');
        await settle();
        assert.equal(hls.stopLoads, 1);
        assert.equal(released(file.id), 0);
        assert.equal(video.paused, false);
        assert.equal(currentId(), id);
        assert.equal(source.textContent, 'Video');

        video.emit('seeking');
        httpError(416, 'fragLoadError');
        await advanceClock(45_000);
        assert.equal(hls.stopLoads, 1);
        assert.deepEqual(hls.loads, []);
        assert.equal(currentId(), id);
        assert.equal(source.textContent, 'Video');
        assert.equal(broken.hidden, true);
        video.emit('seeked');

        video.currentTime = 934;
        video.emit('timeupdate');
        assert.equal(currentId(), id);
        video.currentTime = 934.8;
        video.emit('timeupdate');
      } else ended(video);
      await settle();
      assert.equal(currentId(), 'computer:after-last-segment');
      assert.equal(computerQueueState().failures, 0);
      assert.equal(readPartResume(id), null);
      assert.equal(hls.destroyed, true);
      assert.equal(released(file.id), 1);
      assert.equal(opens.filter((request) => request.id === file.id).length, 1);
    }
  });

  await t.test('416 waits for Play when the user paused during the buffered ending', async () => {
    const file = movie('paused-416', { duration_estimated: true });
    answers.set(file.id, () => response(hlsMedia(file)));
    await playComputerEntries([file, entry('after-paused-416')], 0, { startAt: 997 });
    frame(997, 1_200);
    await player.togglePlay();
    httpError(416, 'fragLoadError');
    await settle();
    assert.equal(activeHls().stopLoads, 1);
    assert.equal(video.paused, true);
    assert.equal(source.textContent, 'Video');
    assert.equal(currentId(), 'computer:' + file.id);
    assert.equal(released(file.id), 0);

    await player.togglePlay();
    assert.equal(video.paused, false);
    assert.equal(currentId(), 'computer:' + file.id);
    assert.equal(opens.filter(({ id }) => id === file.id).length, 1);
    video.currentTime = 1_022;
    video.emit('timeupdate');
    await settle();
    assert.equal(currentId(), 'computer:after-paused-416');
    assert.equal(released(file.id), 1);
  });

  await t.test('416 for an unbuffered seek target finishes without waiting for the seek', async () => {
    const file = movie('seek-416', { duration_estimated: true });
    answers.set(file.id, () => response(hlsMedia(file)));
    await playComputerEntries([file, entry('after-seek-416')], 0, { startAt: 997 });
    frame(997, 1_200);
    const hls = activeHls();
    seekTo(1_180);
    video.readyState = 1;
    video.emit('seeking');
    assert.equal(source.textContent, 'Preparing...');
    assert.deepEqual(hls.loads, [1_180]);
    httpError(416, 'fragLoadError');
    await settle();
    assert.equal(currentId(), 'computer:after-seek-416');
    assert.equal(hls.stopLoads, 1);
    assert.equal(hls.destroyed, true);
    assert.equal(released(file.id), 1);
    assert.equal(broken.hidden, true);
    await advanceClock(45_000);
    assert.equal(computerQueueState().failures, 0);
  });

  await t.test('410 after pause fails without opening a fresh server session', async () => {
    const file = movie('paused-410');
    answers.set(file.id, () => response(hlsMedia(file)));
    await playComputerEntries([file, entry('after-paused')], 0);
    frame(0);
    await player.togglePlay();
    expired('fragLoadError');
    await advanceClock(2_000);
    assert.equal(currentId(), 'computer:' + file.id);
    assert.equal(opens.filter(({ id }) => id === file.id).length, 1);
    assert.equal(released(file.id), 1);
  });

  await t.test('stopping a 410 refresh releases a late play reply without attaching it', async () => {
    const file = movie('late-refresh');
    answers.set(file.id, () => response(hlsMedia(file, 'before-late-refresh')));
    await playComputerEntries([file], 0);
    const first = activeHls();
    let finish;
    answers.set(file.id, () => new Promise((resolve) => { finish = resolve; }));
    expired('fragLoadError');
    await settle();
    player.stop();
    assert.equal(opens.at(-1).signal.aborted, true);
    finish(response(hlsMedia(file, 'late-refresh-reply')));
    await settle();
    assert.equal(activeHls(), first);
    assert.equal(first.destroyed, true);
    assert.equal(released('before-late-refresh'), 1);
    assert.equal(released('late-refresh-reply'), 1);
  });

  await t.test('a converted seek times out and Play retries at the target', async () => {
    const file = movie('seek-timeout');
    const id = 'computer:' + file.id;
    answers.set(file.id, () => response(hlsMedia(file)));
    await playComputerEntries([file], 0);
    const first = activeHls();
    frame(0);
    video.currentTime = 150;
    video.emit('timeupdate');
    seekTo(491);
    video.seeking = true;
    video.readyState = 1;
    video.emit('seeking');
    await advanceClock(44_999);
    assert.equal(source.textContent, 'Preparing...');
    assert.equal(released(file.id), 0);
    // A buffered frame elsewhere cannot land this seek.
    frame(150);
    await advanceClock(1);
    assert.equal(source.textContent, 'This file could not be prepared in time.');
    assert.equal(player.isComputerPlaybackConverted(id), false);
    assert.equal(first.destroyed, true);
    assert.equal(released(file.id), 1);
    assert.equal(readPartResume(id).position, 150);

    let finish;
    answers.set(file.id, () => new Promise((resolve) => { finish = resolve; }));
    click(elements['player-play']);
    await settle();
    assert.equal(player.isComputerPlaybackConverted(id), false);
    finish(response(hlsMedia(file, 'seek-retry')));
    await settle();
    const retry = activeHls();
    assert.notEqual(retry, first);
    assert.equal(player.isComputerPlaybackConverted(id), true);
    assert.equal(retry.config.startPosition, 491);
    frame(491);
    assert.equal(retry.firstFragment, 81);
    assert.equal(source.textContent, 'Video');
    await advanceClock(45_000);
    video.currentTime = 512;
    video.emit('timeupdate');
    assert.equal(readPartResume(id).position, 512);
    assert.equal(retry.destroyed, false);
    assert.equal(released('seek-retry'), 0);

    // Even a buffered seek must land. Stopping clears its pending deadline.
    seekTo(495);
    assert.equal(source.textContent, 'Video');
    player.stop();
    await advanceClock(45_000);
    assert.equal(released('seek-retry'), 1);
    assert.equal(currentId(), undefined);
    assert.equal(source.textContent, '');
  });

  await t.test('retargeting a seek gives the new target its own deadline, even inside the buffer', async () => {
    const file = movie('retarget-seek-deadline');
    answers.set(file.id, () => response(hlsMedia(file)));
    await playComputerEntries([file], 0, { startAt: 100 });
    frame(100);
    seekTo(380);
    await advanceClock(30_000);
    seekTo(110);
    video.seeking = true;
    assert.equal(source.textContent, 'Video');
    await advanceClock(15_000);
    video.emit('seeking');
    await advanceClock(29_999);
    assert.equal(activeHls().destroyed, false);
    await advanceClock(1);
    assert.equal(source.textContent, 'This file could not be prepared in time.');
    assert.equal(released(file.id), 1);
  });

  await t.test('a 410 refresh keeps the 45-second deadline for the original seek', async () => {
    const file = movie('seek-refresh-deadline');
    let count = 0;
    answers.set(file.id, () => response(hlsMedia(file, file.id + '-' + ++count)));
    await playComputerEntries([file], 0);
    frame(0);
    seekTo(184);
    await advanceClock(30_000);
    expired('fragLoadError');
    await settle();
    assert.equal(activeHls().config.startPosition, 184);
    await advanceClock(14_999);
    assert.equal(source.textContent, 'Preparing...');
    await advanceClock(1);
    assert.equal(source.textContent, 'This file could not be prepared in time.');
    assert.equal(released(file.id + '-1'), 1);
    assert.equal(released(file.id + '-2'), 1);
  });

  await t.test('a native video decode or unsupported error forces conversion once at the same position', async () => {
    for (const code of [3, 4]) {
      const file = movie('fallback-' + code, { ext: 'mp4', vcodec: 'h264', acodec: 'aac' });
      answers.set(file.id, ({ body }) => response(JSON.parse(body).convert
        ? hlsMedia(file) : { ...media(file.id, 'video'), duration: file.duration, entry: file }));
      await playComputerEntries([file], 0, { startAt: 18 });
      metadata(video, 1_200);
      video.currentTime = 58;
      video.error = { code };
      video.emit('error');
      await settle();
      assert.equal(activeHls().url, hlsMedia(file).url);
      assert.equal(activeHls().config.startPosition, 58);
      frame(58);
      activeHls().error({ response: { code: 503 }, fatal: false });
      await settle();
      assert.equal(video.paused, false);
      assert.deepEqual(opens.filter(({ id }) => id === file.id).map(({ convert }) => convert), [undefined, true]);
    }
  });

  await t.test('converted files keep chapter stepping, Previous, Next and automatic advance', async () => {
    const file = movie('converted-controls', {
      chapters: [{ start: 0, title: 'First' }, { start: 20, title: 'Second' }, { start: 90, title: 'Last' }],
    });
    answers.set(file.id, () => response(hlsMedia(file)));
    await playComputerEntries([file], 0);
    frame(0);
    assert.equal(previous.getAttribute('aria-label'), 'Previous chapter');
    assert.equal(next.getAttribute('aria-label'), 'Next chapter');
    click(next);
    assert.equal(video.currentTime, 20);
    assert.match(source.textContent, /Chapter 2 of 3/);
    click(next);
    assert.equal(video.currentTime, 90);
    assert.equal(source.textContent, 'Preparing...');
    frame(90);
    click(previous);
    assert.equal(video.currentTime, 20);
    frame(20);
    assert.match(source.textContent, /Chapter 2 of 3/);

    await playComputerEntries([file, entry('after-converted')], 0);
    frame(0);
    assert.equal(next.getAttribute('aria-label'), 'Next');
    click(next);
    await settle();
    assert.equal(currentId(), 'computer:after-converted');
    click(previous);
    await settle();
    assert.equal(currentId(), 'computer:' + file.id);
    const hls = activeHls();
    frame(0);
    ended(video);
    await settle();
    assert.equal(currentId(), 'computer:after-converted');
    assert.equal(hls.destroyed, true);
  });

  await t.test('the last converted video keeps its picture and times after a natural end or the 416 end reply', async () => {
    for (const ending of ['ended', 416]) {
      const natural = ending === 'ended';
      const end = natural ? 1_200 : 1_022;
      const file = movie('last-converted-' + ending, { duration: natural ? end : 1_048, duration_estimated: !natural });
      answers.set(file.id, () => response(hlsMedia(file)));
      await playComputerEntries([file], 0, { startAt: end - 25 });
      const hls = activeHls();
      frame(end - 25, natural ? end : file.duration);
      if (natural) {
        video.currentTime = end;
        ended(video);
      } else {
        httpError(416, 'fragLoadError');
        await settle();
        assert.equal(video.paused, false);
        seekTo(file.duration);
        assert.equal(video.currentTime, end);
        assert.equal(source.textContent, 'Video');
        assert.deepEqual(hls.loads, []);
        video.currentTime = end - 0.2;
        video.emit('timeupdate');
      }
      await settle();
      assert.equal(currentId(), 'computer:' + file.id);
      assert.equal(hls.destroyed, false);
      assert.equal(hls.stopLoads, 1);
      assert.equal(hls.abrTimerCleared, true);
      assert.equal(video.src, 'blob:fake-hls');
      assert.equal(video.hasAttribute('controls'), true);
      const time = natural ? '20:00' : '17:02';
      assert.equal(elements['player-dur'].textContent, time);
      assert.equal(elements['player-time'].textContent, time);
      assert.equal(elements['player-play'].title, 'Play');
      assert.equal(released(file.id), 1);
      assert.equal(player.isComputerPlaybackConverted(currentId()), true);
    }
  });

  await t.test('Play and seek after a finished converted video each open a fresh session', async () => {
    for (const [ending, action, position] of [
      [416, 'play', 0],
      [416, 'seek', 600],
      ['ended', 'seek', 600],
      [416, 'video play', 0],
      [416, 'video seek', 600],
    ]) {
      const file = movie('finished-' + ending + '-' + action.replace(' ', '-'), { duration_estimated: ending === 416 });
      answers.set(file.id, () => response(hlsMedia(file)));
      await playComputerEntries([file], 0, { startAt: 997 });
      const old = activeHls();
      frame(997);
      if (ending === 416) {
        video.currentTime = 1_022;
        httpError(416, 'fragLoadError');
      } else {
        video.currentTime = 1_200;
        ended(video);
      }
      await settle();
      assert.equal(released(file.id), 1);
      assert.equal(old.destroyed, false);

      let respond;
      answers.set(file.id, () => new Promise((resolve) => { respond = resolve; }));
      const instances = FakeHls.instances.length;
      if (action === 'play') click(elements['player-play']);
      else if (action === 'seek') seekTo(position);
      else if (action === 'video play') await video.play();
      else {
        video.currentTime = position;
        video.emit('seeking');
      }
      await settle();
      assert.equal(opens.filter(({ id }) => id === file.id).length, 2);
      assert.equal(old.destroyed, true);
      assert.equal(video.src, '');
      assert.equal(FakeHls.instances.length, instances);

      respond(response(hlsMedia(file, file.id + '-fresh')));
      await settle();
      const fresh = activeHls();
      assert.equal(FakeHls.instances.length, instances + 1);
      assert.equal(fresh.url, hlsMedia(file, file.id + '-fresh').url);
      assert.equal(fresh.config.startPosition, position);
      assert.equal(source.textContent, 'Preparing...');
      frame(position);
      assert.equal(source.textContent, 'Video');
      await advanceClock(45_000);
      assert.equal(released(file.id), 1);
      assert.equal(fresh.destroyed, false);
    }
  });

  await t.test('an estimated length that ends early advances like a natural end without an error', async () => {
    const film = movie('estimated-early', { duration_estimated: true });
    answers.set(film.id, () => response(hlsMedia(film)));
    await playComputerEntries([film, entry('after-estimated')], 0);
    frame(0);
    const hls = activeHls();
    video.duration = 1_080;
    video.currentTime = 1_080;
    video.emit('durationchange');
    assert.equal(source.textContent, 'Video');
    ended(video);
    await settle();
    assert.equal(currentId(), 'computer:after-estimated');
    assert.equal(computerQueueState().failures, 0);
    assert.equal(hls.destroyed, true);
    assert.equal(broken.hidden, true);
  });

  await t.test('chapter controls step a single file and update labels and metadata across player types', async () => {
    const chaptered = entry('chapters', {
      kind: 'video', ext: 'mp4', width: 1920, height: 1080, vcodec: 'h264', acodec: 'aac',
      chapters: [{ start: 20, title: 'Second' }, { start: 0, title: 'First' }, { start: 90, title: 'Last' }],
    });
    answers.set('chapters', () => response(media('chapters', 'video')));
    await playComputerEntries([chaptered], 0, { startAt: 0 });
    metadata(video, 120);
    assert.equal(previous.getAttribute('aria-label'), 'Previous chapter');
    assert.equal(next.getAttribute('aria-label'), 'Next chapter');
    assert.equal(previous.disabled, true);
    assert.equal(source.textContent, 'Video · Chapter 1 of 3 · First');
    assert.equal(source.title, source.textContent + '\n1080p \u00b7 H.264 \u00b7 AAC');
    click(next);
    assert.equal(video.currentTime, 20);
    assert.equal(source.textContent, 'Video · Chapter 2 of 3 · Second');
    video.currentTime = 23.01;
    video.emit('timeupdate');
    click(previous);
    assert.equal(video.currentTime, 20);
    video.currentTime = 23;
    video.emit('timeupdate');
    click(previous);
    assert.equal(video.currentTime, 0);
    assert.equal(previous.disabled, true);
    video.currentTime = 90;
    video.emit('seeked');
    assert.equal(source.textContent, 'Video · Chapter 3 of 3 · Last');
    assert.equal(next.disabled, true);
    click(next);
    assert.equal(video.currentTime, 90);
    click(previous);
    assert.equal(video.currentTime, 20);
    await playComputerEntries([chaptered, entry('one')], 0);
    assert.equal(previous.getAttribute('aria-label'), 'Previous');
    assert.equal(next.getAttribute('aria-label'), 'Next');
    click(next);
    await settle();
    assert.equal(currentId(), 'computer:one');

    await playComputerEntries([chaptered], 0);
    const parts = ['first', 'second'].map((key) => ({
      key, title: key, streamUrl: 'https://example.org/' + key + '.mp3',
    }));
    const book = makeItem({
      id: 'librivox:controls', source: 'librivox', title: 'A web book', type: 'audio',
      stream_url: 'https://example.org/first.mp3', stream_kind: 'audio', delivery: 'on-demand',
    });
    await player.playItem(book, { parts, index: 0 });
    assert.equal(currentId(), book.id);
    assert.equal(previous.getAttribute('aria-label'), 'Previous part');
    assert.equal(next.getAttribute('aria-label'), 'Next part');
    assert.equal(next.hidden, false);
    click(next);
    await settle();
    assert.equal(player.getCurrentPart(book.id).index, 1);
  });

  await t.test('a multi-file audiobook resumes the active file and position and clears when finished', async () => {
    const book = { key: 'parts', entries: ['chapter-one', 'chapter-two', 'chapter-three'].map((id) => entry(id)) };
    const play = (index = bookResumeIndex(book)) => playComputerEntries(book.entries, index, { bookKey: book.key });
    await play(1);
    metadata(audio, 120);
    audio.currentTime = 25;
    player.stop();
    assert.equal(bookResumeIndex(book), 1);
    await play();
    metadata(audio, 120);
    assert.equal(audio.currentTime, 22);
    ended(audio);
    await settle();
    assert.equal(bookResumeIndex(book), 2);
    assert.equal(currentId(), 'computer:chapter-three');
    ended(audio);
    await settle();
    assert.equal(bookResumeIndex(book), 0);
  });

  await t.test('a missing bookmarked audiobook file resumes at the next surviving file', async () => {
    const entries = [1, 2, 3, 4].map((part) => entry('book-file-' + part, {
      track: part, rel: `Book/Part ${part}.m4b`, ext: 'm4b',
    }));
    const book = { key: 'missing-part', entries };
    const play = (index = bookResumeIndex(book)) => playComputerEntries(book.entries, index, bookPlaybackOptions(book));
    await play(1);
    metadata(audio, 120);
    audio.currentTime = 34;
    player.stop();
    const saved = readPartResume('computer:book:missing-part');
    assert.equal(saved.position, 34);
    assert.deepEqual(JSON.parse(saved.partKey), entries.slice(1).map(({ id }) => 'computer:' + id));
    assert.doesNotMatch(storage.get(PART_RESUME_KEY), /Book\/Part/);

    book.entries = [entries[0], entries[3]];
    assert.equal(bookResumeIndex(book), 1);
    await play();
    metadata(audio, 120);
    assert.equal(currentId(), 'computer:book-file-4');
    assert.equal(audio.currentTime, 0);
    audio.emit('seeking');
    audio.currentTime = 20;
    audio.emit('seeked');
    player.stop();
    assert.deepEqual(readPartResume(saved.id), saved);

    await play();
    metadata(audio, 120);
    audio.currentTime = 14;
    audio.emit('timeupdate');
    player.stop();
    assert.equal(readPartResume(saved.id).position, 14);
    book.entries = [entries[3]];
    await play();
    metadata(audio, 120);
    assert.equal(audio.currentTime, 11);
  });

  await t.test('old audiobook storage drops sort paths and keeps the active part position', async () => {
    const book = { key: 'old-book', entries: [entry('book-first'), entry('book-second')] };
    const id = 'computer:book:old-book';
    storage.set(PART_RESUME_KEY, JSON.stringify([{
      id, partKey: JSON.stringify(['computer:book-second', [1, 2, 'Private folder/Part 2.m4b']]), position: 40,
    }]));
    assert.equal(bookResumeIndex(book), 1);
    await playComputerEntries(book.entries, 1, bookPlaybackOptions(book));
    metadata(audio, 120);
    assert.equal(audio.currentTime, 37);
    assert.doesNotMatch(storage.get(PART_RESUME_KEY), /Private folder/);
  });

  await t.test('a resumed audiobook applies the same three-failure queue limit', async () => {
    const book = { key: 'stale-parts', entries: Array.from({ length: 6 }, (_, index) =>
      entry('stale-book-' + index, { track: index + 1, ext: 'm4b' })) };
    const play = (index = bookResumeIndex(book)) => playComputerEntries(book.entries, index, bookPlaybackOptions(book));
    await play(1);
    metadata(audio, 120);
    audio.currentTime = 32;
    player.stop();
    const saved = readPartResume('computer:book:stale-parts');
    for (const file of book.entries.slice(1, 4)) {
      answers.set(file.id, () => response(null, 404, { code: 'COMPUTER_FILE_GONE' }));
    }
    await play();
    assert.equal(currentId(), 'computer:stale-book-1');
    await advanceClock(2_000);
    await advanceClock(2_000);
    await advanceClock(2_000);
    assert.equal(currentId(), 'computer:stale-book-3');
    assert.deepEqual(readPartResume(saved.id), saved);
  });

  const tracksButton = (kind) => elements['player-' + kind];
  const tracksMenu = (kind) => elements['player-' + kind + '-menu'];
  const menuRows = (kind) => tracksMenu(kind).children;
  const labels = (kind) => menuRows(kind).map((row) => row.children[0].textContent);
  const isChecked = (kind, index) => menuRows(kind)[index]?.getAttribute('aria-checked') === 'true';
  const choose = (kind, index) => {
    tracksMenu(kind).showPopover();
    click(menuRows(kind)[index]);
  };
  const attached = () => video.children.filter((el) => el.tagName === 'TRACK');
  const assertSubtitleBusy = (busy) => {
    const button = tracksButton('subtitles');
    assert.equal(button.getAttribute('aria-busy'), busy ? 'true' : null);
    assert.equal(button.title, busy ? 'Loading subtitles...' : 'Subtitles (C)');
  };
  const direct = (file, extra = {}, suffix) => ({
    ...media(file.id, 'video', suffix), entry: file, duration: file.duration, ...extra,
  });
  const withTracks = (answer, subtitles, index = 0) => ({ ...answer, subtitles, audio_tracks: sound(index) });
  const playRequests = (file) => opens.filter(({ id }) => id === file.id).map(({ audio }) => audio);
  const framePoster = 'data:image/jpeg;base64,frame';
  function mockFrameCanvas(t) {
    const captures = [];
    const create = document.createElement;
    t.mock.method(document, 'createElement', (tag) => tag === 'canvas' ? {
      getContext: (type) => ({
        drawImage: (...args) => captures.push([video.src, type, ...args]),
      }),
      toDataURL(mime, quality) {
        assert.equal(mime, 'image/jpeg');
        assert.equal(quality, 0.8);
        return framePoster;
      },
    } : create(tag));
    return captures;
  }

  await t.test('Computer track controls appear only for choices and use keyboard menus and native captions', async () => {
    const file = film('track-buttons');
    const single = { audio_tracks: sound(0).slice(0, 1), subtitles: [] };
    answers.set(file.id, () => response(direct(file, single)));
    await player.playItem(makeComputerItem(file));
    assert.equal(tracksButton('subtitles').hidden, true);
    assert.equal(tracksButton('audio').hidden, true);
    answers.set(file.id, () => response(direct(file, { ...single, subtitles: [
      subtitle('English', 'en'), subtitle('French', 'fr'),
    ] })));
    await player.playItem(makeComputerItem(file));
    assert.equal(tracksButton('subtitles').hidden, false);
    assert.equal(tracksButton('audio').hidden, true);
    assert.deepEqual(labels('subtitles'), ['Off', 'English', 'French']);
    assert.equal(isChecked('subtitles', 0), true);
    assert.equal(press(tracksButton('subtitles'), 'ArrowDown'), true);
    assert.equal(document.activeElement, menuRows('subtitles')[0]);
    const pictureRect = { left: 500, right: 950, top: 280, bottom: 530, width: 450, height: 250 };
    const originalRect = video.getBoundingClientRect;
    video.getBoundingClientRect = () => pictureRect;
    window.dispatchEvent(new Event('resize'));
    assert.equal(tracksMenu('subtitles').style.left, '348px');
    video.getBoundingClientRect = originalRect;
    press(tracksMenu('subtitles'), 'ArrowDown');
    press(tracksMenu('subtitles'), 'ArrowDown');
    press(tracksMenu('subtitles'), 'Enter');
    await settle();
    assert.equal(document.activeElement, tracksButton('subtitles'));
    assert.equal(isChecked('subtitles', 2), true);
    assert.equal(attached()[0].label, 'French');
    assert.equal(attached()[0].track.mode, 'showing');
    assert.equal(await resolveObjectURL(attached()[0].src).text(), vtt);
    assert.equal(video.hasAttribute('controls'), true, 'caption track is a child of the fullscreen-capable native video');
    choose('subtitles', 1);
    await settle();
    assert.deepEqual(attached().map((el) => el.label), ['English']);
    assert.equal(press(visibilityEvents, 'c'), true);
    assert.equal(isChecked('subtitles', 0), true);
    assert.equal(attached().length, 0);
    const input = (type, id) => Object.assign(new FakeElement(id, 'input'), { type });
    for (const type of [undefined, 'text', 'search', 'url', 'email', 'password', 'number']) {
      assert.equal(press(visibilityEvents, 'c', input(type)), false, type ?? 'no type');
    }
    for (const tag of ['textarea', 'select']) {
      const target = { closest: (selector) => selector.split(', ').includes(tag) };
      assert.equal(press(visibilityEvents, 'c', target), false, tag);
    }
    assert.equal(press(visibilityEvents, 'c', { isContentEditable: true }), false);
    assert.equal(isChecked('subtitles', 0), true);
    for (const [on, off] of [
      [input('range', 'player-seek'), input('range', 'player-volume')],
      [input('checkbox'), new FakeElement('', 'button')],
    ]) {
      assert.equal(press(visibilityEvents, 'c', on), true);
      assert.equal(isChecked('subtitles', 1), true);
      assert.equal(press(visibilityEvents, 'c', off), true);
      assert.equal(isChecked('subtitles', 0), true);
    }
    press(visibilityEvents, 'C');
    await settle();
    assert.deepEqual(attached().map((el) => el.label), ['English']);
    attached()[0].track.mode = 'disabled';
    assert.equal(attached().length, 0);
    assert.equal(isChecked('subtitles', 0), true);
    assert.equal(loadComputerTrackPrefs().files.get(computerTrackFileKey(file.id, file)).subtitle, '');
    assert.equal(loadComputerTrackPrefs().subtitleLanguage, '');
    press(tracksButton('subtitles'), 'ArrowUp');
    assert.equal(document.activeElement, menuRows('subtitles')[2]);
    press(tracksMenu('subtitles'), 'Escape');
    assert.equal(document.activeElement, tracksButton('subtitles'));
    assert.equal(tracksButton('subtitles').getAttribute('aria-expanded'), 'false');
    choose('subtitles', 1);
    await settle();
    assert.equal(attached().length, 1);
    await open('no-track-audio');
    assert.equal(attached().length, 0);
    assert.equal(tracksButton('subtitles').hidden, true);
    assert.equal(tracksButton('audio').hidden, true);
    assert.equal(press(visibilityEvents, 'c'), false);
  });

  await t.test('subtitles survive native decode fallback and a fresh HLS session and are removed on Stop', async (t) => {
    const captures = mockFrameCanvas(t);
    const file = film('track-reopen');
    const { videoHeight, readyState } = video;
    t.after(() => Object.assign(video, { videoHeight, readyState }));
    video.videoHeight = 1080;
    const subtitles = [subtitle('reopen', 'en')];
    answers.set(file.id, ({ body }) => response(withTracks(JSON.parse(body).convert
      ? hlsMedia(file, 'reopen-' + opens.length) : direct(file), subtitles)));
    await player.playItem(makeComputerItem(file));
    choose('subtitles', 1);
    await settle();
    const nativeTrack = attached()[0];
    metadata(video, file.duration);
    video.readyState = 2;
    video.error = { code: 3 };
    video.emit('error');
    await settle();
    frame(0);
    const convertedTrack = attached()[0];
    assert.notEqual(convertedTrack, nativeTrack);
    assert.equal(convertedTrack.src, nativeTrack.src);
    assert.equal(attached().length, 1);
    ended(video);
    await player.togglePlay();
    await settle();
    assert.equal(attached().length, 1);
    assert.notEqual(attached()[0], convertedTrack);
    assert.equal(attached()[0].track.mode, 'showing');
    assert.equal(subtitleRequests.filter(({ id }) => id === file.id).length, 1);
    assert.equal(isChecked('subtitles', 1), true);
    assert.deepEqual(captures, [], 'ordinary rebuilds do not capture a poster');
    assert.equal(video.getAttribute('poster'), null);
    player.stop();
    assert.equal(attached().length, 0);
    assert.equal(tracksButton('subtitles').hidden, true);
    assert.equal(tracksButton('audio').hidden, true);
  });

  await t.test('subtitle retry state, exhaustion, cancellation and errors leave the video playing', async () => {
    const file = film('track-errors');
    const subs = [subtitle('retry', ''), subtitle('exhaust', 'de'), subtitle('bad', 'it'), subtitle('cancel', '')];
    const busy = () => response(null, 503, { code: 'COMPUTER_SUBTITLE_BUSY', message: 'Preparing subtitles.', retryable: true });
    let attempts = 0;
    subtitleAnswers.set('retry', () => ++attempts <= 2 ? busy() : new Response(vtt));
    subtitleAnswers.set('exhaust', busy);
    const reply = Promise.withResolvers();
    subtitleAnswers.set('cancel', () => reply.promise);
    subtitleAnswers.set('bad', () => response(null, 422, {
      code: 'COMPUTER_SUBTITLE_UNREADABLE', message: 'This subtitle cannot be read.',
    }));
    answers.set(file.id, () => response(direct(file, { subtitles: subs, audio_tracks: [] })));
    await player.playItem(makeComputerItem(file));
    choose('subtitles', 1);
    await settle();
    assert.equal(attempts, 1);
    assert.equal(menuRows('subtitles')[1].getAttribute('aria-busy'), 'true');
    assert.equal(tracksMenu('subtitles').open, false);
    assertSubtitleBusy(true);
    await advanceClock(999);
    assert.equal(attempts, 1);
    await advanceClock(1);
    assert.equal(attempts, 2);
    await advanceClock(1_000);
    assert.equal(attempts, 3);
    assert.equal(menuRows('subtitles')[1].hasAttribute('aria-busy'), false);
    assertSubtitleBusy(false);
    assert.equal(attached()[0].label, 'retry');
    choose('subtitles', 2);
    await settle();
    for (let i = 0; i < 5; i++) await advanceClock(1_000);
    assert.equal(subtitleRequests.filter(({ key }) => key === 'exhaust').length, 6);
    assert.equal(source.textContent, 'Preparing subtitles.');
    const key = computerTrackFileKey(file.id, file);
    assert.equal(loadComputerTrackPrefs().files.get(key).subtitle, 'exhaust');
    assert.equal(loadComputerTrackPrefs().subtitleLanguage, 'de');
    subtitleAnswers.set('exhaust', () => { throw new TypeError('fetch failed'); });
    choose('subtitles', 2);
    await settle();
    assert.equal(loadComputerTrackPrefs().files.get(key).subtitle, 'exhaust');
    assert.equal(loadComputerTrackPrefs().subtitleLanguage, 'de');
    assert.equal(isChecked('subtitles', 0), true);
    choose('subtitles', 3);
    assertSubtitleBusy(true);
    await settle();
    assertSubtitleBusy(false);
    assert.equal(source.textContent, 'This subtitle cannot be read.');
    assert.equal(isChecked('subtitles', 0), true);
    assert.equal(attached().length, 0);
    assert.equal(video.paused, false);
    assert.equal(video.src, direct(file).url);
    assert.equal(loadComputerTrackPrefs().files.get(key)?.subtitle, undefined);
    assert.equal(loadComputerTrackPrefs().subtitleLanguage, 'it');
    await advanceClock(4_000);
    assert.equal(source.textContent, 'Video');
    choose('subtitles', 4);
    await settle();
    const pending = subtitleRequests.at(-1);
    await advanceClock(300_000);
    assert.equal(pending.signal.aborted, false);
    assertSubtitleBusy(true);
    await open('cancel-subtitle-audio');
    assert.equal(pending.signal.aborted, true);
    assertSubtitleBusy(false);
    reply.resolve(new Response(vtt));
    await settle();
    assert.equal(subtitleRequests.filter(({ key }) => key === 'cancel').length, 1);
    assert.equal(attached().length, 0);
  });

  await t.test('choosing another subtitle, Off, and Stop cancel pending subtitle reads', async () => {
    const file = film('pending-subtitles');
    const first = Promise.withResolvers();
    const second = Promise.withResolvers();
    subtitleAnswers.set('pending-first', () => first.promise);
    subtitleAnswers.set('pending-second', () => second.promise);
    answers.set(file.id, () => response(direct(file, { subtitles: [
      subtitle('pending-first', ''), subtitle('pending-second', ''),
    ] })));
    await player.playItem(makeComputerItem(file));

    choose('subtitles', 1);
    await settle();
    const original = subtitleRequests.at(-1);
    choose('subtitles', 2);
    await settle();
    assert.equal(original.signal.aborted, true);
    assertSubtitleBusy(true);
    const replacement = subtitleRequests.at(-1);
    choose('subtitles', 0);
    assert.equal(replacement.signal.aborted, true);
    assertSubtitleBusy(false);

    choose('subtitles', 1);
    await settle();
    const stopped = subtitleRequests.at(-1);
    player.stop();
    assert.equal(stopped.signal.aborted, true);
    assertSubtitleBusy(false);
    first.resolve(new Response(vtt));
    second.resolve(new Response(vtt));
    await settle();
    assert.equal(attached().length, 0);
  });

  await t.test('changing audio preserves the picture, time, play state, and subtitles', async (t) => {
    const file = film('track-switch');
    const captures = mockFrameCanvas(t);
    const { videoHeight, readyState, autoEvents } = video;
    t.after(() => Object.assign(video, { videoHeight, readyState, autoEvents }));
    video.videoHeight = 1080;
    const postersAtClear = [];
    const remove = video.removeAttribute.bind(video);
    t.mock.method(video, 'removeAttribute', (name) => {
      if (name === 'src' && video.src) postersAtClear.push(video.getAttribute('poster'));
      remove(name);
    });
    const subs = [subtitle('switch', 'it')];
    let answerGerman;
    answers.set(file.id, ({ body }) => {
      const index = JSON.parse(body).audio;
      if (index === 1) return new Promise((resolve) => { answerGerman = resolve; });
      return response(withTracks(direct(file, {}, index === 0 ? '-reopened' : ''), subs));
    });
    await player.playItem(makeComputerItem(file));
    assert.equal(tracksButton('audio').hidden, false);
    assert.deepEqual(labels('audio'), ['English', 'German', 'French']);
    assert.equal(isChecked('audio', 0), true);
    metadata(video, file.duration);
    video.currentTime = 148;
    choose('subtitles', 1);
    await settle();
    choose('audio', 1);
    await settle();
    await advanceClock(400);
    assert.equal(source.textContent, 'Preparing...');
    assert.equal(video.src, direct(file).url);
    assert.equal(video.paused, false);
    assert.equal(isChecked('audio', 0), true);
    assert.equal(video.getAttribute('poster'), null);
    video.currentTime = 150;
    video.readyState = 2;
    const oldTrack = attached()[0];
    video.autoEvents = false;
    answerGerman(response(withTracks(hlsMedia(file, 'switch-de'), subs, 1)));
    await settle();
    assert.deepEqual(captures, [[direct(file).url, '2d', video, 0, 0, 1280, 720]]);
    assert.equal(postersAtClear.at(-1), framePoster, 'the poster is set before the old source is cleared');
    assert.equal(video.getAttribute('poster'), framePoster);
    assert.equal(activeHls().config.startPosition, 150);
    video.readyState = 2;
    video.emit('playing');
    assert.equal(video.getAttribute('poster'), null);
    frame(150);
    assert.equal(video.paused, false);
    assert.equal(video.currentTime, 150);
    assert.equal(isChecked('audio', 1), true);
    assert.equal(isChecked('subtitles', 1), true);
    assert.equal(attached().length, 1);
    assert.notEqual(attached()[0], oldTrack);
    video.autoEvents = autoEvents;
    video.pause();
    video.setAttribute('poster', 'original.jpg');
    choose('audio', 0);
    await settle();
    assert.equal(video.getAttribute('poster'), framePoster);
    metadata(video, file.duration);
    video.emit('loadeddata');
    assert.equal(video.getAttribute('poster'), 'original.jpg');
    video.removeAttribute('poster');
    assert.equal(video.src, direct(file, {}, '-reopened').url);
    assert.equal(video.currentTime, 150);
    assert.equal(video.paused, true);
    assert.equal(isChecked('audio', 0), true);
    assert.equal(isChecked('subtitles', 1), true);
    assert.deepEqual(playRequests(file), [undefined, 1, 0]);
    assert.equal(released('switch-de'), 1);
    assert.equal(loadComputerTrackPrefs().files.get(computerTrackFileKey(file.id, file)).audio, 0);
  });

  await t.test('an audio change poster is restored on errors, Stop, and item changes', async (t) => {
    const file = film('track-poster');
    const captures = mockFrameCanvas(t);
    const { videoHeight, readyState, autoEvents } = video;
    const extraSettings = storage.get(EXTRA_SETTINGS_STORAGE_KEY);
    t.after(() => {
      if (extraSettings === undefined) storage.delete(EXTRA_SETTINGS_STORAGE_KEY);
      else storage.set(EXTRA_SETTINGS_STORAGE_KEY, extraSettings);
      Object.assign(video, { videoHeight, readyState, autoEvents });
      video.removeAttribute('poster');
    });
    answers.set(file.id, ({ body }) => {
      const index = JSON.parse(body).audio ?? 0;
      return response(withTracks(direct(file, {}, '-' + index), [], index));
    });
    video.autoEvents = false;
    for (const finish of [
      () => { video.error = { code: 3 }; video.emit('error'); },
      () => player.stop(),
      () => open('new-poster-item'),
    ]) {
      await player.playItem(makeComputerItem(file));
      video.setAttribute('poster', '');
      video.videoHeight = 1080;
      video.readyState = 2;
      choose('audio', isChecked('audio', 0) ? 1 : 0);
      await settle();
      assert.equal(video.getAttribute('poster'), framePoster);
      await finish();
      await settle();
      assert.equal(video.getAttribute('poster'), '');
    }
    assert.equal(captures.length, 3);

    for (const [state, height] of [[1, 1080], [2, 0]]) {
      await player.playItem(makeComputerItem(file));
      video.readyState = state;
      video.videoHeight = height;
      const index = isChecked('audio', 0) ? 1 : 0;
      choose('audio', index);
      await settle();
      assert.equal(isChecked('audio', index), true);
      assert.equal(video.getAttribute('poster'), '');
    }
    assert.equal(captures.length, 3, 'no decoded picture was available to capture');
  });

  await t.test('the latest audio choice wins and a failed request keeps the active media', async () => {
    const file = film('track-latest');
    const subs = [];
    let answerFirst;
    let fail = false;
    answers.set(file.id, ({ body }) => {
      const index = JSON.parse(body).audio;
      if (index === 1) return new Promise((resolve) => { answerFirst = resolve; });
      if (fail) return response(null, 503, { code: 'COMPUTER_MEDIA_BUSY', message: 'Try again.', retryable: true });
      return response(index === 2
        ? withTracks(hlsMedia(file, 'latest-fr'), subs, 2) : withTracks(direct(file), subs));
    });
    await player.playItem(makeComputerItem(file));
    metadata(video, file.duration);
    video.currentTime = 73;
    const instanceCount = FakeHls.instances.length;
    choose('audio', 1);
    await settle();
    choose('audio', 2);
    await settle();
    assert.deepEqual(playRequests(file), [undefined, 1]);
    answerFirst(response(withTracks(hlsMedia(file, 'superseded-de'), subs, 1)));
    await settle();
    assert.deepEqual(playRequests(file), [undefined, 1, 2]);
    assert.equal(FakeHls.instances.length, instanceCount + 1);
    assert.equal(released('superseded-de'), 1);
    assert.equal(activeHls().url, hlsMedia(file, 'latest-fr').url);
    assert.equal(activeHls().config.startPosition, 73);
    frame(73);
    fail = true;
    choose('audio', 0);
    await settle();
    assert.equal(released('latest-fr'), 0);
    assert.equal(activeHls().destroyed, false);
    assert.equal(video.paused, false);
    assert.equal(video.currentTime, 73);
    assert.equal(isChecked('audio', 2), true);
    assert.equal(source.textContent, 'Try again.');
  });

  await t.test('a new film asks for the preferred audio before matching forced subtitles and drops vanished keys', async () => {
    const file = film('track-preferences');
    const fingerprint = computerTrackFileKey(file.id, file);
    const subs = [subtitle('english-forced', 'en', { forced: true }), subtitle('french-forced', 'fr', { forced: true })];
    rememberComputerTracks(fingerprint, { subtitle: 'vanished' }, { subtitle: '' });
    answers.set(file.id, ({ body }) => {
      const index = JSON.parse(body).audio;
      return response(index === 2
        ? withTracks(hlsMedia(file, 'preferred-fr'), subs, 2) : withTracks(direct(file), subs));
    });
    await player.playItem(makeComputerItem(file));
    await settle();
    assert.deepEqual(playRequests(file), [undefined, 2]);
    assert.equal(isChecked('subtitles', 2), true);
    assert.equal(attached()[0].label, 'french-forced');
    assert.equal(loadComputerTrackPrefs().files.get(fingerprint), undefined);
    const webVideo = makeItem({ id: 'test:video', title: 'Web video', type: 'video', source: 'test',
      stream_url: 'https://example.org/video.mp4', stream_kind: 'video', delivery: 'on-demand' });
    await player.playItem(webVideo);
    assert.equal(attached().length, 0);
    assert.equal(tracksButton('subtitles').hidden, true);
    assert.equal(tracksButton('audio').hidden, true);
  });

  await t.test('the active file and its queue follow a move without reopening media', async (subtest) => {
    const first = entry('moving-track', { duration: 2_000 });
    const second = entry('moving-next');
    const moved = { ...first, id: 'moved-track' };
    const movedNext = { ...second, id: 'moved-next' };
    const folders = [{ id: 'music', available: true }];
    let catalog = { revision: 1, folders, items: [first, second] };
    const status = async () => ({ scanning: false, revision: catalog.revision });
    const library = createComputerLibrary({
      loadComputerLibrary: async () => catalog, startComputerScan: status, computerStatus: status,
    });
    subtest.after(library.closeComputerLibrary);
    await library.openComputerLibrary();
    answers.set(first.id, () => response({ ...media(first.id), duration: 2_000 }));
    await playComputerEntries([first, second], 0);
    const active = player.getCurrentItem();
    const queue = computerQueueState();
    const src = audio.src;
    const requestsBeforeMove = opens.length;
    metadata(audio, 2_000);
    audio.currentTime = 340;
    assert.equal(audio.paused, false);

    catalog = { revision: 2, delta: true, folders, items: [moved, movedNext], removed: [first.id, second.id],
      moved: [['intermediate-track', moved.id], [second.id, movedNext.id], [first.id, 'intermediate-track']] };
    await library.refreshAvailability();
    assert.equal(player.getCurrentItem(), active);
    assert.equal(getState().currentItem, active);
    assert.equal(active.id, 'computer:moved-track');
    assert.equal(active.stream_url, active.id);
    assert.equal(active._extra.computer.id, moved.id);
    assert.equal(audio.src, src);
    assert.equal(audio.currentTime, 340);
    assert.equal(audio.paused, false);
    assert.equal(opens.length, requestsBeforeMove);
    assert.equal(computerQueueState(), queue);
    assert.deepEqual(queue.entries, [moved, movedNext]);
    assert.equal(queue.index, 0);

    click(next);
    await settle();
    assert.equal(opens.at(-1).id, movedNext.id);
    assert.equal(currentId(), 'computer:moved-next');
    assert.equal(readPartResume('computer:moved-track').position, 340);
    assert.equal(readPartResume('computer:moving-track'), null);
    click(previous);
    await settle();
    assert.equal(opens.at(-1).id, moved.id);
    assert.equal(currentId(), 'computer:moved-track');
  });

  await t.test('an attached subtitle stays visible and later choices use the moved id', async (subtest) => {
    const original = film('moving-caption-film');
    const moved = { ...original, id: 'moved-caption-film' };
    const folders = [{ id: 'music', available: true }];
    let catalog = { revision: 1, folders, items: [original] };
    const status = async () => ({ scanning: false, revision: catalog.revision });
    const library = createComputerLibrary({
      loadComputerLibrary: async () => catalog, startComputerScan: status, computerStatus: status,
    });
    subtest.after(library.closeComputerLibrary);
    await library.openComputerLibrary();
    answers.set(original.id, () => response(direct(original, {
      subtitles: [subtitle('moveCaption', 'en')],
    })));
    await player.playItem(makeComputerItem(original));
    choose('subtitles', 1);
    await settle();
    const [track] = attached();
    assert.equal(track.label, 'moveCaption');
    const src = video.src;

    catalog = { revision: 2, folders, items: [moved], moved: [[original.id, moved.id]] };
    await library.refreshAvailability();
    assert.equal(video.src, src);
    assert.equal(attached()[0], track);
    assert.equal(track.track.mode, 'showing');
    const prefs = () => loadComputerTrackPrefs().files;
    const oldKey = computerTrackFileKey(original.id, original);
    const newKey = computerTrackFileKey(moved.id, moved);
    assert.equal(prefs().has(oldKey), false);
    assert.equal(prefs().get(newKey).subtitle, 'moveCaption');

    choose('subtitles', 0);
    assert.equal(prefs().get(newKey).subtitle, '');
    choose('subtitles', 1);
    await settle();
    assert.equal(subtitleRequests.at(-1).id, moved.id);
    assert.equal(prefs().has(oldKey), false);
    choose('subtitles', 0);
  });

  await t.test('Library queues visible local hits and keeps playback and its highlight on a refused favorite', async (t) => {
    const savedView = { ...view };
    const track = entry('library-track', { title: 'Library Song', folder: 'music', has_cover: true });
    const earlier = entry('library-earlier', { title: 'Library Other Song', folder: 'music' });
    const film = movie('library-film', { title: 'Library Film', folder: 'music' });
    const saved = makeComputerItem({ ...track, has_cover: false });
    const disconnected = entry('library-offline', { folder: 'drive', title: 'Library Offline' });
    libraryFiles = [film, earlier, track, disconnected];
    try {
      await computerLibrary.ensureComputerLibrary();
      assert.equal(artworkSourceFor(saved), '');
      assert.equal(artworkSourceFor(computerItemForView(saved)), '/api/v1/computer/art/library-track');

      Object.assign(view, { activeSource: 'type:audio', query: 'Library', filters: { ...view.filters, type: 'audio' } });
      updateComputerHits();
      const selected = view.computerHits.find(({ id }) => id === saved.id);
      await playLibraryItem(selected);
      assert.equal(opens.at(-1).id, track.id);
      assert.equal(currentId(), saved.id);
      const queue = computerQueueState();
      assert.deepEqual(queue.entries.map(({ id }) => id), [earlier.id, track.id]);
      assert.equal(queue.index, 1);

      view.activeSource = 'favorites';
      const missing = computerItemForView(makeComputerItem(entry('library-missing')));
      assert.equal(missing.__computerMissing, true);
      assert.equal(computerCardSubtitle(missing), 'Not found');
      const offline = computerItemForView(makeComputerItem(disconnected));
      assert.equal(offline.__computerMissing, false);
      assert.equal(offline.__computerOffline, true);
      assert.equal(computerCardSubtitle(offline), 'Not connected');
      const station = { id: 'test:station' };
      assert.equal(nextPlayableLibraryItem([station, missing, selected], station.id), selected);
      assert.equal(nextPlayableLibraryItem([station, missing, selected], selected.id), station);
      assert.equal(nextPlayableLibraryItem([missing], missing.id), undefined);
      const before = opens.length;
      await playLibraryItem(missing);
      assert.equal(currentId(), saved.id);
      assert.equal(audio.paused, false);
      assert.equal(computerQueueState(), queue);
      assert.equal(opens.length, before);
      assert.equal(source.textContent, 'That file is no longer there.');
      await advanceClock(5_000);
      assert.equal(source.textContent, 'An Artist \u00b7 An Album');

      const rejected = computerItemForView(makeComputerItem(earlier));
      assert.ok(!rejected.__computerMissing);
      const savedUi = { ...ui };
      const savedFavorites = state.favorites;
      const savedSettings = state.settings;
      const makeElement = (tag) => {
        const el = new FakeElement('', tag);
        Object.defineProperty(el, 'className', {
          set: (classes) => el.classList.add(...classes.split(' ')),
        });
        el.setAttribute = (name, value) => {
          if (name === 'data-id') el.dataset.id = value;
          FakeElement.prototype.setAttribute.call(el, name, value);
        };
        el.contains = (child) => el.children.includes(child);
        return el;
      };
      t.mock.method(document, 'createElement', makeElement);
      document.createDocumentFragment = () => {
        const fragment = makeElement('fragment');
        fragment.childNodes = fragment.children;
        return fragment;
      };
      const host = makeElement('div');
      host.appendChild = (fragment) => host.children.push(...fragment.childNodes);
      host.querySelectorAll = () => host.children;
      Object.assign(ui, { root: makeElement('main'), resultsHost: host });
      state.favorites = [saved, rejected, offline];
      state.settings = { ...savedSettings, favoritesSort: 'name' };
      view.currentId = saved.id;
      view.personalFilters = { ...view.personalFilters, favorites: { query: '', type: [] } };
      let finish;
      answers.set(earlier.id, () => new Promise((resolve) => { finish = resolve; }));
      try {
        renderResults();
        const cardFor = (item) => host.children.find((card) => card.dataset.id === item.id);
        const assertHighlight = () => {
          assert.equal(cardFor(saved).classList.contains('is-playing'), true);
          assert.equal(cardFor(rejected).classList.contains('is-playing'), false);
        };
        assertHighlight();
        assert.equal(cardFor(offline).__open.getAttribute('title'), 'The folder is not connected.');
        const count = opens.length;
        await playLibraryItem(offline);
        assert.equal(opens.length, count);
        assert.equal(computerQueueState(), queue);
        assert.equal(source.textContent, 'That folder is not connected.');
        click(cardFor(rejected).__open);
        await settle();
        assert.equal(opens.at(-1).id, earlier.id);
        assertHighlight();
        finish(response(null, 409, { code: 'COMPUTER_FOLDER_OFFLINE' }));
        await settle();
        assertHighlight();
        assert.equal(currentId(), saved.id);
        assert.equal(computerQueueState(), queue);
        assert.equal(source.textContent, 'That folder is not connected.');
      } finally {
        closeDetail();
        delete document.createDocumentFragment;
        Object.assign(ui, savedUi);
        state.favorites = savedFavorites;
        state.settings = savedSettings;
        renderedIds.clear();
      }
    } finally {
      Object.assign(view, savedView);
    }
  });

  await t.test('a buffered successor starts inside ended, after the outgoing bookmark is cleared', async (t) => {
    // Queue the same long file twice. A resume state captured before the clear would seek back to 147.
    const track = entry('gap-repeat-entry', { duration: 2000 });
    let spectrumLevel = 125;
    const analyser = {
      context: { sampleRate: 48000 }, fftSize: 2048, minDecibels: -85, maxDecibels: -15,
      getByteFrequencyData: (bins) => bins.fill(spectrumLevel),
      getFloatTimeDomainData: (wave) => wave.fill(0.2),
    };
    t.mock.method(AudioEngine.prototype, 'visualTapFor', () => analyser);
    const releaseTap = t.mock.method(AudioEngine.prototype, 'releaseVisualTap');
    const signal = player.getAudioSignal();
    const frames = new Map();
    let nextFrame = 0;
    const oldRaf = globalThis.requestAnimationFrame;
    const oldCaf = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = (fn) => { frames.set(++nextFrame, fn); return nextFrame; };
    globalThis.cancelAnimationFrame = (id) => frames.delete(id);
    const read = (ms) => {
      for (const [id, fn] of frames) {
        frames.delete(id);
        fn(ms);
      }
    };
    const subscriptions = t.mock.method(signal, 'subscribe');
    const canvas = { getContext: () => ({ clearRect() {}, beginPath() {}, rect() {}, fill() {} }) };
    const meter = createPlayerMeter({ canvas, signal, win: {}, doc: null });
    meter.resize(90, 36);
    const delivered = [];
    const unsubscribe = signal.subscribe((frame) => delivered.push({
      active: frame.active, version: frame.version, tapVersion: frame.tapVersion, spectrum: frame.spectrum,
    }));
    t.after(() => {
      unsubscribe();
      meter.destroy();
      globalThis.requestAnimationFrame = oldRaf;
      globalThis.cancelAnimationFrame = oldCaf;
    });
    answers.set(track.id, () => response({ ...media(track.id), entry: track, duration: 2000 }));
    await playComputerEntries([track, track], 0);
    const count = opens.length;
    metadata(audio, 2000);
    audio.currentTime = 150;
    audio.emit('timeupdate');
    audio.currentTime = 1979.99;
    audio.emit('timeupdate');
    await settle();
    assert.equal(opens.length, count);
    assert.equal(readPartResume(currentId()).position, 150);
    audio.currentTime = 1980;
    audio.emit('timeupdate');
    audio.emit('timeupdate');
    await settle();
    assert.equal(opens.length, count + 1);
    assert.equal(standby.src, media(track.id).url);
    assert.equal(standby.preload, 'auto');
    assert.equal(standby.crossOrigin, 'anonymous');
    assert.ok(standby.paused);
    metadata(standby, 2000);
    for (const event of ['timeupdate', 'stalled', 'ended', 'playing']) standby.emit(event);
    assert.equal(readPartResume(currentId()).position, 150);
    assert.equal(computerQueueState().index, 0);
    assert.equal(elements['player-time'].textContent, '33:00');
    standby.readyState = 3;
    standby.buffered = timeRanges([0, 5]);
    const cleared = t.mock.method(standby, 'load');
    const plays = t.mock.method(standby, 'play');
    computerQueueState().failures = 2;
    const start = performance.now();
    read(start);
    await advanceClock(100);
    read(start + 100);
    const before = delivered.at(-1);
    const deliveredBefore = delivered.length;
    assert.equal(before?.active, true);
    const { starts, stops } = signal.stats;
    const subCount = signal.subscriberCount;
    const subscriptionCalls = subscriptions.mock.callCount();
    const { levels, peaks, trackedDb } = meter.state;
    const priorLevels = levels.slice();
    const priorPeaks = peaks.slice();
    const priorGain = trackedDb.slice();
    assert.ok(levels.some((level) => level > 0));
    const releasesBefore = releaseTap.mock.callCount();
    audio.ended = audio.paused = true;
    audio.emit('timeupdate');
    audio.emit('pause');
    ended(audio);
    assert.deepEqual(levels, priorLevels);
    assert.deepEqual(peaks, priorPeaks);
    assert.deepEqual(trackedDb, priorGain);
    spectrumLevel = 0;
    await advanceClock(100);
    read(start + 200);
    assert.ok(levels.some((level) => level > 0));
    assert.deepEqual(peaks, priorPeaks);
    assert.equal(subscriptions.mock.callCount(), subscriptionCalls);
    assert.equal(signal.stats.starts, starts);
    assert.equal(signal.stats.stops, stops);
    assert.equal(signal.subscriberCount, subCount);
    assert.equal(releaseTap.mock.callCount(), releasesBefore);
    assert.equal(delivered.length, deliveredBefore + 1);
    assert.deepEqual(delivered.at(-1), before);
    assert.equal(delivered.at(-1).spectrum, before.spectrum);
    unsubscribe();
    meter.destroy();
    assert.equal(plays.mock.callCount(), 1);
    assert.equal(cleared.mock.callCount(), 0);
    assert.equal(computerQueueState().index, 1);
    assert.equal(computerQueueState().failures, 0);
    assert.equal(readPartResume(currentId()), null);
    assert.equal(standby.currentTime, 0);
    assert.equal(audio.src, '');
    for (const event of ['error', 'timeupdate', 'stalled', 'ended', 'loadedmetadata']) audio.emit(event);
    assert.equal(standby.paused, false);
    assert.equal(getState().isPlaying, true);
    assert.equal(mediaSession.playbackState, 'playing');
    assert.equal(elements['player-time'].textContent, '0:00');
    await settle();
    assert.equal(opens.length, count + 1);
    seekTo(12);
    assert.equal(standby.currentTime, 12);
    click(previous);
    assert.equal(standby.currentTime, 0);
    await player.togglePlay();
    assert.ok(standby.paused);
    await player.togglePlay();
    assert.equal(standby.paused, false);
    standby.currentTime = 2;
    click(previous);
    await settle();
    assert.equal(computerQueueState().index, 0);
    assert.equal(audio.paused, false);
    assert.equal(standby.src, '');
  });

  await t.test('a decided shuffle promotes a ready converted track and radio takes the original element back', async () => {
    const files = ['shuffle-active', 'shuffle-later', 'shuffle-converted'].map((id) => entry(id));
    const converted = files[2];
    answers.set(converted.id, () => response({ ...media(converted.id), entry: converted, converted: true }));
    await playComputerEntries(files, 0, { shuffle: true, random: () => 0 });
    assert.equal(computerQueueState().entries[1], converted);
    metadata(audio, 39);
    await settle();
    metadata(standby, 30);
    standby.readyState = 4;
    standby.emit('canplaythrough');
    ended(audio);
    assert.equal(player.isComputerPlaybackConverted(currentId()), true);
    assert.equal(mediaSession.metadata.title, converted.title);
    assert.equal(state.currentItem.id, 'computer:' + converted.id);
    await settle();
    assert.equal(audio.src, media('shuffle-later').url);
    const pending = opens.at(-1);
    await player.playItem(station);
    assert.ok(pending.signal.aborted);
    assert.equal(standby.src, '');
    assert.equal(standby.paused, true);
    assert.match(audio.src, /remote_test_media/);
    assert.equal(audio.crossOrigin, 'anonymous');
    assert.equal(audio.paused, false);
    assert.equal(computerQueueState(), null);
  });

  await t.test('an unusable standby is released and queue advance opens the selected entry normally', async () => {
    for (const reason of ['unbuffered', 'error', 'expired', 'queue edit', 'loop', 'lost buffer']) {
      const first = entry('gap-first-' + reason);
      const second = entry('gap-second-' + reason);
      await playComputerEntries([first, second], 0);
      metadata(audio, 39);
      await settle();
      assert.equal(standby.src, media(second.id).url, reason);
      const count = opens.length;
      if (reason === 'unbuffered') {
        standby.readyState = 3;
        standby.buffered = timeRanges([4, 8]);
      } else {
        standby.readyState = 4;
        standby.emit('canplaythrough');
      }
      if (reason === 'error') {
        standby.emit('error');
        assert.equal(standby.src, '');
        assert.equal(currentId(), 'computer:' + first.id);
        assert.equal(computerQueueState().failures, 0);
        audio.emit('timeupdate');
      }
      if (reason === 'expired') await advanceClock(60_000);
      if (reason === 'loop') audio.loop = true;
      if (reason === 'queue edit') computerQueueState().entries[1] = entry('replacement');
      if (reason === 'lost buffer') standby.readyState = 1;
      ended(audio);
      await settle();
      assert.equal(opens.length, count + 1, reason);
      assert.equal(opens.at(-1).id, reason === 'queue edit' ? 'replacement' : second.id);
      assert.equal(standby.src, '', reason);
      assert.equal(audio.src, media(opens.at(-1).id).url);
      audio.loop = false;
    }
    for (const nextEntry of [movie('gap-video'), entry('gap-book', { ext: 'm4b' })]) {
      await playComputerEntries([entry('gap-excluded'), nextEntry], 0);
      const count = opens.length;
      metadata(audio, 10);
      await settle();
      assert.equal(opens.length, count);
      ended(audio);
      await settle();
      assert.equal(opens.at(-1).id, nextEntry.id);
    }
  });

  await t.test('Stop, selection, a station, sleep and pagehide release pending and buffered successors', async () => {
    for (const mode of ['pending', 'buffered']) {
      for (const action of ['stop', 'selection', 'station', 'sleep', 'deadline', 'pagehide']) {
        const second = entry('gap-cancel-' + mode + action);
        let complete;
        if (mode === 'pending') answers.set(second.id, () => new Promise((resolve) => { complete = resolve; }));
        await playComputerEntries([entry('gap-cancel'), second], 0);
        metadata(audio, 30);
        await settle();
        const request = opens.at(-1);
        assert.equal(request.id, second.id);
        if (mode === 'buffered') {
          assert.equal(standby.src, media(second.id).url);
          standby.readyState = 4;
          standby.emit('canplaythrough');
        }
        if (action === 'stop') player.stop();
        if (action === 'selection') await open('gap-picked');
        if (action === 'station') await player.playItem(station);
        if (action === 'sleep') emit('sleep-fired');
        if (action === 'pagehide') window.dispatchEvent(new Event('pagehide'));
        if (action === 'deadline') {
          state.sleepTimer.until = Date.now();
          ended(audio);
          assert.equal(computerQueueState().index, 0);
          state.sleepTimer.until = null;
        }
        assert.ok(request.signal.aborted, mode + action);
        complete?.(response(media(second.id)));
        await settle();
        assert.equal(standby.src, '');
        assert.ok(standby.paused);
        assert.ok(requests.includes(media(second.id).url + '/release'), mode + action);
        if (action === 'station') assert.match(audio.src, /api\/v1\/media\//);
      }
    }
  });

  await t.test('a decoder failure on the first promoted play quietly reopens the file once', async (t) => {
    const nextFile = entry('race-at-play');
    await playComputerEntries([entry('before-play-race'), nextFile], 0);
    metadata(audio, 30);
    await settle();
    standby.readyState = 4;
    standby.emit('canplaythrough');
    const play = standby.play.bind(standby);
    const attempt = t.mock.method(standby, 'play', play);
    attempt.mock.mockImplementationOnce(() => Promise.reject(new Error('range expired')));
    ended(audio);
    await settle();
    assert.equal(attempt.mock.callCount(), 2);
    assert.equal(opens.filter(({ id }) => id === nextFile.id).length, 2);
    assert.equal(computerQueueState().index, 1);
    assert.equal(computerQueueState().failures, 0);
    assert.equal(mediaSession.metadata.title, nextFile.title);
    assert.equal(standby.paused, false);
  });

  await t.test('seeking away releases the standby and the next visit to the window re-arms it', async () => {
    const nextId = 'seek-standby';
    let attempt = 0;
    answers.set(nextId, () => response(media(nextId, 'audio', '-' + ++attempt)));
    await playComputerEntries([entry('seek-owner'), entry(nextId)], 0);
    metadata(audio, 120);
    for (const position of [110, 60, 110]) {
      audio.currentTime = position;
      audio.emit('timeupdate');
      await settle();
    }
    assert.equal(attempt, 2);
    assert.ok(requests.includes(media(nextId + '-1').url + '/release'));
    standby.readyState = 4;
    standby.emit('canplaythrough');
    ended(audio);
    await settle();
    assert.ok(requests.includes(media(nextId + '-2').url + '/keep'));
    player.stop();
    await settle();
    assert.ok(requests.includes(media(nextId + '-2').url + '/release'));
  });

  await t.test('re-entering the window waits for an abandoned open to settle', async () => {
    const id = 'return-while-opening';
    const late = Promise.withResolvers();
    let count = 0;
    answers.set(id, () => ++count === 1 ? late.promise : response(media(id, 'audio', '-new')));
    await playComputerEntries([entry('back-and-forth'), entry(id)], 0);
    metadata(audio, 120);
    for (const time of [110, 50, 110]) {
      audio.currentTime = time;
      audio.emit('timeupdate');
      await settle();
    }
    assert.equal(count, 1);
    late.resolve(response(media(id, 'audio', '-old')));
    await settle();
    assert.equal(count, 2);
    assert.ok(requests.includes(media(id + '-old').url + '/release'));
    assert.equal(standby.src, media(id + '-new').url);
    player.stop();
  });

  await t.test('loudness follows active music and cancels both waiting measurements', async () => {
    for (const action of ['stop', 'station', 'video', 'end']) {
      player.stop();
      saveSettings({ volumeLevelling: 'off' });
      const first = entry('measure-' + action);
      const second = entry('measure-next-' + action);
      const before = measurements.length;
      await playComputerEntries(action === 'end' ? [first] : [first, second], 0);
      saveSettings({ volumeLevelling: 'track' });
      await settle();
      const jobs = measurements.slice(before);
      assert.deepEqual(jobs.map(job => job.id), action === 'end' ? [first.id] : [first.id, second.id]);
      if (action === 'stop') player.stop();
      if (action === 'station') await player.playItem(station);
      if (action === 'video') {
        answers.set('leave-music', () => response(media('leave-music', 'video')));
        await open('leave-music', { kind: 'video' });
      }
      if (action === 'end') ended(audio);
      await settle();
      assert.ok(jobs.every(job => job.signal.aborted), action);
      saveSettings({ volumeLevelling: 'off' });
      saveSettings({ volumeLevelling: 'track' });
      await settle();
      assert.equal(measurements.length, before + jobs.length, action);
    }
    saveSettings({ volumeLevelling: 'off' });
    player.stop();
  });

  await t.test('a slow speculative open is cancelled at Preparing and never retried until ended', async () => {
    const second = entry('slow-standby');
    let complete;
    answers.set(second.id, () => new Promise((resolve) => { complete = resolve; }));
    await playComputerEntries([entry('before-slow'), second], 0);
    metadata(audio, 15);
    await settle();
    const request = opens.at(-1);
    await advanceClock(400);
    assert.ok(request.signal.aborted);
    complete(response(media(second.id)));
    await settle();
    assert.equal(standby.src, '');
    assert.doesNotMatch(source.textContent, /Preparing/);
    audio.emit('timeupdate');
    answers.delete(second.id);
    ended(audio);
    await settle();
    assert.equal(audio.src, media(second.id).url);
    assert.equal(opens.filter(({ id }) => id === second.id).length, 2);
  });

  await t.test('web items clear the queue and restore the part labels and Media Session metadata', async () => {
    await playComputerEntries([entry('one'), entry('two')], 0);
    const episode = makeItem({
      id: 'test:episode', title: 'Episode', type: 'audio', source: 'test',
      stream_url: 'https://example.org/show.mp3', stream_kind: 'audio', delivery: 'on-demand',
    });
    await player.playItem(episode);
    assert.equal(next.hidden, true);
    assert.equal(previous.getAttribute('aria-label'), 'Previous part');
    assert.equal(mediaSession.metadata, 'previous metadata');
    assert.equal(elements['player-capture'].hidden, false, 'web items restore the Record / Download button');
    assert.equal(currentId(), episode.id);
    assert.ok(requests.includes('/api/v1/media/register'));
    assert.deepEqual(unexpected, []);
  });
});
