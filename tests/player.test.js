import test from 'node:test';
import assert from 'node:assert/strict';

import { createPlayerDom } from './helpers/fake-dom.js';
import { getState, subscribe } from '../src/lib/state.js';

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

test('player owns lifecycle state across pause, errors, rejection, stop, and rapid switches', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { elements, document } = createPlayerDom();
  const mediaActions = new Map();
  const mediaSession = {
    playbackState: 'none',
    setActionHandler(name, handler) { mediaActions.set(name, handler); },
  };
  globalThis.document = document;
  globalThis.window = {};
  let relayUnavailable = false;
  let mediaRegistrations = 0;
  let lazyResolutionSignal = null;
  let announceLazyResolution;
  const mediaPriorities = [];
  const unbindPriority = subscribe('media-priority-change', (active) => mediaPriorities.push(active));
  t.after(unbindPriority);
  const lazyResolutionStarted = new Promise((resolve) => { announceLazyResolution = resolve; });
  globalThis.fetch = async (path, options = {}) => {
    if (String(path) === 'https://api.media.ccc.de/public/events/player-slow') {
      lazyResolutionSignal = options.signal;
      announceLazyResolution();
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          reject(options.signal.reason || new DOMException('Cancelled', 'AbortError'));
        }, { once: true });
      });
    }
    if (path === '/api/v1/session') return apiResponse(200, {
      ok: true, data: { token: 'player-test-session' }, error: null,
    });
    if (path === '/api/v1/media/register' && options.method === 'POST') {
      if (relayUnavailable) return apiResponse(503, {
        ok: false,
        data: null,
        error: { code: 'RELAY_UNAVAILABLE', message: 'Relay unavailable.', retryable: true },
      });
      mediaRegistrations++;
      return apiResponse(201, {
        ok: true,
        data: {
          media_id: 'player_test_media_1234567890',
          relay_url: '/api/v1/media/player_test_media_1234567890',
        },
        error: null,
      });
    }
    if (String(path).endsWith('/expire')) return apiResponse(202, {
      ok: true, data: { state: 'expired' }, error: null,
    });
    throw new Error(`Unexpected player request: ${path}`);
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaSession },
  });

  const player = await import(`../src/lib/player.js?phase1=${Date.now()}`);
  player.initPlayer();

  const audioItem = item('audio-one', 'audio', 'audio');
  await player.playItem(audioItem);
  assertPlaying(elements, true);
  assert.equal(mediaPriorities.at(-1), true);

  // An element that is not active cannot overwrite the visible state.
  elements['video-el'].emit('pause');
  elements['video-el'].emit('emptied');
  elements['video-el'].emit('error');
  assertPlaying(elements, true);

  const videoItem = item('video-one', 'video', 'video');
  await player.playItem(videoItem);
  assertPlaying(elements, true);

  // Switching removed the old generation's audio listeners.
  elements['audio-el'].emit('pause');
  elements['audio-el'].emit('emptied');
  elements['audio-el'].emit('error');
  assertPlaying(elements, true);

  elements['video-el'].duration = 125;
  elements['video-el'].currentTime = 5;
  elements['video-el'].emit('durationchange');
  elements['video-el'].emit('timeupdate');
  assert.equal(elements['player-time'].textContent, '0:05');
  assert.equal(elements['player-dur'].textContent, '2:05');
  assert.equal(elements['player-seek'].disabled, false);

  elements['video-el'].pause();
  assertPlaying(elements, false);
  assert.equal(mediaPriorities.at(-1), false);
  await player.togglePlay();
  assertPlaying(elements, true);
  assert.equal(mediaPriorities.at(-1), true);

  // A transient media error during a still-pending play attempt must not pause
  // or poison an attempt that subsequently succeeds.
  const ordinaryVideoPlay = elements['video-el'].play.bind(elements['video-el']);
  elements['video-el'].play = () => new Promise((resolve) => {
    elements['video-el'].emit('error');
    setImmediate(() => {
      elements['video-el'].paused = false;
      elements['video-el'].emit('play');
      elements['video-el'].emit('playing');
      resolve();
    });
  });
  await player.playItem(item('video-negotiated', 'video', 'video'));
  assertPlaying(elements, true);
  assert.equal(elements['player-source'].textContent, 'Internet Archive');
  assert.equal(elements['player-next-broken'].hidden, true);
  elements['video-el'].play = ordinaryVideoPlay;

  elements['video-el'].paused = true;
  elements['video-el'].ended = true;
  elements['video-el'].emit('ended');
  assertPlaying(elements, false);
  elements['video-el'].ended = false;

  // Active errors leave a resumable Play affordance and rebuild the poisoned
  // relay/media element instead of repeating play() against its error state.
  elements['video-el'].paused = true;
  elements['video-el'].emit('error');
  assertPlaying(elements, false);
  assert.equal(elements['player-play'].hidden, false);
  assert.equal(elements['player-next-broken'].hidden, false);
  const registrationsBeforeRetry = mediaRegistrations;
  await player.togglePlay();
  assertPlaying(elements, true);
  assert.equal(elements['player-next-broken'].hidden, true);
  assert.equal(mediaRegistrations, registrationsBeforeRetry + 1);

  // A rejected play promise never leaves a Pause icon behind.
  elements['video-el'].playError = new Error('blocked');
  await player.playItem(item('video-blocked', 'video', 'video'));
  assertPlaying(elements, false);
  assert.equal(elements['player-play'].hidden, false);
  assert.equal(elements['player-next-broken'].hidden, true);
  elements['video-el'].playError = null;
  await player.togglePlay();
  assertPlaying(elements, true);
  assert.equal(elements['player-source'].textContent, 'Internet Archive');

  // Rapid switching invalidates the unresolved first generation.
  let resolveOldPlay;
  const normalAudioPlay = elements['audio-el'].play.bind(elements['audio-el']);
  elements['audio-el'].play = () => new Promise((resolve) => { resolveOldPlay = resolve; });
  const oldPlay = player.playItem(item('audio-slow', 'audio', 'audio'));
  await new Promise((resolve) => setImmediate(resolve));
  const newestPlay = player.playItem(item('video-newest', 'video', 'video'));
  await newestPlay;
  assertPlaying(elements, true);
  resolveOldPlay();
  await oldPlay;
  elements['audio-el'].emit('playing');
  elements['audio-el'].emit('pause');
  assertPlaying(elements, true);
  elements['audio-el'].play = normalAudioPlay;

  // A newer selection aborts an actual lazy adapter request, not merely a
  // pending HTMLMediaElement.play() promise, and the old item cannot publish.
  const lazyItem = {
    ...item('player-slow', 'video', 'video'),
    id: 'media-ccc:player-slow',
    source: 'media-ccc',
    stream_url: '',
    delivery: 'on-demand',
    download_url: '',
    download_name: '',
    capture_headers: {},
    _extra: { guid: 'player-slow', needsResolve: true, downloadResolved: false },
  };
  const lazyPlay = player.playItem(lazyItem);
  await lazyResolutionStarted;
  assert.equal(lazyResolutionSignal?.aborted, false);
  const afterLazy = item('after-lazy', 'video', 'video');
  await player.playItem(afterLazy);
  assert.equal(lazyResolutionSignal?.aborted, true);
  await lazyPlay;
  assert.equal(player.getCurrentItem().id, afterLazy.id);
  assertPlaying(elements, true);

  // Media Session delegates to the same player methods.
  assert.deepEqual([...mediaActions.keys()].sort(), ['pause', 'play', 'stop']);
  mediaActions.get('pause')();
  assertPlaying(elements, false);
  await mediaActions.get('play')();
  await new Promise((resolve) => setImmediate(resolve));
  assertPlaying(elements, true);

  // Relay failure must fail closed; no provider URL may be attached directly.
  relayUnavailable = true;
  await player.playItem(item('relay-unavailable', 'audio', 'audio'));
  assert.equal(elements['audio-el'].src, '');
  assert.equal(elements['video-el'].src, '');
  assert.match(elements['player-source'].textContent, /Secure media relay unavailable/);
  assertPlaying(elements, false);
  relayUnavailable = false;

  // Selecting an unplayable item releases the previous source completely.
  await player.playItem({
    ...item('missing-source', 'audio', 'audio'),
    stream_url: '',
  });
  assertPlaying(elements, false);
  assert.equal(elements['audio-el'].paused, true);
  assert.equal(elements['video-el'].paused, true);
  assert.equal(elements['player-play'].hidden, true);
  assert.equal(elements['player-next-broken'].hidden, false);

  player.stop();
  assertPlaying(elements, false);
  assert.equal(mediaPriorities.at(-1), false);
  assert.equal(elements['player-bar'].hidden, true);
  assert.equal(elements['player-seek'].disabled, true);
  assert.equal(elements['player-time'].textContent, '--:--');
  assert.equal(player.getCurrentItem(), null);
  assert.equal(player.getCurrentMediaAction(), 'unavailable');
  assert.equal(mediaSession.playbackState, 'none');
  elements['audio-el'].emit('playing');
  elements['video-el'].emit('playing');
  assertPlaying(elements, false);
});

test.after(() => {
  globalThis.document = originalDocument;
  globalThis.window = originalWindow;
  globalThis.fetch = originalFetch;
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else delete globalThis.navigator;
});

function apiResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function item(id, type, streamKind) {
  return {
    id: `test:${id}`,
    title: id,
    source: 'internet-archive',
    type,
    stream_kind: streamKind,
    stream_url: `https://media.example/${id}.${streamKind === 'video' ? 'mp4' : 'mp3'}`,
    thumbnail: '',
    country: '',
    language: '',
  };
}

function assertPlaying(elements, expected) {
  assert.equal(getState().isPlaying, expected);
  assert.equal(elements['icon-play'].hidden, expected);
  assert.equal(elements['icon-pause'].hidden, !expected);
  assert.equal(elements['icon-play'].hasAttribute('hidden'), expected);
  assert.equal(elements['icon-pause'].hasAttribute('hidden'), !expected);
  assert.equal(elements['player-play'].getAttribute('aria-label'), expected ? 'Pause' : 'Play');
  assert.equal(elements['player-play'].title, expected ? 'Pause' : 'Play');
  assert.equal(elements['player-play'].getAttribute('aria-pressed'), expected ? 'true' : 'false');
}
