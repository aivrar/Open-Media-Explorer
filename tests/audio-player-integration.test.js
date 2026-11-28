import test from 'node:test';
import assert from 'node:assert/strict';

import { EQ_STORAGE_KEY, loadEqState, saveEqState, setStationEqPreset } from '../src/lib/eq-store.js';
import { resetControlSession } from '../src/lib/capture-client.js';
import { clearDidNotPlay, didNotPlayAt } from '../src/lib/did-not-play.js';
import { didNotPlayNote } from '../src/lib/did-not-play-view.js';
import { createPlayerMeter } from '../src/lib/player-meter.js';
import { getState, loadVolume, normalizeSettings, saveSettings } from '../src/lib/state.js';
import { computerLibrary } from '../src/lib/computer-library.js';
import { makeComputerItem, moveComputerQueue, playComputerEntries } from '../src/lib/computer-play.js';
import { createPlayerDom, FakeElement } from './helpers/fake-dom.js';

class Param {
  constructor(context, value = 0) {
    this.context = context;
    this.initial = value;
    this.events = [];
  }
  get value() {
    const now = this.context.currentTime;
    let previous = { value: this.initial, time: 0 };
    for (const event of this.events) {
      if (event.time > now) {
        if (event.ramp) {
          const fraction = (now - previous.time) / (event.time - previous.time);
          return previous.value + (event.value - previous.value) * fraction;
        }
        break;
      }
      previous = event;
    }
    return previous.value;
  }
  cancelScheduledValues(time) {
    this.events = this.events.filter((event) => event.time < time);
  }
  cancelAndHoldAtTime(time) {
    // Holding an existing ramp truncates it. An idle parameter has no ramp to hold.
    const next = this.events.find((event) => event.time >= time);
    const value = this.value;
    this.cancelScheduledValues(time);
    if (next?.ramp) this.linearRampToValueAtTime(value, time);
  }
  setValueAtTime(value, time) { this.events.push({ value, time }); }
  linearRampToValueAtTime(value, time) { this.events.push({ value, time, ramp: true }); }
  setTargetAtTime(value, time) { this.setValueAtTime(value, time); }
}

class Node {
  constructor() { this.outputs = []; }
  connect(target) { this.outputs.push(target); return target; }
  disconnect() {}
}

class IntegrationAudioContext {
  static instances = [];
  static events = [];
  constructor() {
    this.state = 'suspended';
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.destination = new Node();
    this.elements = new Map();
    this.sourceCount = 0;
    IntegrationAudioContext.instances.push(this);
  }
  createGain() { const node = new Node(); node.gain = new Param(this, 1); return node; }
  createBiquadFilter() {
    const node = new Node();
    node.type = '';
    node.frequency = new Param(this); node.Q = new Param(this); node.gain = new Param(this);
    return node;
  }
  createDynamicsCompressor() {
    const node = new Node();
    for (const name of ['threshold', 'knee', 'ratio', 'attack', 'release']) node[name] = new Param(this);
    return node;
  }
  createAnalyser() {
    const node = new Node();
    node.fftSize = 2048;
    node.smoothingTimeConstant = 0;
    node.getFloatTimeDomainData = (data) => data.fill(0.02);
    node.getByteFrequencyData = (data) => data.fill(this.visualSpectrum ?? 10);
    return node;
  }
  createMediaElementSource(element) {
    if (this.elements.has(element)) throw new Error('duplicate element source');
    const source = new Node();
    this.elements.set(element, source);
    this.sourceCount++;
    return source;
  }
  async resume() { IntegrationAudioContext.events.push('resume'); this.state = 'running'; }
  async suspend() { IntegrationAudioContext.events.push('suspend'); this.state = 'suspended'; }
  async close() { this.state = 'closed'; }
}

class MemoryStorage {
  constructor() { this.data = new Map(); }
  getItem(key) { return this.data.get(key) ?? null; }
  setItem(key, value) { this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
}

const envelope = (status, data, error = null) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => ({ ok: !error, data, error }),
});

function item(id, streamKind, type = 'audio', delivery = 'live') {
  return {
    id: `engine:${id}`, title: id, description: '', source: 'radio-browser', type,
    stream_kind: streamKind, stream_url: `https://media.example/${id}`,
    delivery, capture_headers: {}, thumbnail: '', country: '', language: '',
  };
}

test('player routes relayed audio/video/HLS through one engine without breaking base controls', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  t.mock.method(console, 'warn', () => {});
  const previous = {
    document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch,
    storage: globalThis.localStorage, AudioContext: globalThis.AudioContext,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  };
  const { elements, document } = createPlayerDom();
  const audioMenu = document.register(new FakeElement('player-audio-menu'));
  const audioButton = document.register(new FakeElement('player-audio'));
  audioButton.ownerDocument = document;
  audioButton.focus = () => {};
  audioMenu.matches = () => false;
  audioMenu.replaceChildren = (...rows) => { audioMenu.children = rows; };
  const createElement = document.createElement;
  document.createElement = (name) => {
    const element = createElement(name);
    element.append = (...children) => children.forEach((child) => element.appendChild(child));
    return element;
  };
  const storage = new MemoryStorage();
  storage.setItem(EQ_STORAGE_KEY, JSON.stringify({
    version: 1,
    global: { preamp: -2, bands: [6, 4, 2, 0, 0, 0, 0, 0, 0, 0], presetId: 'test' },
    favorites: {}, customPresets: {},
  }));
  let relayAvailable = true;
  let registration = 0;
  let emptyRelay = '';
  let hlsSupported = false;
  let hlsGate;
  const loadHls = async () => {
    if (hlsGate) await hlsGate;
    return FakeHls;
  };
  const playlist = '/api/v1/computer/hls/converted/index.m3u8';
  const movie = { id: 'converted', kind: 'video', title: 'Local converted movie', duration: 120 };
  const initialAudioContextCount = IntegrationAudioContext.instances.length;
  const context = () => IntegrationAudioContext.instances[initialAudioContextCount];
  const playStates = [];
  for (const el of [elements['audio-el'], elements['video-el']]) {
    const play = el.play.bind(el);
    t.mock.method(el, 'play', () => { playStates.push(context().state); return play(); });
  }
  class FakeHls {
    static Events = { ERROR: 'error' };
    static DefaultConfig = { loader: class {} };
    static isSupported() { return hlsSupported; }
    on() {}
    loadSource(url) { assert.equal(url, playlist); }
    attachMedia(element) {
      assert.equal(element, elements['video-el']);
      element.src = 'blob:local-hls';
    }
    stopLoad() {}
    destroy() {}
  }
  const fetchImpl = async (path, options) => {
    if (path === '/api/v1/session') return envelope(200, { token: 'engine-token' });
    if (path === '/api/v1/computer/play') {
      const { audio = 0 } = JSON.parse(options.body);
      return envelope(200, {
        hls: true, url: playlist, duration: movie.duration, entry: movie, converted: true,
        audio_tracks: [0, 1].map((index) => ({ index, label: 'Track ' + index, selected: index === audio })),
      });
    }
    if (path === '/api/v1/media/register') {
      IntegrationAudioContext.events.push('register');
      if (!relayAvailable) throw new Error('relay offline');
      registration++;
      const media_id = `opaque_engine_media_${String(registration).padStart(8, '0')}`;
      const relay_url = '/api/v1/media/' + media_id;
      if (JSON.parse(options.body).url.endsWith('/empty.m3u8')) emptyRelay = relay_url;
      return envelope(201, { media_id, relay_url });
    }
    if (String(path).endsWith('/expire')) return envelope(200, { expired: true });
    if (path === emptyRelay) {
      const body = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n';
      return new Response(body, {
        headers: {
          'content-type': 'application/vnd.apple.mpegurl',
          'content-length': String(body.length),
        },
      });
    }
    if (String(path).startsWith('/api/v1/media/') && String(path).endsWith('.ts')) {
      return new Response(new Uint8Array([0x47]), {
        status: 206, headers: { 'content-type': 'video/mp2t' },
      });
    }
    if (String(path).startsWith('/api/v1/media/')) {
      return new Response('#EXTM3U\n#EXTINF:4,\n/api/v1/media/probe-segment.ts\n', {
        status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      });
    }
    throw new Error(`unexpected ${path}`);
  };
  globalThis.document = document;
  globalThis.window = {};
  globalThis.fetch = fetchImpl;
  globalThis.localStorage = storage;
  globalThis.AudioContext = IntegrationAudioContext;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaSession: { playbackState: 'none', setActionHandler() {} } },
  });
  resetControlSession();
  let player;
  try {
    player = await import(`../src/lib/player.js?audioIntegration=${Date.now()}`);
    player.initPlayer({ loadHls });

    await player.playItem(item('radio.mp3', 'audio'));
    assert.ok(
      IntegrationAudioContext.events.indexOf('resume') < IntegrationAudioContext.events.indexOf('register'),
      'AudioContext must resume before relay registration yields the user gesture',
    );
    assert.equal(player.getAudioEngineStatus().state, 'ready');
    assert.equal(player.getAudioEngineStatus().sourceCount, 1);
    assert.equal(player.getAudioEngineStatus().curve.preamp, -2);
    assert.equal(elements['audio-el'].paused, false);

    const assignedStation = item('preset.mp3', 'audio', 'radio');
    saveEqState(setStationEqPreset(loadEqState(storage), [assignedStation.id], 'bass-boost'), storage);
    await player.playItem(assignedStation);
    assert.equal(player.getAudioEngineStatus().curve.presetId, 'bass-boost');
    assert.equal(player.getAudioEngineStatus().curve.preamp, -6);
    assert.equal(player.getAudioEngineStatus().sourceCount, 1);
    await player.playItem(item('radio.mp3', 'audio'));
    assert.equal(player.getAudioEngineStatus().curve.preamp, -2);

    player.setVolume(35);
    assert.equal(elements['audio-el'].volume, 0.35);
    assert.equal(elements['video-el'].volume, 0.35);
    // The stepper shows the level and sets it through setVolume.
    assert.equal(elements['player-volume-readout'].textContent, '35');
    assert.equal(elements['player-volume-readout'].getAttribute('aria-label'), 'Volume 35');
    elements['player-volume-up'].dispatchEvent(new Event('click'));
    assert.equal(elements['audio-el'].volume, 0.36);
    assert.equal(elements['player-volume'].value, '36');
    assert.equal(elements['player-volume-readout'].textContent, '36');
    elements['player-volume-down'].dispatchEvent(new Event('click'));
    assert.equal(elements['audio-el'].volume, 0.35);

    // The video's own controls: its volume becomes the user's volume, as if
    // the buttons had been used (store, readout, the audio element, saved).
    const video = elements['video-el'];
    let videoWrites = 0;
    const videoVolume = Object.getOwnPropertyDescriptor(video, 'volume');
    Object.defineProperty(video, 'volume', {
      configurable: true,
      get: () => videoVolume.value,
      set: (value) => { videoWrites += 1; videoVolume.value = value; },
    });
    video.volume = 0.4537;
    videoWrites = 0;
    video.emit('volumechange');
    assert.equal(elements['player-volume'].value, '45');
    assert.equal(elements['player-volume-readout'].textContent, '45');
    assert.equal(elements['player-volume-readout'].getAttribute('aria-label'), 'Volume 45');
    assert.equal(elements['player-volume-control'].title, 'Volume 45%');
    assert.equal(elements['audio-el'].volume, 0.45);
    assert.equal(loadVolume(), 45);
    // Not written back: no rounding drift on the element being dragged.
    assert.equal(videoWrites, 0);
    assert.equal(video.volume, 0.4537);
    // Our own change echoing back as a volumechange changes nothing.
    video.emit('volumechange');
    elements['audio-el'].emit('volumechange');
    assert.equal(videoWrites, 0);
    assert.equal(elements['player-volume'].value, '45');
    // The buttons still move both elements from there.
    elements['player-volume-up'].dispatchEvent(new Event('click'));
    assert.equal(video.volume, 0.46);
    assert.equal(elements['audio-el'].volume, 0.46);
    video.volume = 0;
    video.emit('volumechange');
    assert.equal(elements['player-volume-readout'].textContent, '0');
    assert.equal(elements['player-mute'].dataset.silent, 'true');
    video.volume = 0.7;
    video.emit('volumechange');
    assert.equal(elements['player-mute'].dataset.silent, 'false');
    // Its mute button: the player's mute follows, both elements and the icon.
    video.muted = true;
    video.emit('volumechange');
    assert.equal(elements['player-mute'].getAttribute('aria-pressed'), 'true');
    assert.equal(elements['player-mute'].dataset.silent, 'true');
    assert.equal(elements['audio-el'].muted, true);
    assert.equal(player.isMuted(), true);
    video.muted = false;
    video.emit('volumechange');
    assert.equal(elements['player-mute'].getAttribute('aria-pressed'), 'false');
    assert.equal(elements['audio-el'].muted, false);
    // A sleep-timer fade lowers the elements; that is not the user's volume.
    video.dataset.preFadeVol = '0.7';
    elements['audio-el'].dataset.preFadeVol = '0.7';
    video.volume = 0.1;
    video.emit('volumechange');
    assert.equal(elements['player-volume'].value, '70');
    assert.equal(loadVolume(), 70);
    delete video.dataset.preFadeVol;
    delete elements['audio-el'].dataset.preFadeVol;
    video.volume = 0.7;
    video.emit('volumechange');
    assert.equal(elements['player-volume'].value, '70');
    delete video.volume;
    video.volume = videoVolume.value;
    player.setVolume(35);
    player.setMuted(true);
    assert.equal(elements['audio-el'].muted, true);
    assert.equal(elements['video-el'].muted, true);
    await player.togglePlay();
    assert.equal(elements['audio-el'].paused, true);
    await player.togglePlay();
    assert.equal(elements['audio-el'].paused, false);

    // A film listed as on demand: its seek bar and position (one listed as
    // live would stay live with any length).
    await player.playItem(item('movie.mp4', 'video', 'video', 'on-demand'));
    assert.equal(player.getAudioEngineStatus().sourceCount, 2);
    assert.equal(elements['video-el'].paused, false);
    elements['video-el'].duration = 120;
    elements['video-el'].currentTime = 12;
    elements['video-el'].emit('durationchange');
    elements['video-el'].emit('timeupdate');
    assert.equal(elements['player-seek'].disabled, false);
    assert.equal(elements['player-time'].textContent, '0:12');

    await player.playItem(item('channel.m3u8', 'hls', 'tv'));
    assert.equal(player.getAudioEngineStatus().sourceCount, 2, 'HLS must reuse the video element source');
    assert.equal(elements['video-el'].crossOrigin, 'anonymous');
    assert.equal(IntegrationAudioContext.instances.length, 1);
    assert.equal(IntegrationAudioContext.instances[0].sourceCount, 2);

    const tick = () => new Promise((resolve) => setImmediate(resolve));
    const empty = { ...item('empty.m3u8', 'hls', 'tv'), _extra: { streamCandidates: [] } };
    const originalFavorites = getState().favorites;
    getState().favorites = [empty];
    try {
      const starting = player.playItem(empty);
      await tick();
      for (let second = 0; second < 11; second++) {
        t.mock.timers.tick(1_000);
        await tick();
      }
      assert.equal(didNotPlayAt(empty.id), 0);
      t.mock.timers.tick(1_000);
      await starting;
      assert.match(didNotPlayNote(empty), /Did not play last time/);
      getState().favorites = [];
      assert.equal(didNotPlayNote(empty), '', 'the outcome is shown only for a saved item');
    } finally {
      getState().favorites = originalFavorites;
      clearDidNotPlay(empty.id);
    }
    hlsSupported = true;
    const registrationsBeforeFile = registration;
    let releaseHls;
    hlsGate = new Promise((resolve) => { releaseHls = resolve; });
    const startingFilm = player.playItem(makeComputerItem(movie));
    await tick();
    assert.equal(video.paused, true);
    t.mock.timers.tick(3_000);
    assert.equal(context().state, 'running', 'an attached source waiting for HLS is a pending start');
    releaseHls();
    await startingFilm;
    assert.equal(registration, registrationsBeforeFile);
    assert.equal(player.getAudioEngineStatus().sourceCount, 2);
    assert.equal(player.getAudioEngineStatus().state, 'ready');
    assert.equal(video.crossOrigin, 'anonymous');
    assert.equal(video.paused, false);
    video.emit('waiting');
    t.mock.timers.tick(3_000);
    assert.equal(context().state, 'running', 'a buffering stall keeps playing intent');

    hlsGate = new Promise((resolve) => { releaseHls = resolve; });
    audioMenu.children[1].dispatchEvent(new Event('click'));
    await tick();
    assert.equal(video.paused, true, 'the old film source has been detached');
    t.mock.timers.tick(3_000);
    assert.equal(context().state, 'running', 'the audio-track change keeps the graph awake');
    releaseHls();
    await tick();
    assert.equal(video.paused, false);

    player.setMuted(false);
    const frames = [];
    let displayFrame;
    const { requestAnimationFrame, cancelAnimationFrame } = globalThis;
    globalThis.requestAnimationFrame = (callback) => { displayFrame = callback; return 1; };
    globalThis.cancelAnimationFrame = () => {};
    const unsubscribe = player.getAudioSignal().subscribe(({ active, rms }) => frames.push({ active, rms }));
    try {
      assert.equal(typeof displayFrame, 'function');
      displayFrame(performance.now());
      assert.equal(frames[0]?.active, true, 'the level meter and Visualizer share the readable audio tap');
      assert.ok(frames[0].rms > 0);
      video.pause();
      t.mock.timers.tick(2_999);
      assert.equal(context().state, 'running');
      assert.deepEqual(frames.at(-1), { active: false, rms: 0 });
      assert.equal(player.getAudioSignal().scheduled, false);
      t.mock.timers.tick(1);
      await Promise.resolve();
      assert.equal(context().state, 'suspended');
      player.setVolume(42);

      const eventsBeforePlay = IntegrationAudioContext.events.length;
      video.paused = false;
      video.emit('play'); // The browser's native video control bypasses player.togglePlay().
      assert.equal(context().state, 'running');
      assert.deepEqual(IntegrationAudioContext.events.slice(eventsBeforePlay), ['resume']);
      await tick();
      video.emit('playing');
      assert.equal(video.volume, 0.42);
      displayFrame(performance.now());
      assert.equal(frames.at(-1).active, true);
      video.ended = true;
      video.emit('ended');
      t.mock.timers.tick(3_000);
      assert.equal(context().state, 'suspended', 'a converted film ending leaves the graph idle');
    } finally {
      unsubscribe();
      globalThis.requestAnimationFrame = requestAnimationFrame;
      globalThis.cancelAnimationFrame = cancelAnimationFrame;
    }

    relayAvailable = false;
    await player.playItem(item('unsafe-direct.mp3', 'audio'));
    assert.equal(elements['audio-el'].paused, true);
    assert.equal(elements['audio-el'].src, '', 'relay failure must not attach the remote URL directly');
    assert.match(elements['player-source'].textContent, /Secure media relay unavailable/);
    assert.equal(player.getAudioEngineStatus().state, 'ready');

    t.mock.timers.tick(3_000);
    assert.equal(context().state, 'suspended');
    relayAvailable = true;
    await player.playItem(item('radio-recovered.mp3', 'audio'));
    assert.equal(elements['audio-el'].paused, false);
    assert.equal(player.getAudioEngineStatus().state, 'ready');
    assert.equal(player.getAudioEngineStatus().sourceCount, 2);
    assert.ok(playStates.length > 0 && playStates.every((state) => state === 'running'));
    player.stop();
    t.mock.timers.tick(3_000);
    assert.equal(context().state, 'suspended', 'Stop lets the graph rest');
  } finally {
    if (player?.getCurrentItem()) {
      player.stop();
      t.mock.timers.tick(3_000);
    }
    resetControlSession();
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    globalThis.fetch = previous.fetch;
    globalThis.localStorage = previous.storage;
    globalThis.AudioContext = previous.AudioContext;
    if (previous.navigator) Object.defineProperty(globalThis, 'navigator', previous.navigator);
    else delete globalThis.navigator;
  }
});

test('Computer playback levels the next sound on the shared audio graph and measures just the queue pair', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { document, elements } = createPlayerDom();
  const audio = elements['audio-el'];
  const video = elements['video-el'];
  const storage = new MemoryStorage();
  const settings = getState().settings;
  const contextIndex = IntegrationAudioContext.instances.length;
  const context = () => IntegrationAudioContext.instances[contextIndex];
  const gain = () => context()?.elements.get(audio)?.outputs[0].gain;
  const song = (id, fields = {}) => ({ id, kind: 'audio', title: id, artist: 'Artist', ext: 'flac', ...fields });
  const tagged = song('tagged', { rg_track_gain: -8.4, rg_album_gain: -3, rg_track_peak: 1, rg_album_peak: 0.5 });
  const book = song('book', { ext: 'm4b', rg_track_gain: -20 });
  const movie = { id: 'video', kind: 'video', title: 'Video', rg_track_gain: -20 };
  const failure = song('failed', { rg_track_gain: -10 });
  const unknown = song('unknown');
  const prefetched = song('prefetched');
  const after = song('after');
  const waiting = song('waiting');
  const album = [-2, -4, -6, -8].map((db) => song('album' + db, { rg_track_gain: db }));
  const files = [tagged, book, movie, failure, unknown, prefetched, after, waiting, ...album];
  const pending = [];
  const requests = [];
  let relayCount = 0;
  const playStarts = [];
  const playAudio = audio.play.bind(audio);
  t.mock.method(audio, 'play', async () => {
    playStarts.push([audio.src, gain()?.value ?? 1, context().state, audio.volume]);
    if (audio.src.endsWith('/failed')) throw new Error('start failed');
    await playAudio();
  });
  const playVideo = video.play.bind(video);
  t.mock.method(video, 'play', async () => {
    playStarts.push([video.src, gain()?.value ?? 1, context().state, video.volume]);
    await playVideo();
  });
  t.mock.method(console, 'warn', () => {});
  const previous = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch,
    localStorage: globalThis.localStorage, AudioContext: globalThis.AudioContext };
  Object.assign(globalThis, {
    document, window: {}, localStorage: storage, AudioContext: IntegrationAudioContext,
    fetch: async (path, options) => {
      if (path === '/api/v1/session') return envelope(200, { token: 'computer-player' });
      if (path === '/api/v1/computer/library') return envelope(200, { items: files, generation: 1, revision: 1 });
      if (path === '/api/v1/computer/play') {
        const { id } = JSON.parse(options.body);
        const entry = files.find((file) => file.id === id);
        return envelope(200, { entry, kind: entry.kind, url: '/api/v1/computer/media/' + id });
      }
      if (path === '/api/v1/computer/loudness') {
        const { id } = JSON.parse(options.body);
        assert.equal(options.method, 'POST');
        assert.equal(options.headers['X-WorldMedia-Token'], 'computer-player');
        requests.push(id);
        return new Promise((resolve) => pending.push({ id, signal: options.signal, resolve }));
      }
      if (path === '/api/v1/media/register') {
        const id = 'opaque_engine_media_' + String(++relayCount).padStart(8, '0');
        return envelope(201, { media_id: id, relay_url: '/api/v1/media/' + id });
      }
      if (String(path).endsWith('/expire')) return envelope(200, { expired: true });
      throw new Error('Unexpected request ' + path);
    },
  });
  resetControlSession();
  getState().settings = normalizeSettings({ soundMeter: false, tabsShown: { visualizer: false } });
  storage.setItem(EQ_STORAGE_KEY, JSON.stringify({ version: 1, global: { bypassed: true } }));
  const player = await import('../src/lib/player.js?computerLevellingIntegration');
  const choose = (file) => player.playItem(makeComputerItem(file));
  const value = (db) => 10 ** (db / 20);
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} vs ${expected}`);
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  try {
    player.initPlayer();
    await computerLibrary.ensureComputerLibrary();
    assert.equal(context(), undefined);
    assert.equal(getState().settings.volumeLevelling, 'off');
    await choose(tagged);
    assert.equal(player.getAudioEngineStatus().curve.bypassed, true);
    assert.equal(context()?.state, 'running');
    assert.ok(context().elements.has(audio));
    assert.equal(gain().value, 1);
    assert.equal(playStarts.at(-1)[1], 1);
    assert.deepEqual(requests, []);

    player.setMuted(false);
    const { requestAnimationFrame, cancelAnimationFrame } = globalThis;
    let displayFrame;
    let signal;
    globalThis.requestAnimationFrame = (callback) => { displayFrame = callback; return 1; };
    globalThis.cancelAnimationFrame = () => {};
    const unsubscribe = player.getAudioSignal().subscribe((frame) => { signal = frame; });
    try {
      displayFrame(performance.now());
      assert.equal(signal?.active, true);
      assert.ok(signal.rms > 0);
    } finally {
      unsubscribe();
      Object.assign(globalThis, { requestAnimationFrame, cancelAnimationFrame });
    }

    player.stop();
    saveSettings({ volumeLevelling: 'track', levellingPreamp: 2 });
    await choose(tagged);
    assert.equal(playStarts.at(-1)[1], value(-6.4), 'levelling applies before the song starts');
    await player.togglePlay();
    t.mock.timers.tick(3_000);
    assert.equal(context().state, 'suspended');
    saveSettings({ levellingPreamp: 4 });
    player.setVolume(37);
    await player.togglePlay();
    assert.deepEqual(playStarts.at(-1).slice(1), [value(-4.4), 'running', 0.37]);
    saveSettings({ levellingPreamp: 2 });

    const radio = item('radio-level.mp3', 'audio');
    await player.playItem(radio);
    assert.equal(playStarts.at(-1)[1], 1);
    const stage = context().elements.get(audio).outputs[0];
    const graphInput = stage.outputs[0];
    assert.equal(graphInput.outputs.length, 2, 'one levelling stage feeds both dry and EQ paths');
    await choose({ ...tagged, rg_track_gain: 15 });
    assert.equal(playStarts.at(-1)[1], value(-6.4), 'fresh play tags are in effect before play()');
    assert.equal(elements['player-source'].textContent, 'Artist · -6.4 dB');
    assert.match(elements['player-source'].title, /Volume levelling: track gain -8.4 dB, pre-amp \+2 dB/);
    assert.equal(player.getCurrentItem()._extra.computer.rg_album_gain, -3);
    assert.deepEqual(requests, []);

    const trackGain = value(-6.4);
    context().currentTime = 13;
    saveSettings({ volumeLevelling: 'off' });
    assert.equal(player.getComputerLevellingDetails('computer:tagged'), null);
    near(gain().value, trackGain);
    context().currentTime = 13.1;
    const fraction = (gain().value - trackGain) / (1 - trackGain);
    assert.ok(fraction > 0 && fraction < 0.1, '100 ms covers less than 10% of the ramp');
    context().currentTime = 13.75;
    near(gain().value, (trackGain + 1) / 2);
    context().currentTime = 14.5;
    near(gain().value, 1);

    saveSettings({ volumeLevelling: 'track' });
    context().currentTime = 15.25;
    const halfway = (1 + trackGain) / 2;
    near(gain().value, halfway);
    saveSettings({ levellingPreamp: 4 });
    near(gain().value, halfway);
    context().currentTime = 16;
    near(gain().value, (halfway + value(-4.4)) / 2);
    context().currentTime = 16.75;
    near(gain().value, value(-4.4));

    context().currentTime = 20;
    saveSettings({ volumeLevelling: 'album', levellingPreamp: 2 });
    assert.equal(player.getComputerLevellingDetails('computer:tagged').text, '-1 dB');
    assert.match(elements['player-source'].title, /album gain -3 dB/);
    await player.playItem(radio);
    assert.equal(playStarts.at(-1)[1], 1, 'radio starts at unity during a song ramp');
    assert.equal(context().elements.get(audio).outputs[0], stage);
    await choose(book);
    assert.equal(playStarts.at(-1)[1], 1);
    assert.doesNotMatch(elements['player-source'].textContent, /dB/);
    await choose(tagged);
    await choose(movie);
    assert.equal(playStarts.at(-1)[1], 1);
    assert.equal(context().elements.get(video).outputs[0], graphInput);
    await choose(failure);
    assert.equal(playStarts.at(-1)[1], value(-8));
    assert.equal(gain().value, 1);
    await player.playItem(radio);
    assert.equal(playStarts.at(-1)[1], 1);
    assert.equal(context().sourceCount, 2, 'audio and video each keep one MediaElementAudioSourceNode');
    assert.ok(playStarts.every(([, , state]) => state === 'running'), 'songs, films, audiobooks and radio start with the graph running');

    saveSettings({ volumeLevelling: 'track', levellingPreamp: 0 });
    await playComputerEntries([unknown, prefetched, after], 0, { play: player.playItem });
    await tick();
    assert.equal(playStarts.at(-1)[1], 1);
    assert.deepEqual(requests, ['unknown', 'prefetched']);
    pending[0].resolve(envelope(200, { id: 'unknown', rg_track_gain: -5, rg_track_peak: 1, rg_measured: true }));
    await tick();
    near(gain().value, 1);
    context().currentTime += 0.75;
    near(gain().value, (1 + value(-5)) / 2);
    context().currentTime += 0.75;
    near(gain().value, value(-5));
    assert.match(elements['player-source'].title, /track gain -5 dB \(measured\)/);
    assert.equal(player.getCurrentItem()._extra.computer.rg_measured, true);
    assert.equal(computerLibrary.getComputerLibrary().items.find(({ id }) => id === 'unknown').rg_track_gain, -5);
    pending[1].resolve(envelope(200, { id: 'prefetched', rg_track_gain: -9, rg_track_peak: 1, rg_measured: true }));
    await tick();

    await moveComputerQueue(1);
    await tick();
    assert.equal(playStarts.at(-1)[1], value(-9), 'a completed prefetch also covers an older play reply');
    assert.deepEqual(requests, ['unknown', 'prefetched', 'after']);
    await moveComputerQueue(1);
    await tick();
    assert.equal(pending[2].signal.aborted, false, 'the next request becomes the current request');
    await player.playItem(radio);
    assert.equal(pending[2].signal.aborted, true);
    pending[2].resolve(envelope(200, { id: 'after', rg_track_gain: -22, rg_track_peak: 1, rg_measured: true }));
    await tick();
    assert.equal(gain().value, 1);
    assert.equal(computerLibrary.getComputerLibrary().items.find(({ id }) => id === 'after').rg_track_gain, undefined);

    await playComputerEntries([after, waiting], 0, { play: player.playItem });
    await tick();
    const current = pending.findLast(({ id }) => id === 'after');
    const next = pending.findLast(({ id }) => id === 'waiting');
    saveSettings({ volumeLevelling: 'off' });
    assert.ok(current.signal.aborted && next.signal.aborted);
    const requestCount = requests.length;
    await choose(tagged);
    assert.equal(playStarts.at(-1)[1], 1);
    assert.equal(requests.length, requestCount);
    assert.doesNotMatch(elements['player-source'].textContent, /dB/);

    saveSettings({ volumeLevelling: 'track' });
    const secondAudio = elements['computer-audio-el'];
    const inputGain = (el) => context().elements.get(el).outputs[0].gain.value;
    const starts = [];
    let holdPlay;
    let releasePlay;
    for (const el of [audio, secondAudio]) {
      const play = el.play.bind(el);
      t.mock.method(el, 'play', () => {
        starts.push([el, inputGain(el), context().state]);
        if (el === holdPlay) return new Promise((resolve) => { releasePlay = () => resolve(play()); });
        return play();
      });
    }
    await playComputerEntries(album, 0, { play: player.playItem });
    let renderSignal;
    let signalTime = performance.now();
    const signalClock = t.mock.method(performance, 'now', () => signalTime);
    let signalFrame;
    globalThis.requestAnimationFrame = (callback) => { renderSignal = callback; return 1; };
    globalThis.cancelAnimationFrame = () => {};
    const sharedSignal = player.getAudioSignal();
    const stopSignal = sharedSignal.subscribe((frame) => { signalFrame = frame; });
    const canvas = { getContext: () => ({ clearRect() {}, beginPath() {}, rect() {}, fill() {} }) };
    const meter = createPlayerMeter({ canvas, signal: sharedSignal, win: {}, doc: null });
    meter.resize(90, 36);
    context().visualSpectrum = 95;
    t.after(() => {
      meter.destroy();
      signalClock.mock.restore();
      stopSignal();
      Object.assign(globalThis, { requestAnimationFrame, cancelAnimationFrame });
    });
    function visualVersion() {
      renderSignal(signalTime += 100);
      assert.equal(signalFrame.active, true);
      return signalFrame.version;
    }
    const version = visualVersion();
    const tapVersion = signalFrame.tapVersion;
    const { starts: signalStarts, stops: signalStops } = player.getAudioSignal().stats;
    let active = audio;
    let standby = secondAudio;
    for (const [index, nextTrack] of album.slice(1).entries()) {
      active.duration = 120;
      active.currentTime = 100;
      active.emit('timeupdate');
      await tick();
      assert.equal(inputGain(active), value(album[index].rg_track_gain));
      assert.equal(inputGain(standby), value(nextTrack.rg_track_gain));
      assert.equal(context().elements.get(standby).outputs[0].outputs[0], graphInput);
      assert.equal(standby.paused, true);
      assert.equal(visualVersion(), version, 'preloading keeps the current visualizer source');
      standby.readyState = 4;
      standby.emit('canplaythrough');
      const meterBefore = meter.state.levels.slice();
      const gainBefore = meter.state.trackedDb.slice();
      assert.ok(meterBefore.some((level) => level > 0));
      active.ended = active.paused = true;
      active.emit('ended');
      assert.deepEqual(starts.at(-1), [standby, value(nextTrack.rg_track_gain), 'running']);
      assert.equal(player.getCurrentItem().id, 'computer:' + nextTrack.id);
      assert.equal(player.getComputerLevellingDetails(player.getCurrentItem().id).text, nextTrack.rg_track_gain + ' dB');
      assert.equal(elements['player-title'].textContent, nextTrack.title);
      context().visualSpectrum = 255;
      assert.equal(visualVersion(), version, 'promotion keeps the visualizer source');
      assert.equal(signalFrame.spectrum[0], 255, 'the shared tap exposes the boundary sample');
      assert.deepEqual(meter.state.levels, meterBefore, 'the boundary sample does not light the meter');
      assert.deepEqual(meter.state.trackedDb, gainBefore, 'the meter keeps its gain history');
      context().visualSpectrum = 95;
      visualVersion();
      assert.equal(signalFrame.tapVersion, tapVersion, 'promotion keeps the analyser node');
      assert.equal(player.getAudioSignal().stats.starts, signalStarts);
      assert.equal(player.getAudioSignal().stats.stops, signalStops);
      [active, standby] = [standby, active];
    }
    assert.equal(active, secondAudio);
    context().currentTime += 10;
    saveSettings({ volumeLevelling: 'off' });
    const promotedGain = value(album.at(-1).rg_track_gain);
    near(inputGain(active), promotedGain);
    context().currentTime += 0.75;
    near(inputGain(active), (promotedGain + 1) / 2);
    context().currentTime += 0.75;
    near(inputGain(active), 1);
    assert.equal(starts.length, 4);
    assert.equal(context().sourceCount, 3, 'each of the two audio elements and video has one source');
    await player.playItem(radio);
    assert.deepEqual(starts.at(-1), [audio, 1, 'running']);
    assert.equal(secondAudio.src, '');
    assert.equal(audio.crossOrigin, 'anonymous');

    stopSignal();
    meter.destroy();
    player.stop();
    await playComputerEntries(album.slice(0, 3), 0, { play: player.playItem });
    async function prepareHandoff(outgoing, incoming) {
      outgoing.duration = 120;
      outgoing.currentTime = 100;
      outgoing.emit('timeupdate');
      await tick();
      incoming.readyState = 4;
      incoming.emit('canplaythrough');
    }

    await prepareHandoff(audio, secondAudio);
    holdPlay = secondAudio;
    audio.ended = audio.paused = true;
    audio.emit('ended');
    assert.equal(typeof releasePlay, 'function');
    t.mock.timers.tick(3_000);
    assert.equal(context().state, 'running', 'the gapless handoff is pending');
    releasePlay();
    holdPlay = null;
    await tick();

    await prepareHandoff(secondAudio, audio);
    context().state = 'suspended'; // WebView may suspend the context independently.
    secondAudio.ended = secondAudio.paused = true;
    secondAudio.emit('ended');
    await tick();
    assert.deepEqual(starts.at(-1), [audio, 1, 'running'], 'promotion resumes even after a WebView interruption');
    assert.equal(audio.paused, false);

    player.stop();
    saveSettings({ volumeLevelling: 'off' });
    const live = await import('../src/lib/player.js?computerLevellingLiveIntegration');
    const liveContextIndex = IntegrationAudioContext.instances.length;
    try {
      live.initPlayer();
      await live.playItem(makeComputerItem(tagged));
      const liveContext = IntegrationAudioContext.instances[liveContextIndex];
      const liveGain = liveContext.elements.get(audio).outputs[0].gain;
      saveSettings({ soundMeter: true });
      await tick();
      assert.equal(liveContext.sourceCount, 1);
      assert.equal(liveGain.value, 1);
      saveSettings({ soundMeter: false, volumeLevelling: 'track' });
      near(liveGain.value, 1);
      liveContext.currentTime = 1.5;
      near(liveGain.value, value(-8.4));
    } finally {
      live.stop();
    }
  } finally {
    player.stop();
    t.mock.timers.tick(3_000);
    getState().settings = settings;
    resetControlSession();
    Object.assign(globalThis, previous);
  }
});
