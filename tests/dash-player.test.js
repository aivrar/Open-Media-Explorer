import test from 'node:test';
import assert from 'node:assert/strict';

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
  MediaPlayer.events = { ERROR: 'dashError' };
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
  fixture.handlers.get('dashError')({ error: { code: 27, message: 'segment failed' } });
  assert.deepEqual(errors, [{ code: 27, message: 'segment failed' }]);
  session.destroy();
  session.destroy();
  assert.equal(fixture.calls.filter((call) => call[0] === 'destroy').length, 1);
  assert.deepEqual(fixture.calls.find((call) => call[0] === 'off'), ['off', 'dashError', true]);

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
