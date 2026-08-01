import test from 'node:test';
import assert from 'node:assert/strict';

import { EQ_STORAGE_KEY } from '../src/lib/eq-store.js';
import { resetControlSession } from '../src/lib/capture-client.js';
import { createPlayerDom } from './helpers/fake-dom.js';

class Param {
  constructor(value = 0) { this.value = value; }
  cancelScheduledValues() {}
  setValueAtTime(value) { this.value = value; }
  setTargetAtTime(value) { this.value = value; }
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
    this.elements = new Set();
    this.sourceCount = 0;
    IntegrationAudioContext.instances.push(this);
  }
  createGain() { const node = new Node(); node.gain = new Param(1); return node; }
  createBiquadFilter() {
    const node = new Node();
    node.type = '';
    node.frequency = new Param(); node.Q = new Param(); node.gain = new Param();
    return node;
  }
  createDynamicsCompressor() {
    const node = new Node();
    for (const name of ['threshold', 'knee', 'ratio', 'attack', 'release']) node[name] = new Param();
    return node;
  }
  createAnalyser() {
    const node = new Node();
    node.fftSize = 2048;
    node.smoothingTimeConstant = 0;
    node.getFloatTimeDomainData = (data) => data.fill(0.02);
    return node;
  }
  createMediaElementSource(element) {
    if (this.elements.has(element)) throw new Error('duplicate element source');
    this.elements.add(element);
    this.sourceCount++;
    return new Node();
  }
  async resume() { IntegrationAudioContext.events.push('resume'); this.state = 'running'; }
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

function item(id, streamKind, type = 'audio') {
  return {
    id: `engine:${id}`, title: id, description: '', source: 'radio-browser', type,
    stream_kind: streamKind, stream_url: `https://media.example/${id}`,
    delivery: 'live', capture_headers: {}, thumbnail: '', country: '', language: '',
  };
}

test('player routes relayed audio/video/HLS through one engine without breaking base controls', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const previous = {
    document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch,
    storage: globalThis.localStorage, AudioContext: globalThis.AudioContext,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  };
  const { elements, document } = createPlayerDom();
  const storage = new MemoryStorage();
  storage.setItem(EQ_STORAGE_KEY, JSON.stringify({
    version: 1,
    global: { preamp: -2, bands: [6, 4, 2, 0, 0, 0, 0, 0, 0, 0], presetId: 'test' },
    favorites: {}, customPresets: {},
  }));
  let relayAvailable = true;
  let registration = 0;
  const fetchImpl = async (path) => {
    if (path === '/api/v1/session') return envelope(200, { token: 'engine-token' });
    if (path === '/api/v1/media/register') {
      IntegrationAudioContext.events.push('register');
      if (!relayAvailable) throw new Error('relay offline');
      registration++;
      return envelope(201, {
        media_id: `opaque_engine_media_${String(registration).padStart(8, '0')}`,
        relay_url: `/api/v1/media/opaque_engine_media_${String(registration).padStart(8, '0')}`,
      });
    }
    if (String(path).endsWith('/expire')) return envelope(200, { expired: true });
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
  try {
    const player = await import(`../src/lib/player.js?audioIntegration=${Date.now()}`);
    player.initPlayer();

    await player.playItem(item('radio.mp3', 'audio'));
    assert.ok(
      IntegrationAudioContext.events.indexOf('resume') < IntegrationAudioContext.events.indexOf('register'),
      'AudioContext must resume before relay registration yields the user gesture',
    );
    assert.equal(player.getAudioEngineStatus().state, 'ready');
    assert.equal(player.getAudioEngineStatus().sourceCount, 1);
    assert.equal(player.getAudioEngineStatus().curve.preamp, -2);
    assert.equal(elements['audio-el'].paused, false);

    player.setVolume(35);
    assert.equal(elements['audio-el'].volume, 0.35);
    assert.equal(elements['video-el'].volume, 0.35);
    player.setMuted(true);
    assert.equal(elements['audio-el'].muted, true);
    assert.equal(elements['video-el'].muted, true);
    await player.togglePlay();
    assert.equal(elements['audio-el'].paused, true);
    await player.togglePlay();
    assert.equal(elements['audio-el'].paused, false);

    await player.playItem(item('movie.mp4', 'video', 'video'));
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

    relayAvailable = false;
    await player.playItem(item('unsafe-direct.mp3', 'audio'));
    assert.equal(elements['audio-el'].paused, true);
    assert.equal(elements['audio-el'].src, '', 'relay failure must not attach the remote URL directly');
    assert.match(elements['player-source'].textContent, /Secure media relay unavailable/);
    assert.equal(player.getAudioEngineStatus().state, 'ready');

    relayAvailable = true;
    await player.playItem(item('radio-recovered.mp3', 'audio'));
    assert.equal(elements['audio-el'].paused, false);
    assert.equal(player.getAudioEngineStatus().state, 'ready');
    assert.equal(player.getAudioEngineStatus().sourceCount, 2);
  } finally {
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
