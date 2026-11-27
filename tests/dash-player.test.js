import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoQuality, observePictureSize } from '../src/lib/video-quality.js';

import {
  createDashPlayback,
  loadDashLibrary,
  resetDashLibraryForTests,
} from '../src/lib/dash-player.js';

function fakeLibrary({ supported = true, initializeError = null } = {}) {
  const calls = [];
  const handlers = new Map();
  const player = {
    updateSettings(settings) { calls.push(['settings', settings]); },
    on(name, handler) { handlers.set(name, handler); calls.push(['on', name]); },
    off(name, handler) { calls.push(['off', name, handlers.get(name) === handler]); handlers.delete(name); },
    initialize(video, url, autoplay) {
      calls.push(['initialize', video, url, autoplay]);
      if (initializeError) throw initializeError;
    },
    destroy() { calls.push(['destroy']); },
  };
  function MediaPlayer() { return { create: () => player }; }
  MediaPlayer.events = { ERROR: 'dashError', QUALITY_CHANGE_RENDERED: 'rendered' };
  return {
    library: {
      MediaPlayer,
      Debug: { LOG_LEVEL_WARNING: 3 },
      supportsMediaSource: () => supported,
    },
    player,
    calls,
    handlers,
  };
}

test('DASH playback requires the opaque relay and owns one destroyable dash.js instance', async () => {
  const fixture = fakeLibrary();
  const video = {};
  const errors = [];
  const session = await createDashPlayback(video, '/api/v1/media/root-token-1234567890123456789012', {
    library: fixture.library,
    onError: (error) => errors.push(error),
  });
  const initialized = fixture.calls.find((call) => call[0] === 'initialize');
  assert.deepEqual(initialized, [
    'initialize', video, '/api/v1/media/root-token-1234567890123456789012', false,
  ]);
  const rendered = fixture.handlers.get('rendered');
  assert.equal(session.videoRepresentation(), null);
  const videoQuality = { codecs: 'avc1.4d401f', frameRate: '30' };
  rendered({ mediaType: 'video', newRepresentation: videoQuality });
  assert.equal(session.videoRepresentation(), videoQuality);
  rendered({ mediaType: 'audio', newRepresentation: { codecs: 'mp4a.40.2' } });
  assert.equal(session.videoRepresentation(), videoQuality);
  fixture.handlers.get('dashError')({ error: { code: 27, message: 'segment failed' } });
  assert.deepEqual(errors, [{ code: 27, message: 'segment failed' }]);
  session.destroy();
  session.destroy();
  assert.equal(fixture.calls.filter((call) => call[0] === 'destroy').length, 1);
  assert.deepEqual(fixture.calls.filter(([action]) => action === 'off'), [
    ['off', 'dashError', true], ['off', 'rendered', true],
  ]);
  assert.equal(session.videoRepresentation(), null);

  await assert.rejects(
    createDashPlayback(video, 'https://upstream.example/manifest.mpd', { library: fixture.library }),
    /DASH_RELAY_REQUIRED/,
  );
});

test('DASH startup fails closed for missing MSE and destroys partial initialization', async () => {
  const unsupported = fakeLibrary({ supported: false });
  await assert.rejects(
    createDashPlayback({}, '/api/v1/media/root-token-1234567890123456789012', {
      library: unsupported.library,
    }),
    /DASH_MSE_UNAVAILABLE/,
  );
  assert.equal(unsupported.calls.length, 0);

  const broken = fakeLibrary({ initializeError: new Error('initialize failed') });
  await assert.rejects(
    createDashPlayback({}, '/api/v1/media/root-token-1234567890123456789012', {
      library: broken.library,
    }),
    /initialize failed/,
  );
  assert.equal(broken.calls.filter((call) => call[0] === 'destroy').length, 1);
  assert.equal(broken.handlers.size, 0);
});

test('DASH library loading is lazy, shared, and retries after a failed import', async () => {
  resetDashLibraryForTests();
  const previousWindow = globalThis.window;
  globalThis.window = {};
  const fixture = fakeLibrary();
  let imports = 0;
  const importer = async () => { imports++; return fixture.library; };
  const [first, second] = await Promise.all([
    loadDashLibrary({ importer }), loadDashLibrary({ importer }),
  ]);
  assert.equal(first, fixture.library);
  assert.equal(second, fixture.library);
  assert.equal(imports, 1);
  assert.equal(globalThis.window.dashjs.skipAutoCreate, true);

  resetDashLibraryForTests();
  await assert.rejects(loadDashLibrary({ importer: async () => { throw new Error('load failed'); } }));
  assert.equal(await loadDashLibrary({ importer }), fixture.library);
  globalThis.window = previousWindow;
});

test('DASH updates its cap and requests a throughput-safe representation on fullscreen', async () => {
  const fixture = fakeLibrary();
  const { player, calls, handlers } = fixture;
  const levels = [
    { id: 'sd', width: 640, height: 360, bandwidth: 600_000 },
    { id: 'hd', width: 1280, height: 720, bandwidth: 2_800_000 },
    { id: 'full', width: 1920, height: 1080, bandwidth: 6_220_000 },
  ];
  fixture.library.MediaPlayer.events.STREAM_INITIALIZED = 'ready';
  player.getRepresentationsByTypeUnfiltered = () => levels;
  let current = levels[0];
  player.getCurrentRepresentationForType = () => current;
  player.getSafeAverageThroughput = () => 3_000;
  player.setRepresentationForTypeById = (...args) => calls.push(['representation', ...args]);
  let width = 480;
  const video = { getBoundingClientRect: () => ({ width, height: width * 9 / 16 }) };
  const quality = createVideoQuality(video, () => {});
  const page = new EventTarget();
  const stop = observePictureSize(video, quality.sync, { page });
  const errors = [];
  const session = await createDashPlayback(video, '/api/v1/media/sample', {
    library: fixture.library, quality, onError: (...args) => errors.push(args),
  });
  const lastAbr = () => calls.findLast(([op, settings]) => op === 'settings' && settings.streaming)[1].streaming.abr;
  handlers.get('ready')();
  assert.equal(lastAbr().maxBitrate.video, 600);
  width = 1650;
  page.dispatchEvent(new Event('fullscreenchange'));
  assert.equal(lastAbr().maxBitrate.video, -1);
  assert.equal(lastAbr().autoSwitchBitrate.video, true);
  assert.deepEqual(calls.at(-1), ['representation', 'video', 'hd', true]);
  current = levels[1];

  width = 480;
  page.dispatchEvent(new Event('fullscreenchange'));
  assert.equal(lastAbr().maxBitrate.video, 600);
  assert.deepEqual(calls.at(-1), ['representation', 'video', 'sd', true]);
  quality.setPreference('best');
  assert.equal(lastAbr().maxBitrate.video, -1);
  const fixed = { height: 1080 };
  quality.setPreference(fixed, null, true);
  assert.equal(lastAbr().autoSwitchBitrate.video, false);
  assert.deepEqual(calls.at(-1), ['representation', 'video', 'full', true]);
  handlers.get('rendered')({ mediaType: 'video', newRepresentation: levels[2] });
  assert.equal(quality.view(fixed).now, 1080);
  handlers.get('dashError')({ error: { code: 27 } });
  handlers.get('dashError')({ error: { code: 27 } });
  assert.deepEqual(errors, [[null, { retryInAuto: true }]]);
  assert.equal(lastAbr().autoSwitchBitrate.video, true);
  assert.equal(lastAbr().maxBitrate.video, 600);
  assert.equal(quality.view(fixed).fellBack, true);
  session.destroy();
  stop();
  assert.equal(handlers.size, 0);
});
